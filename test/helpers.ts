import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { exportJWK, generateKeyPair, type JSONWebKeySet, type KeyLike, SignJWT } from "jose";
import { DataSource } from "typeorm";
import { v7 as uuidv7 } from "uuid";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/config/env";
import { configureApp } from "../src/configure-app";
import { TEST_DATABASE_URL } from "./global-setup";

const ISSUER = "ecommerce-auth-service";
const AUDIENCE = "ecommerce-api";

let keys: Promise<{ privateKey: KeyLike; jwks: JSONWebKeySet }> | undefined;
export function testKeys() {
  keys ??= generateKeyPair("RS256").then(async ({ privateKey, publicKey }) => ({
    privateKey,
    jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] },
  }));
  return keys;
}

/** Signs a token exactly like ecommerce-auth-service does (RS256 + kid). */
export async function token(roles: string[], opts: { sub?: string; audience?: string; expiresIn?: string } = {}) {
  const { privateKey } = await testKeys();
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject(opts.sub ?? uuidv7())
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "15m")
    .sign(privateKey);
}

export const bearer = async (...roles: string[]) => ({
  // Service tokens are addressed to the target service, like Auth's client-credentials grant.
  Authorization: `Bearer ${await token(roles, roles.includes("service") ? { audience: "ecommerce-inventory-service" } : {})}`,
});

export async function buildApp(overrides: Record<string, string> = {}): Promise<INestApplication> {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: TEST_DATABASE_URL,
    DB_POOL_SIZE: "25",
    EXPIRY_SWEEP_INTERVAL_MS: "0",
    ...overrides,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env, { jwks: (await testKeys()).jwks })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
  configureApp(app, env);
  await app.init();
  return app;
}

export async function resetDatabase(app: INestApplication): Promise<void> {
  await app
    .get(DataSource)
    .query(
      "TRUNCATE stock_items, reservations, reservation_lines, stock_movements, idempotency_records, outbox CASCADE",
    );
}

export async function seedStock(app: INestApplication, sku: string, onHand: number, threshold = 5): Promise<void> {
  await app
    .get(DataSource)
    .query(`INSERT INTO stock_items (sku, on_hand, low_stock_threshold) VALUES ($1, $2, $3)`, [sku, onHand, threshold]);
}

export async function stockOf(app: INestApplication, sku: string): Promise<{ on_hand: number; reserved: number }> {
  const [row] = await app.get(DataSource).query(`SELECT on_hand, reserved FROM stock_items WHERE sku = $1`, [sku]);
  return row;
}

export const newId = () => uuidv7();
