import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

// Every message schema this service owns must compile, and every example in
// events/examples must validate against the schema with the same base name.
const schemasDir = join(__dirname, "..", "events", "schemas");
const examplesDir = join(__dirname, "..", "events", "examples");

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
addFormats(ajv);
ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);

const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"));
schemaFiles.forEach((f) => ajv.addSchema(read(schemasDir, f)));
const messageSchemas = schemaFiles.filter((f) => !f.startsWith("envelope."));

describe("event and command schemas", () => {
  it.each(messageSchemas)("%s has a valid example", (file) => {
    const validate = ajv.getSchema(read(schemasDir, file).$id)!;
    const example = read(examplesDir, file.replace(".schema.json", ".json"));
    validate(example);
    expect(validate.errors ?? []).toEqual([]);
  });

  it.each(messageSchemas)("%s rejects an envelope without a messageId", (file) => {
    const validate = ajv.getSchema(read(schemasDir, file).$id)!;
    const example = read(examplesDir, file.replace(".schema.json", ".json"));
    delete example.messageId;
    expect(validate(example)).toBe(false);
  });

  it("commands without an idempotencyKey are rejected", () => {
    const file = "inventory-reservation-requested.v1.schema.json";
    const validate = ajv.getSchema(read(schemasDir, file).$id)!;
    const example = { ...read(examplesDir, file.replace(".schema.json", ".json")), idempotencyKey: null };
    expect(validate(example)).toBe(false);
  });
});
