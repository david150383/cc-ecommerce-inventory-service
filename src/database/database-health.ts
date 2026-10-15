import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { ReadinessService } from "../health/readiness.service";

/**
 * Adds to /health/ready:
 * - "database": not ready when PostgreSQL is unreachable;
 * - "schema": not ready while migrations shipped in this image are not applied (e.g. the migrate job
 *   was skipped). Without it the service runs, and fails only when it first writes a new value.
 */
@Injectable()
export class DatabaseHealth implements OnModuleInit {
  private readonly logger = new Logger(DatabaseHealth.name);
  /** Applied migrations never un-apply while this process runs: once current, stop asking. */
  private schemaCurrent = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly readiness: ReadinessService,
  ) {}

  onModuleInit(): void {
    this.readiness.register({ name: "database", check: async () => void (await this.db.query("SELECT 1")) });
    this.readiness.register({ name: "schema", check: () => this.checkSchema() });
  }

  private async checkSchema(): Promise<void> {
    if (this.schemaCurrent) return;
    const applied = new Set(((await this.db.query(`SELECT name FROM migrations`)) as { name: string }[]).map((r) => r.name));
    const pending = this.db.migrations.map((m) => m.name ?? m.constructor.name).filter((n) => !applied.has(n));
    if (pending.length > 0) {
      this.logger.warn({ pending }, "database schema is behind this image: run the migrate job");
      throw new Error(`pending migrations: ${pending.join(", ")}`);
    }
    this.schemaCurrent = true;
  }
}
