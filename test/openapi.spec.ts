import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { buildOpenApiDocument } from "../src/configure-app";
import { buildApp } from "./helpers";

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
