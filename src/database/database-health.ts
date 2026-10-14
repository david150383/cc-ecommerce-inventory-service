import { Injectable, type OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { ReadinessService } from "../health/readiness.service";

/** Adds "database" to /health/ready: not ready when PostgreSQL is unreachable. */
@Injectable()
export class DatabaseHealth implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly readiness: ReadinessService,
  ) {}

  onModuleInit(): void {
    this.readiness.register({ name: "database", check: async () => void (await this.db.query("SELECT 1")) });
  }
}
