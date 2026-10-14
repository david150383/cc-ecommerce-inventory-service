import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ProblemException } from "../common/problem.exception";
import type { Principal, Role } from "./principal";
import { TokenVerifier } from "./token-verifier";

const ROLES_KEY = "roles";

/** Allow any of the given roles. Routes without @Roles are public. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Global guard. A *present* token is always verified (even on public routes), so a broken
 * client fails loudly instead of silently acting anonymously.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);

    const header = req.get("authorization");
    if (header) {
      const [scheme, token] = header.split(" ");
      if (scheme?.toLowerCase() !== "bearer" || !token) {
        throw new ProblemException(401, "UNAUTHENTICATED", "Authentication required");
      }
      req.principal = await this.verifier.verify(token);
    }

    if (!required || required.length === 0) return true;
    if (!req.principal) throw new ProblemException(401, "UNAUTHENTICATED", "Authentication required");
    if (!required.some((role) => req.principal!.roles.has(role))) {
      throw new ProblemException(403, "FORBIDDEN", "Insufficient permissions");
    }
    return true;
  }
}
