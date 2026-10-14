import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { sendProblem } from "./problem";
import { ProblemException } from "./problem.exception";

// Converts every exception thrown inside Nest into an RFC 9457 problem+json response.
const CODE_BY_STATUS: Record<number, string> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    if (exception instanceof ProblemException) {
      if (exception.getStatus() === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="ecommerce"');
      sendProblem(req, res, {
        status: exception.getStatus(),
        code: exception.code,
        title: exception.message,
        ...exception.problem,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      sendProblem(req, res, {
        status,
        code: CODE_BY_STATUS[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST"),
        title: status === 404 ? "Resource not found" : exception.message,
      });
      return;
    }

    // Unexpected: log the real cause, return a generic message. No stack traces to clients.
    this.logger.error({ err: exception, correlationId: res.locals.correlationId }, "unhandled error");
    sendProblem(req, res, {
      status: 500,
      code: "INTERNAL_ERROR",
      title: "Internal server error",
      detail: "An unexpected error occurred.",
    });
  }
}
