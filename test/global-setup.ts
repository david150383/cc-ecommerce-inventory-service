import { Client } from "pg";
import { DataSource } from "typeorm";
import { dataSourceOptions } from "../src/database/data-source";

// Recreates an empty test database and applies the real migrations, so integration
// tests run against exactly the schema production gets.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://inventory_svc:inventory_local_pw@localhost:5432/inventory_test";

export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      "Cannot reach PostgreSQL for integration tests. Start it with `docker compose up -d` here or in " +
        `ecommerce-infrastructure, or set TEST_DATABASE_URL. (${(err as Error).message})`,
      { cause: err },
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const ds = new DataSource(dataSourceOptions(TEST_DATABASE_URL, 2));
  await ds.initialize();
  await ds.runMigrations();
  await ds.destroy();
}
