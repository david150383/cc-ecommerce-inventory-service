import type { Request, Response } from "express";

// Writes an RFC 9457 problem+json response.
// See ecommerce-infrastructure/docs/architecture/conventions.md.
export function sendProblem(
  req: Request,
  res: Response,
  problem: { status: number; code: string; title: string; detail?: string },
): void {
  res
    .status(problem.status)
    .type("application/problem+json")
    .json({
      type: `https://errors.ecommerce.local/${problem.code.toLowerCase().replaceAll("_", "-")}`,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      ...(problem.detail !== undefined && { detail: problem.detail }),
      instance: req.originalUrl,
      correlationId: res.locals.correlationId,
    });
}
