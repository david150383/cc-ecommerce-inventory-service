import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";
import { buildOpenApiDocument } from "../src/configure-app";
import { bearer, buildApp, newId, resetDatabase, seedStock } from "./helpers";

const FILE = join(__dirname, "..", "openapi", "openapi.json");
let app: INestApplication;

beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

describe("OpenAPI", () => {
  // `npm run openapi:export` regenerates the file; ecommerce-contracts syncs it.
  it("the committed openapi/openapi.json matches the code", () => {
    const doc = JSON.parse(JSON.stringify(buildOpenApiDocument(app)));
    if (process.env.OPENAPI_WRITE === "1") {
      mkdirSync(join(FILE, ".."), { recursive: true });
      writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(doc);
  });
});

describe("real responses match the documented schemas", () => {
  type Doc = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: object }> }> }>>; components: object };
  let doc: Doc;
  let ajv: Ajv;
  beforeAll(() => {
    doc = JSON.parse(JSON.stringify(buildOpenApiDocument(app)));
    // OpenAPI 3.0 schemas: JSON Schema plus `nullable`, which Ajv understands natively.
    ajv = addFormats(new Ajv({ strict: false, allErrors: true }));
    ajv.addSchema({ $id: "openapi.json", components: doc.components });
  });
  beforeEach(() => resetDatabase(app));

  /** Validates a real response against the schema documented for that path, method and status. */
  function conforms(path: string, method: string, res: request.Response) {
    const content = doc.paths[path]?.[method]?.responses[String(res.status)]?.content;
    expect({ documented: `${method.toUpperCase()} ${path} ${res.status}`, ok: content !== undefined }).toEqual({ documented: `${method.toUpperCase()} ${path} ${res.status}`, ok: true });
    const schema = Object.values(content!)[0]!.schema;
    const validate = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"openapi.json#/components/')));
    validate(res.body);
    expect({ path, status: res.status, errors: validate.errors ?? [] }).toEqual({ path, status: res.status, errors: [] });
  }

  it("stock, availability, movements, low stock, adjustments, reservations and problems", async () => {
    const http = () => request(app.getHttpServer());
    const admin = await bearer("admin");
    const svc = await bearer("service");
    await seedStock(app, "TEE-1", 10, 9);

    conforms("/api/v1/inventory", "get", await http().get("/api/v1/inventory?limit=5").set(admin));
    conforms("/api/v1/inventory/low-stock", "get", await http().get("/api/v1/inventory/low-stock").set(admin));
    conforms("/api/v1/inventory/{sku}", "get", await http().get("/api/v1/inventory/TEE-1")); // public: availability
    conforms("/api/v1/inventory/{sku}", "get", await http().get("/api/v1/inventory/TEE-1").set(admin)); // admin: full record
    conforms("/api/v1/inventory/{sku}", "get", await http().get("/api/v1/inventory/NOPE-1"));
    conforms("/api/v1/inventory/{sku}", "patch", await http().patch("/api/v1/inventory/TEE-1").set(admin).set("Idempotency-Key", newId()).send({ delta: 2, reason: "RESTOCK", note: "test" }));
    conforms("/api/v1/inventory/{sku}", "patch", await http().patch("/api/v1/inventory/TEE-1").set(admin).set("Idempotency-Key", newId()).send({ delta: -99, reason: "DAMAGED" }));

    const created = await http().post("/api/v1/inventory/reservations").set(svc).set("Idempotency-Key", newId()).send({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 2 }] });
    conforms("/api/v1/inventory/reservations", "post", created);
    const id = created.body.reservation.id as string;
    conforms("/api/v1/inventory/reservations/{id}", "get", await http().get(`/api/v1/inventory/reservations/${id}`).set(svc));
    conforms("/api/v1/inventory/reservations/{id}/confirm", "post", await http().post(`/api/v1/inventory/reservations/${id}/confirm`).set(svc));
    conforms("/api/v1/inventory/reservations/{id}/release", "post", await http().post(`/api/v1/inventory/reservations/${id}/release`).set(svc)); // 409 confirmed
    conforms("/api/v1/inventory/reservations", "post", await http().post("/api/v1/inventory/reservations").set(svc).set("Idempotency-Key", newId()).send({ orderId: newId(), lines: [{ sku: "TEE-1", quantity: 500 }] }));
    conforms("/api/v1/inventory/{sku}/movements", "get", await http().get("/api/v1/inventory/TEE-1/movements").set(admin));
  });
});

