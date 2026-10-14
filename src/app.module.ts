import { type DynamicModule, Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import type { JSONWebKeySet } from "jose";
import { LoggerModule } from "nestjs-pino";
import { AuthModule } from "./auth/auth.module";
import { loggerOptions } from "./common/logger.options";
import { ENV, type Env } from "./config/env";
import { dataSourceOptions } from "./database/data-source";
import { HealthModule } from "./health/health.module";
import { InventoryModule } from "./inventory/inventory.module";
import { MessagingModule } from "./messaging/messaging.module";

@Global()
@Module({})
class EnvModule {
  static forRoot(env: Env): DynamicModule {
    return { module: EnvModule, providers: [{ provide: ENV, useValue: env }], exports: [ENV] };
  }
}

export interface AppModuleOptions {
  /** Tests inject a static key set instead of fetching Auth's JWKS. */
  jwks?: JSONWebKeySet;
}

@Module({})
export class AppModule {
  // Built from validated Env so tests can construct it with their own config.
  static forRoot(env: Env, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        LoggerModule.forRoot(loggerOptions(env.LOG_LEVEL)),
        TypeOrmModule.forRoot(dataSourceOptions(env.DATABASE_URL, env.DB_POOL_SIZE)),
        AuthModule.forRoot(options.jwks ?? null),
        HealthModule,
        InventoryModule,
        MessagingModule,
      ],
    };
  }
}
