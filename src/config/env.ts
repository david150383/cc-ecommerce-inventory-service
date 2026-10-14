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
  JWT_AUDIENCE: z.string().default("ecommerce-api"),

  RESERVATION_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(2_700),
  /// How often expired reservations are released. 0 disables the sweeper (tests call it directly).
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
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
