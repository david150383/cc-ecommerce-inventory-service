import { type DynamicModule, Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { JSONWebKeySet } from "jose";
import { AuthGuard } from "./auth.guard";
import { JWKS_OVERRIDE, TokenVerifier } from "./token-verifier";

@Global()
@Module({})
export class AuthModule {
  /** `jwks` replaces the remote key set (tests). */
  static forRoot(jwks: JSONWebKeySet | null = null): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        { provide: JWKS_OVERRIDE, useValue: jwks },
        TokenVerifier,
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [TokenVerifier],
    };
  }
}
