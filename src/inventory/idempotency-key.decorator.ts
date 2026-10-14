import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { ProblemException } from "../common/problem.exception";

/** Required `Idempotency-Key` header (1–255 printable characters). */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const key = ctx.switchToHttp().getRequest<Request>().get("idempotency-key");
  if (!key || !/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw new ProblemException(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  }
  return key;
});
