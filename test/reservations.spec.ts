import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { ReservationService } from "../src/inventory/reservation.service";
import { bearer, buildApp, newId, resetDatabase, seedStock, stockOf } from "./helpers";

let app: INestApplication;
let svc: Record<string, string>;
let admin: Record<string, string>;

beforeAll(async () => {
  app = await buildApp();
  svc = await bearer("service");
  admin = await bearer("admin");
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase(app);
});

const reserve = (body: object, key = newId()) =>
  request(app.getHttpServer()).post("/api/v1/inventory/reservations").set(svc).set("Idempotency-Key", key).send(body);
const confirm = (id: string) => request(app.getHttpServer()).post(`/api/v1/inventory/reservations/${id}/confirm`).set(svc);
const release = (id: string) => request(app.getHttpServer()).post(`/api/v1/inventory/reservations/${id}/release`).set(svc);

describe("reserve", () => {
  it("reserves all lines atomically and records movements and an event", async () => {
    await seedStock(app, "TEE-BLK-M", 10);
    await seedStock(app, "TEE-BLK-L", 4);
    const orderId = newId();
    const res = await reserve({ orderId, lines: [{ sku: "TEE-BLK-M", quantity: 2 }, { sku: "TEE-BLK-L", quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/inventory/reservations/${res.body.reservation.id}`);
    expect(res.body.reservation).toMatchObject({
      orderId,
      status: "ACTIVE",
      lines: [{ sku: "TEE-BLK-L", quantity: 1 }, { sku: "TEE-BLK-M", quantity: 2 }],
    });
    expect(await stockOf(app, "TEE-BLK-M")).toEqual({ on_hand: 10, reserved: 2 });
    const db = app.get(DataSource);
    expect(await db.query(`SELECT reason, delta_reserved FROM stock_movements ORDER BY sku`)).toEqual([
      { reason: "RESERVED", delta_reserved: 1 },
      { reason: "RESERVED", delta_reserved: 2 },
    ]);
    expect((await db.query(`SELECT message_type FROM outbox`)).map((r: { message_type: string }) => r.message_type)).toEqual([
      "InventoryReserved",
    ]);
  });

  it("is all-or-nothing: one short line means nothing is held", async () => {
    await seedStock(app, "TEE-BLK-M", 10);
    await seedStock(app, "TEE-BLK-L", 1);
    const res = await reserve({ orderId: newId(), lines: [{ sku: "TEE-BLK-M", quantity: 2 }, { sku: "TEE-BLK-L", quantity: 3 }] });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "INSUFFICIENT_STOCK",
      unavailableLines: [{ sku: "TEE-BLK-L", requested: 3, available: 1 }],
    });
    expect(await stockOf(app, "TEE-BLK-M")).toEqual({ on_hand: 10, reserved: 0 }); // the M line was rolled back
    expect(await app.get(DataSource).query(`SELECT count(*)::int AS n FROM stock_movements`)).toEqual([{ n: 0 }]);
  });

  it("reports unknown SKUs as unavailable", async () => {
    const res = await reserve({ orderId: newId(), lines: [{ sku: "NO-SUCH-SKU", quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.unavailableLines).toEqual([{ sku: "NO-SUCH-SKU", requested: 1, available: 0 }]);
  });

  it("validates input and requires an Idempotency-Key", async () => {
    const noKey = await request(app.getHttpServer())
      .post("/api/v1/inventory/reservations")
      .set(svc)
      .send({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 1 }] });
    expect(noKey.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const bad = await reserve({ orderId: "not-a-uuid", lines: [{ sku: "bad sku", quantity: 0 }], extra: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(
      ["extra", "lines.0.quantity", "lines.0.sku", "orderId"].sort(),
    );
  });
});

describe("idempotency", () => {
  it("replays the original success for the same key and body", async () => {
    await seedStock(app, "TEE-1", 5);
    const body = { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 2 }] };
    const key = newId();
    const first = await reserve(body, key);
    const again = await reserve(body, key);

    expect(again.status).toBe(200);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.body.reservation.id).toBe(first.body.reservation.id);
    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 5, reserved: 2 }); // not 4
  });

  it("replays the original FAILURE too, even if stock has arrived since", async () => {
    await seedStock(app, "TEE-1", 1);
    const body = { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 2 }] };
    const key = newId();
    expect((await reserve(body, key)).status).toBe(409);
    await app.get(DataSource).query(`UPDATE stock_items SET on_hand = 100`);
    const retry = await reserve(body, key);
    expect(retry.status).toBe(409);
    expect(retry.body.replayed).toBe(true);
  });

  it("rejects a key reused for a different request", async () => {
    await seedStock(app, "TEE-1", 5);
    const key = newId();
    await reserve({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 1 }] }, key);
    const res = await reserve({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 1 }] }, key);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("concurrent duplicates with the same key create exactly one reservation", async () => {
    await seedStock(app, "TEE-1", 50);
    const body = { orderId: newId(), lines: [{ sku: "TEE-1", quantity: 3 }] };
    const key = newId();
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(body, key)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(9);
    expect(new Set(results.map((r) => r.body.reservation.id)).size).toBe(1);
    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 50, reserved: 3 });
  });

  it("an order can hold only one live reservation", async () => {
    await seedStock(app, "TEE-1", 5);
    const orderId = newId();
    await reserve({ orderId, lines: [{ sku: "TEE-1", quantity: 1 }] });
    const second = await reserve({ orderId, lines: [{ sku: "TEE-1", quantity: 1 }] });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("ORDER_ALREADY_RESERVED");
  });
});

describe("no overselling under concurrency", () => {
  it("40 concurrent buyers of a SKU with 7 units: exactly 7 succeed", async () => {
    await seedStock(app, "HOT-ITEM", 7);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => reserve({ orderId: newId(), lines: [{ sku: "HOT-ITEM", quantity: 1 }] })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(7);
    expect(results.filter((r) => r.status === 409)).toHaveLength(33);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await stockOf(app, "HOT-ITEM")).toEqual({ on_hand: 7, reserved: 7 });
  });

  it("multi-line orders over the same SKUs in opposite orders neither oversell nor deadlock", async () => {
    await seedStock(app, "SKU-A", 10);
    await seedStock(app, "SKU-B", 10);
    const orders = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? [{ sku: "SKU-A", quantity: 1 }, { sku: "SKU-B", quantity: 1 }]
        : [{ sku: "SKU-B", quantity: 1 }, { sku: "SKU-A", quantity: 1 }],
    );
    const results = await Promise.all(orders.map((lines) => reserve({ orderId: newId(), lines })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true); // no 500 = no deadlock
    expect(await stockOf(app, "SKU-A")).toEqual({ on_hand: 10, reserved: 10 });
    expect(await stockOf(app, "SKU-B")).toEqual({ on_hand: 10, reserved: 10 });
  });

  it("the database refuses reserved > on_hand even if application code tried", async () => {
    await seedStock(app, "TEE-1", 1);
    await expect(app.get(DataSource).query(`UPDATE stock_items SET reserved = 2 WHERE sku = 'TEE-1'`)).rejects.toThrow(
      /ck_stock_items_reserved_within_on_hand/,
    );
  });
});

describe("confirm and release", () => {
  async function activeReservation(sku = "TEE-1", qty = 2) {
    await seedStock(app, sku, 10);
    return (await reserve({ orderId: newId(), lines: [{ sku, quantity: qty }] })).body.reservation.id as string;
  }

  it("confirm deducts on_hand and reserved, and is idempotent", async () => {
    const id = await activeReservation();
    for (let i = 0; i < 2; i++) {
      const res = await confirm(id);
      expect(res.status).toBe(200);
      expect(res.body.reservation.status).toBe("CONFIRMED");
    }
    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 8, reserved: 0 });
  });

  it("release returns stock to available, and is idempotent", async () => {
    const id = await activeReservation();
    for (let i = 0; i < 2; i++) expect((await release(id)).body.reservation.status).toBe("RELEASED");
    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 10, reserved: 0 });
  });

  it("a confirmed reservation cannot be released, and a released one cannot be confirmed", async () => {
    const a = await activeReservation("SKU-A");
    await confirm(a);
    expect((await release(a)).body.code).toBe("RESERVATION_CONFIRMED");
    const b = await activeReservation("SKU-B");
    await release(b);
    expect((await confirm(b)).body.code).toBe("RESERVATION_RELEASED");
  });

  it("confirm racing release: exactly one wins and stock stays consistent", async () => {
    for (let i = 0; i < 10; i++) {
      await resetDatabase(app);
      const id = await activeReservation("RACE-1", 3);
      const [c, r] = await Promise.all([confirm(id), release(id)]);
      const stock = await stockOf(app, "RACE-1");
      expect(stock.reserved).toBe(0);
      if (c.status === 200) {
        expect(r.status).toBe(409);
        expect(stock.on_hand).toBe(7);
      } else {
        expect(r.status).toBe(200);
        expect(stock.on_hand).toBe(10);
      }
    }
  });

  it("only services may confirm; admins may release", async () => {
    const id = await activeReservation();
    expect((await request(app.getHttpServer()).post(`/api/v1/inventory/reservations/${id}/confirm`).set(admin)).status).toBe(403);
    expect((await request(app.getHttpServer()).post(`/api/v1/inventory/reservations/${id}/release`).set(admin)).status).toBe(200);
  });

  it("GET returns the reservation; unknown ids are 404", async () => {
    const id = await activeReservation();
    expect((await request(app.getHttpServer()).get(`/api/v1/inventory/reservations/${id}`).set(svc)).body.reservation.id).toBe(id);
    expect((await request(app.getHttpServer()).get(`/api/v1/inventory/reservations/${newId()}`).set(svc)).status).toBe(404);
  });
});

describe("expiry", () => {
  it("the sweeper releases expired reservations exactly once", async () => {
    await seedStock(app, "TEE-1", 10);
    const id = (await reserve({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 4 }] })).body.reservation.id;
    await app.get(DataSource).query(`UPDATE reservations SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour'`);

    const svcInstance = app.get(ReservationService);
    const [a, b] = await Promise.all([svcInstance.expireDue(), svcInstance.expireDue()]); // two "instances"
    expect(a + b).toBe(1);
    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 10, reserved: 0 });
    const res = await request(app.getHttpServer()).get(`/api/v1/inventory/reservations/${id}`).set(svc);
    expect(res.body.reservation).toMatchObject({ status: "EXPIRED", releaseReason: "EXPIRED" });
  });

  it("confirming after expiry fails and returns the stock", async () => {
    await seedStock(app, "TEE-1", 10);
    const id = (await reserve({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 4 }] })).body.reservation.id;
    await app.get(DataSource).query(`UPDATE reservations SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour'`);
    const res = await confirm(id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RESERVATION_EXPIRED");
    expect(await stockOf(app, "TEE-1")).toEqual({ on_hand: 10, reserved: 0 });
  });
});
