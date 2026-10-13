import { loadEnv } from "../src/config/env";

describe("loadEnv", () => {
  it("applies defaults", () => {
    expect(loadEnv({}).PORT).toBe(4003);
  });

  it("rejects invalid configuration", () => {
    expect(() => loadEnv({ LOG_LEVEL: "loud" })).toThrow(/Invalid environment configuration/);
  });
});
