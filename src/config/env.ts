import { z } from "zod";

// Validated once at startup; the process refuses to boot with invalid config.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4003),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().startsWith("postgresql://"),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  // Tokens are issued by ecommerce-auth-service and verified with its public keys.
  JWKS_URL: z.url().default("http://localhost:4001/.well-known/jwks.json"),
  JWT_ISSUER: z.string().default("ecommerce-auth-service"),
  JWT_AUDIENCE: z.string().default("ecommerce-api"), // user tokens
  JWT_SERVICE_AUDIENCE: z.string().default("ecommerce-inventory-service"), // service tokens addressed to THIS service

  RESERVATION_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(2_700),
  /// How often expired reservations are released. 0 disables the sweeper (tests call it directly).
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),

  // Messaging (SNS/SQS). Disabled: the service still serves REST; outbox rows accumulate until enabled.
  MESSAGING_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  AWS_REGION: z.string().default("us-east-1"),
  /// Local emulator (Floci). Unset in AWS.
  AWS_ENDPOINT_URL: z.url().optional(),
  EVENTS_TOPIC_ARN: z.string().default("arn:aws:sns:us-east-1:000000000000:local-ecommerce-inventory-events"),
  COMMANDS_QUEUE_NAME: z.string().default("local-ecommerce-inventory-commands"),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  /// SQS long-poll wait (max 20). Long polling cuts empty receives (and cost); tests use 1.
  CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
});

export type Env = z.infer<typeof EnvSchema>;

export const ENV = Symbol("ENV");

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
