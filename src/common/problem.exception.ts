import { HttpException } from "@nestjs/common";

export interface FieldError {
  path: string;
  message: string;
}

/**
 * An HTTP error with a stable machine-readable `code` (and optional extra members),
 * rendered as RFC 9457 problem+json by ProblemDetailsFilter.
 */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    title: string,
    readonly problem: { detail?: string; errors?: FieldError[]; extra?: Record<string, unknown> } = {},
  ) {
    super(title, status);
  }
}
