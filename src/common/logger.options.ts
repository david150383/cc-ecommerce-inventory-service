import type { IncomingMessage, ServerResponse } from "node:http";
import type { Params } from "nestjs-pino";
import { stdTimeFunctions } from "pino";

export const SERVICE_NAME = "ecommerce-inventory-service";

type Res = ServerResponse & { locals?: Record<string, unknown> };

// Secrets must never reach the logs; redaction happens at the logger level.
export function loggerOptions(level: string): Params {
  return {
    pinoHttp: {
      level,
      base: { service: SERVICE_NAME },
      timestamp: stdTimeFunctions.isoTime,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token", "*.secret"],
        censor: "[REDACTED]",
      },
      genReqId: (_req: IncomingMessage, res: Res) => res.locals?.requestId as string,
      customProps: (_req: IncomingMessage, res: Res) => ({ correlationId: res.locals?.correlationId }),
      autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith("/health") ?? false },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
