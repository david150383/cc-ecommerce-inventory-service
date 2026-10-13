import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/config/env";
import { configureApp } from "../src/configure-app";
import { ReadinessService } from "../src/health/readiness.service";

async function buildApp(): Promise<INestApplication> {
  const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  const app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
  configureApp(app, env);
  await app.init();
  return app;
}

describe("Inventory Service HTTP skeleton", () => {
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

  it("GET /health/ready returns 200 when checks pass", async () => {
    const res = await request(app.getHttpServer()).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { "accepting-traffic": "ok" } });
  });

  it("GET /health/ready returns 503 when a registered check fails", async () => {
    app.get(ReadinessService).register({ name: "database", check: () => Promise.reject(new Error("down")) });
    const res = await request(app.getHttpServer()).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ "accepting-traffic": "ok", database: "failed" });
  });

  it("propagates a valid correlation ID and generates a request ID", async () => {
    const res = await request(app.getHttpServer()).get("/health/live").set("X-Correlation-Id", "test-correlation-123");
    expect(res.headers["x-correlation-id"]).toBe("test-correlation-123");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns RFC 9457 problem+json for unknown routes", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/inventory/does-not-exist-yet");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: "NOT_FOUND", instance: "/api/v1/inventory/does-not-exist-yet" });
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

  it("serves the generated OpenAPI document", async () => {
    const res = await request(app.getHttpServer()).get("/docs-json");
    expect(res.status).toBe(200);
    expect(res.body.info.title).toBe("Inventory Service");
  });

  it("sets security headers", async () => {
    const res = await request(app.getHttpServer()).get("/health/live");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
