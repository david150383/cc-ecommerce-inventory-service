import { DataSource } from "typeorm";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { ReadinessService } from "../src/health/readiness.service";
import { buildApp } from "./helpers";

describe("Inventory Service HTTP foundation", () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /health/live returns 200", async () => {
    const res = await request(app.getHttpServer()).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /health/ready checks the database", async () => {
    const res = await request(app.getHttpServer()).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { "accepting-traffic": "ok", database: "ok", schema: "ok" } });
  });

  it("GET /health/ready is 503 while a migration shipped in the image is not applied", async () => {
    const db = app.get(DataSource);
    const [last] = (await db.query(`SELECT id, timestamp, name FROM migrations ORDER BY id DESC LIMIT 1`)) as { id: number; timestamp: string; name: string }[];
    await db.query(`DELETE FROM migrations WHERE id = $1`, [last!.id]);
    try {
      const fresh = await buildApp();
      const res = await request(fresh.getHttpServer()).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.checks).toMatchObject({ database: "ok", schema: "failed" });
      await fresh.close();
    } finally {
      await db.query(`INSERT INTO migrations (id, timestamp, name) VALUES ($1, $2, $3)`, [last!.id, last!.timestamp, last!.name]);
    }
  });

  it("GET /health/ready returns 503 when a registered check fails", async () => {
    app.get(ReadinessService).register({ name: "broker", check: () => Promise.reject(new Error("down")) });
    const res = await request(app.getHttpServer()).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.broker).toBe("failed");
  });

  it("propagates a valid correlation ID and generates a request ID", async () => {
    const res = await request(app.getHttpServer()).get("/health/live").set("X-Correlation-Id", "test-correlation-123");
    expect(res.headers["x-correlation-id"]).toBe("test-correlation-123");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns RFC 9457 problem+json for unknown routes", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/nothing-here");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: "NOT_FOUND", instance: "/api/v1/nothing-here" });
    expect(res.body.correlationId).toBe(res.headers["x-correlation-id"]);
  });

  it("returns 400 MALFORMED_JSON for broken bodies without leaking internals", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/inventory/reservations")
      .set("Content-Type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MALFORMED_JSON");
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|at JSON\.parse/);
  });

  it("returns 413 PAYLOAD_TOO_LARGE for oversized bodies", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/inventory/reservations")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("serves the generated OpenAPI document with the inventory routes", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/api/v1/inventory/reservations", "/api/v1/inventory/{sku}", "/api/v1/inventory/low-stock"]),
    );
  });

  it("sets security headers", async () => {
    const res = await request(app.getHttpServer()).get("/health/live");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
