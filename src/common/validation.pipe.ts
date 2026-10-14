import { ValidationPipe, type ValidationError } from "@nestjs/common";
import { type FieldError, ProblemException } from "./problem.exception";

function flatten(errors: ValidationError[], parent = ""): FieldError[] {
  return errors.flatMap((e) => {
    const path = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((message) => ({ path, message }));
    return [...own, ...flatten(e.children ?? [], path)];
  });
}

/** class-validator for every DTO; unknown properties are rejected, not silently dropped. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new ProblemException(400, "VALIDATION_FAILED", "Request validation failed", {
        detail: "One or more fields are invalid.",
        errors: flatten(errors),
      }),
  });
}
