import "reflect-metadata";
import { join } from "node:path";
import { DataSource, type DataSourceOptions } from "typeorm";
import { ENTITIES } from "./entities";

/**
 * Shared by the app (via TypeOrmModule) and the TypeORM CLI (migration:generate/run).
 * synchronize is ALWAYS false: the schema changes only through reviewed migrations.
 */
export function dataSourceOptions(url: string, poolSize = 10): DataSourceOptions {
  return {
    type: "postgres",
    url,
    entities: ENTITIES,
    // Works for .ts (CLI via ts-node, tests) and compiled .js (container migrate job).
    migrations: [join(__dirname, "migrations", "*.{ts,js}")],
    synchronize: false,
    migrationsTransactionMode: "each",
    extra: { max: poolSize },
  };
}

// Default export for the TypeORM CLI: `typeorm -d dist/database/data-source.js migration:run`.
export default new DataSource(
  dataSourceOptions(process.env.DATABASE_URL ?? "postgresql://inventory_svc:inventory_local_pw@localhost:5432/inventory_db"),
);
