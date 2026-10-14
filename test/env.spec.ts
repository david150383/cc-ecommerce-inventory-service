import { loadEnv } from "../src/config/env";

const required = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(required);
    expect(env.PORT).toBe(4003);
    expect(env.RESERVATION_DEFAULT_TTL_SECONDS).toBe(2700);
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects invalid configuration", () => {
    expect(() => loadEnv({ ...required, LOG_LEVEL: "loud" })).toThrow(/Invalid environment configuration/);
  });
});
