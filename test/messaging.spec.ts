import type { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import { MessagingRunner } from "../src/messaging/messaging.module";
import { AWS_ENDPOINT, command, createTestTopology, receiveAll, sendCommand, type TestTopology } from "./floci";
import { buildApp, newId, resetDatabase, seedStock, stockOf } from "./helpers";

let app: INestApplication;
let topo: TestTopology;
let runner: MessagingRunner;
let db: DataSource;

beforeAll(async () => {
  topo = await createTestTopology();
  // MESSAGING_ENABLED stays false: the tests drive the relay and consumer step by step.
  app = await buildApp({
    AWS_ENDPOINT_URL: AWS_ENDPOINT,
    EVENTS_TOPIC_ARN: topo.topicArn,
    COMMANDS_QUEUE_NAME: topo.commandsQueue,
    CONSUMER_WAIT_TIME_SECONDS: "1",
  });
  runner = app.get(MessagingRunner);
  db = app.get(DataSource);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase(app);
  await receiveAll(topo.probeUrl, 0); // discard leftovers
});

const outbox = async () =>
  (await db.query(`SELECT message_type, envelope, published_at FROM outbox ORDER BY created_at, id`)) as {
    message_type: string;
    envelope: { causationId: string | null; sagaId: string | null; payload: Record<string, unknown> };
    published_at: Date | null;
  }[];

/** Sends a command, lets the consumer handle it, then publishes the outbox. */
async function deliver(cmd: object | string) {
  await sendCommand(topo.commandsUrl, cmd);
  const handled = await runner.consumer.pollOnce();
  await runner.relay.publishPending();
  return handled;
}

describe("outbox relay", () => {
  it("publishes committed events to SNS with the messageType attribute, exactly once per row", async () => {
    await seedStock(app, "TEE-1", 5);
    await deliver(command("InventoryReservationRequested", { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 1 }] }));

    const received = await receiveAll(topo.probeUrl);
    expect(received.map((m) => JSON.parse(m.Body!).messageType)).toEqual(["InventoryReserved"]);
    expect(received[0]!.MessageAttributes?.messageType?.StringValue).toBe("InventoryReserved");
    expect((await outbox()).every((r) => r.published_at !== null)).toBe(true);

    expect(await runner.relay.publishPending()).toBe(0); // nothing left
  });

  it("keeps rows when SNS is unreachable, and publishes them later", async () => {
    await seedStock(app, "TEE-1", 5);
    await sendCommand(topo.commandsUrl, command("InventoryReservationRequested", { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 1 }] }));
    await runner.consumer.pollOnce();

    const { OutboxRelay } = await import("../src/messaging/outbox-relay");
    const { SNSClient } = await import("@aws-sdk/client-sns");
    const broken = new OutboxRelay(db, new SNSClient({ region: "us-east-1", endpoint: "http://127.0.0.1:1", maxAttempts: 1 }), topo.topicArn, 1000);
    expect(await broken.publishPending()).toBe(0);
    const [row] = await outbox();
    expect(row!.published_at).toBeNull();

    expect(await runner.relay.publishPending()).toBe(1);
    expect((await receiveAll(topo.probeUrl)).length).toBe(1);
  });
});

describe("command consumer", () => {
  it("InventoryReservationRequested reserves stock, deletes the message, and links the event to the command", async () => {
    await seedStock(app, "TEE-1", 5);
    const cmd = command("InventoryReservationRequested", { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 2 }] });
    expect(await deliver(cmd)).toBe(1);

    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 5, reserved: 2 });
    const [event] = await outbox();
    expect(event).toMatchObject({ message_type: "InventoryReserved", envelope: { causationId: cmd.messageId, sagaId: cmd.sagaId } });
    expect(await receiveAll(topo.commandsUrl, 2)).toHaveLength(0); // deleted
  });

  it("a redelivered (duplicate) command reserves once but answers twice", async () => {
    await seedStock(app, "TEE-1", 5);
    const cmd = command("InventoryReservationRequested", { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 2 }] });
    await deliver(cmd);
    await deliver(cmd); // SQS at-least-once: the same message again

    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 5, reserved: 2 });
    expect((await outbox()).map((r) => r.message_type)).toEqual(["InventoryReserved", "InventoryReserved"]);
    expect((await receiveAll(topo.probeUrl)).length).toBe(2);
  });

  it("insufficient stock is a business outcome: a failure EVENT, and the message is deleted", async () => {
    await seedStock(app, "TEE-1", 1);
    const orderId = newId();
    await deliver(command("InventoryReservationRequested", { orderId, lines: [{ sku: "TEE-1", quantity: 3 }] }));
    const [event] = await outbox();
    expect(event).toMatchObject({
      message_type: "InventoryReservationFailed",
      envelope: { payload: { orderId, reason: "INSUFFICIENT_STOCK", unavailableLines: [{ sku: "TEE-1", requested: 3, available: 1 }] } },
    });
    expect(await receiveAll(topo.commandsUrl, 2)).toHaveLength(0);
  });

  it("an unknown SKU fails with UNKNOWN_SKU", async () => {
    await deliver(command("InventoryReservationRequested", { orderId: newId(), lines: [{ sku: "NOPE-1", quantity: 1 }] }));
    expect((await outbox())[0]!.envelope.payload.reason).toBe("UNKNOWN_SKU");
  });

  it("confirm and release commands, including duplicates and 'nothing to release'", async () => {
    await seedStock(app, "TEE-1", 10, 0); // threshold 0: no low-stock events in this test
    const orderA = newId();
    const orderB = newId();
    await deliver(command("InventoryReservationRequested", { orderId: orderA, lines: [{ sku: "TEE-1", quantity: 2 }] }));
    await deliver(command("InventoryReservationRequested", { orderId: orderB, lines: [{ sku: "TEE-1", quantity: 3 }] }));
    const [a, b] = (await db.query(`SELECT id, order_id FROM reservations ORDER BY created_at`)) as { id: string; order_id: string }[];

    const confirmA = command("InventoryReservationConfirmRequested", { reservationId: a!.id, orderId: orderA });
    await deliver(confirmA);
    await deliver(confirmA);
    // Release by ORDER (reservationId unknown to the saga, e.g. after a timeout).
    await deliver(command("InventoryReservationReleaseRequested", { orderId: orderB, reservationId: null, reason: "PAYMENT_TIMEOUT" }));
    await deliver(command("InventoryReservationReleaseRequested", { orderId: newId(), reservationId: null, reason: "RESERVATION_TIMEOUT" }));

    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 8, reserved: 0 });
    const types = (await outbox()).map((r) => [r.message_type, r.envelope.payload.reason ?? null]);
    expect(types).toEqual([
      ["InventoryReserved", null],
      ["InventoryReserved", null],
      ["InventoryReservationConfirmed", null],
      ["InventoryReservationConfirmed", null],
      ["InventoryReservationReleased", "REQUESTED"],
      ["InventoryReservationReleased", "NOTHING_TO_RELEASE"],
    ]);
    expect(b).toBeDefined();
  });

  it("confirming an expired reservation answers with InventoryReservationFailed RESERVATION_EXPIRED", async () => {
    await seedStock(app, "TEE-1", 10);
    const orderId = newId();
    await deliver(command("InventoryReservationRequested", { orderId, lines: [{ sku: "TEE-1", quantity: 2 }] }));
    const [r] = (await db.query(`SELECT id FROM reservations`)) as { id: string }[];
    await db.query(`UPDATE reservations SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour'`);
    await deliver(command("InventoryReservationConfirmRequested", { reservationId: r!.id, orderId }));

    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 10, reserved: 0 });
    expect((await outbox()).map((e) => [e.message_type, e.envelope.payload.reason ?? null]).slice(-2)).toEqual([
      ["InventoryReservationReleased", "EXPIRED"],
      ["InventoryReservationFailed", "RESERVATION_EXPIRED"],
    ]);
  });

  it("malformed and schema-invalid commands are never deleted: they end up in the DLQ", async () => {
    await sendCommand(topo.commandsUrl, "not json at all");
    await sendCommand(topo.commandsUrl, command("InventoryReservationRequested", { orderId: newId(), lines: [] })); // minItems 1
    await sendCommand(topo.commandsUrl, { ...command("InventoryReservationRequested", { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 1 }] }), idempotencyKey: null });
    await sendCommand(topo.commandsUrl, command("DropAllTables", {}));

    // maxReceiveCount = 2, visibility timeout = 1 s: two failed receives, then SQS moves them.
    for (let i = 0; i < 3; i++) {
      expect(await runner.consumer.pollOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 1_200));
    }
    await runner.consumer.pollOnce();
    const dead = await receiveAll(topo.dlqUrl, 3);
    expect(dead).toHaveLength(4);
    expect(await db.query(`SELECT count(*)::int AS n FROM reservations`)).toEqual([{ n: 0 }]);
  });
});
