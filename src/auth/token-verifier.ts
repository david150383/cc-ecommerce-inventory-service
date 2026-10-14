import { Inject, Injectable } from "@nestjs/common";
import { createLocalJWKSet, createRemoteJWKSet, errors, type JSONWebKeySet, jwtVerify } from "jose";
import { ProblemException } from "../common/problem.exception";
import { ENV, type Env } from "../config/env";
import type { Principal } from "./principal";

type KeySet = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

export const JWKS_OVERRIDE = Symbol("JWKS_OVERRIDE");

/**
 * Verifies access tokens from ecommerce-auth-service locally with its public keys.
 * The remote key set is cached (10 min) and refetched on an unknown kid (key rotation).
 */
@Injectable()
export class TokenVerifier {
  private readonly keys: KeySet;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JWKS_OVERRIDE) jwksOverride: JSONWebKeySet | null,
  ) {
    this.keys = jwksOverride
      ? createLocalJWKSet(jwksOverride)
      : createRemoteJWKSet(new URL(env.JWKS_URL), { cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000 });
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        algorithms: ["RS256"], // never trust the token's own "alg" header
        clockTolerance: 30,
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (!Array.isArray(payload.roles)) throw new Error("missing roles claim");
      return { subject: payload.sub!, roles: new Set(payload.roles.map(String)) };
    } catch (err) {
      if (err instanceof errors.JWKSTimeout || (err instanceof Error && /fetch failed|ECONNREFUSED/.test(err.message))) {
        // Auth is unreachable and the key is not cached: our dependency's problem, not the client's.
        throw new ProblemException(503, "DEPENDENCY_UNAVAILABLE", "Token keys unavailable");
      }
      throw new ProblemException(401, "UNAUTHENTICATED", "Invalid or expired access token");
    }
  }
}
