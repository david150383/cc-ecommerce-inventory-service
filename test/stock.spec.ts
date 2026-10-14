import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import request from "supertest";
import { DataSource } from "typeorm";
import { bearer, buildApp, newId, resetDatabase, seedStock, stockOf, token } from "./helpers";

let app: INestApplication;
let admin: Record<string, string>;
let svc: Record<string, string>;
let customer: Record<string, string>;

beforeAll(async () => {
  app = await buildApp();
  admin = await bearer("admin");
  svc = await bearer("service");
  customer = await bearer("customer");
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase(app);
});

const http = () => request(app.getHttpServer());
const adjust = (sku: string, body: object, key = newId(), headers = admin) =>
  http().patch(`/api/v1/inventory/${sku}`).set(headers).set("Idempotency-Key", key).send(body);

describe("stock administration", () => {
  it("restocking a new SKU creates its record and an audit row", async () => {
    const res = await adjust("NEW-SKU-1", { delta: 25, reason: "RESTOCK", note: "PO-1001" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sku: "NEW-SKU-1", onHand: 25, reserved: 0, available: 25, lowStock: false });
    const history = await http().get("/api/v1/inventory/NEW-SKU-1/movements").set(admin);
    expect(history.body.data[0]).toMatchObject({ deltaOnHand: 25, reason: "RESTOCK", note: "PO-1001" });
    expect(history.body.data[0].actor).toBeTruthy();
  });

  it("adjustments are idempotent per key: a retried restock is not counted twice", async () => {
    const key = newId();
    await adjust("TEE-1", { delta: 10, reason: "RESTOCK" }, key);
    const again = await adjust("TEE-1", { delta: 10, reason: "RESTOCK" }, key);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect((await stockOf(app, "TEE-1")).on_hand).toBe(10);
    expect((await adjust("TEE-1", { delta: 99, reason: "RESTOCK" }, key)).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("a write-off cannot take on_hand below what is reserved", async () => {
    await seedStock(app, "TEE-1", 10);
    await http().post("/api/v1/inventory/reservations").set(svc).set("Idempotency-Key", newId())
      .send({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 8 }] });
    const res = await adjust("TEE-1", { delta: -5, reason: "DAMAGED" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WOULD_UNDERCUT_RESERVATIONS");
    expect((await adjust("TEE-1", { delta: -2, reason: "DAMAGED" })).body).toMatchObject({ onHand: 8, reserved: 8, available: 0 });
  });

  it("validates adjustments", async () => {
    expect((await adjust("TEE-1", {})).status).toBe(400);
    expect((await adjust("TEE-1", { delta: 5 })).status).toBe(400); // reason required
    expect((await adjust("TEE-1", { delta: 1.5, reason: "RESTOCK" })).status).toBe(400);
    expect((await adjust("TEE-1", { delta: 5, reason: "STOLEN" })).status).toBe(400);
    expect((await adjust("NOPE", { delta: -1, reason: "CORRECTION" })).status).toBe(404);
    expect((await http().patch("/api/v1/inventory/TEE-1").set(admin).send({ delta: 1, reason: "RESTOCK" })).body.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });

  it("lists stock with cursor pagination and reports low stock", async () => {
    for (const [sku, qty] of [["SKU-A", 50], ["SKU-B", 3], ["SKU-C", 1], ["SKU-D", 40]] as const) await seedStock(app, sku, qty);
    const page1 = await http().get("/api/v1/inventory?limit=3").set(admin);
    expect(page1.body.data.map((s: { sku: string }) => s.sku)).toEqual(["SKU-A", "SKU-B", "SKU-C"]);
    const page2 = await http().get(`/api/v1/inventory?limit=3&cursor=${page1.body.page.nextCursor}`).set(admin);
    expect(page2.body).toMatchObject({ data: [{ sku: "SKU-D" }], page: { nextCursor: null } });
    const low = await http().get("/api/v1/inventory/low-stock").set(admin);
    expect(low.body.data.map((s: { sku: string }) => s.sku)).toEqual(["SKU-C", "SKU-B"]);
  });
});

describe("visibility and authorization", () => {
  it("the public sees availability only; admins see the full record", async () => {
    await seedStock(app, "TEE-1", 7);
    expect((await http().get("/api/v1/inventory/TEE-1")).body).toEqual({ sku: "TEE-1", available: 7, inStock: true });
    expect((await http().get("/api/v1/inventory/UNKNOWN-1")).body).toEqual({ sku: "UNKNOWN-1", available: 0, inStock: false });
    expect((await http().get("/api/v1/inventory/TEE-1").set(admin)).body).toMatchObject({ onHand: 7, reserved: 0 });
  });

  it.each([
    ["get", "/api/v1/inventory"],
    ["get", "/api/v1/inventory/low-stock"],
    ["patch", "/api/v1/inventory/TEE-1"],
    ["post", "/api/v1/inventory/reservations"],
  ])("%s %s requires a token (401) and the right role (403)", async (method, path) => {
    const anon = await (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(path).send({});
    expect(anon.status).toBe(401);
    expect(anon.headers["www-authenticate"]).toMatch(/^Bearer/);
    const asCustomer = await (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(path).set(customer).send({});
    expect(asCustomer.status).toBe(403);
  });

  it("rejects expired tokens and tokens minted for another service", async () => {
    const expired = await token(["admin"], { expiresIn: "-2m" });
    expect((await http().get("/api/v1/inventory").set("Authorization", `Bearer ${expired}`)).status).toBe(401);
    const other = await token(["admin"], { audience: "ecommerce-payment-service" });
    expect((await http().get("/api/v1/inventory").set("Authorization", `Bearer ${other}`)).status).toBe(401);
    expect((await http().get("/api/v1/inventory/TEE-1").set("Authorization", "Bearer garbage")).status).toBe(401);
  });
});

describe("outbox events match this service's published schemas", () => {
  const schemasDir = join(__dirname, "..", "events", "schemas");
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  addFormats(ajv);
  ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);
  for (const f of readdirSync(schemasDir)) ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, f), "utf8")));
  const schemaId = (type: string) =>
    `https://schemas.ecommerce.local/inventory-service/${type.replace(/(?<!^)([A-Z])/g, "-$1").toLowerCase()}.v1.schema.json`;

  it("every event written by a full reserve/confirm/release/expire/low-stock cycle is schema-valid", async () => {
    await seedStock(app, "TEE-1", 10, 5);
    const reserve = (qty: number) =>
      http().post("/api/v1/inventory/reservations").set(svc).set("Idempotency-Key", newId())
        .send({ orderId: newId(), sagaId: newId(), lines: [{ sku: "TEE-1", quantity: qty }] });
    const a = (await reserve(6)).body.reservation.id; // crosses the low-stock threshold
    const b = (await reserve(1)).body.reservation.id;
    await http().post(`/api/v1/inventory/reservations/${a}/confirm`).set(svc);
    await http().post(`/api/v1/inventory/reservations/${b}/release`).set(svc);

    const rows: { message_type: string; envelope: unknown }[] = await app.get(DataSource).query(
      `SELECT message_type, envelope FROM outbox ORDER BY created_at, id`,
    );
    expect(rows.map((r) => r.message_type)).toEqual([
      "InventoryReserved",
      "InventoryLowStock",
      "InventoryReserved",
      "InventoryReservationConfirmed",
      "InventoryReservationReleased",
    ]);
    for (const row of rows) {
      const validate = ajv.getSchema(schemaId(row.message_type))!;
      expect(validate).toBeDefined();
      validate(row.envelope);
      expect({ type: row.message_type, errors: validate.errors ?? [] }).toEqual({ type: row.message_type, errors: [] });
    }
  });
});
