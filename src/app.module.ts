import { type DynamicModule, Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { loggerOptions } from "./common/logger.options";
import type { Env } from "./config/env";
import { HealthModule } from "./health/health.module";

@Module({})
export class AppModule {
  // Built from validated Env so tests can construct it with their own config.
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot(loggerOptions(env.LOG_LEVEL)),
        HealthModule,
        // Phase 2: TypeOrmModule.forRootAsync(...), InventoryModule, ReservationsModule
      ],
    };
  }
}
