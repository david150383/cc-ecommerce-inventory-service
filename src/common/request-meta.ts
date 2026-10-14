import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Principal } from "../auth/principal";

/** Who is acting and how to correlate it: passed into domain services for audit and events. */
export interface RequestMeta {
  correlationId: string;
  actor: string | null;
}

export const Meta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();
  const res = ctx.switchToHttp().getResponse<Response>();
  return { correlationId: res.locals.correlationId as string, actor: req.principal?.subject ?? null };
});
