import type { NextFunction, Request, Response } from "express";
import { sendProblem } from "./problem";

// Nest's built-in parser turns parse failures into a generic BadRequestException
// carrying the raw parser message. The app is created with { bodyParser: false }
// and uses express.json() followed by this handler instead.
export function bodyParserErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const type = typeof err === "object" && err !== null && "type" in err ? (err as { type: unknown }).type : undefined;
  if (type === "entity.parse.failed") {
    sendProblem(req, res, { status: 400, code: "MALFORMED_JSON", title: "Malformed JSON body" });
  } else if (type === "entity.too.large") {
    sendProblem(req, res, { status: 413, code: "PAYLOAD_TOO_LARGE", title: "Request body too large" });
  } else {
    next(err);
  }
}
