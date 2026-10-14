# ecommerce-inventory-service

Stock for the e-commerce platform: on-hand and reserved quantities per SKU, all-or-nothing
reservations, confirmation, release, expiry, restocking and adjustments, a full movement audit
trail, and low-stock alerts. It is designed so that **overselling is impossible**, even under
concurrent checkouts and duplicate messages (see [docs/api.md](docs/api.md#how-overselling-is-prevented)).

| | |
|---|---|
| Stack | Node.js 24, NestJS 11, TypeScript 5.9, PostgreSQL 17, TypeORM 1.x, class-validator, jose 5, Jest |
| Port | 4003 |
| Database | `inventory_db` (PostgreSQL), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md); generated OpenAPI at `/docs` |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ Nest app with pino logging (redaction), correlation IDs, RFC 9457 filter, own JSON parser with problem responses, readiness service with shutdown hook, Swagger, Dockerfile, CI, message schemas |
| 2: features | ✅ Stock records & adjustments, all-or-nothing reservations (conditional updates, SKU-ordered locking), idempotency incl. remembered failures, confirm/release, expiry sweeper (SKIP LOCKED), audit trail, low-stock alerts, outbox events, JWT auth, TypeORM migrations |
| 3 | ⏳ SQS command consumer + outbox relay |

## Run locally

```bash
docker compose up -d       # standalone Postgres on 5443 (or the shared stack on 5432)
cp .env.example .env
npm install
npm run migration:run      # apply migrations
npm run dev                # nest start --watch, http://localhost:4003/docs
npm test                   # Jest; recreates inventory_test from the migrations
```

## Migrations (TypeORM)

```bash
npm run migration:generate -- src/database/migrations/DescribeChange   # DRAFT from entity changes, then review it
npm run migration:run
npm run migration:revert
npm run db:check-drift     # fails if entities changed without a migration (CI runs this)
```

`synchronize` is always `false`: the schema only changes through reviewed migrations. In containers the
`migrate` image target runs the compiled migrations as a one-off job (`inventory-migrate` in the platform
compose file).

## A bug worth remembering

TypeORM's `manager.query()` returns rows for `SELECT` but `[rows, affectedCount]` for `UPDATE … RETURNING`.
A conditional reservation that matched nothing therefore returned `[[], 0]`, and `result[0]` (`[]`) is
truthy, so a short line looked reserved. The concurrency tests caught it as overselling. All raw SQL now
goes through `src/database/sql.ts`, which always returns the rows.

## Why NestJS 11, not 12?

NestJS 12 (Aug 2026) is ESM-only. This service uses Jest (whose ESM support is still
experimental), `nestjs-pino`, and from Phase 2 `@nestjs/typeorm`. Nest 11 is still patched and
works with all of them under CommonJS. Migrating to 12 is a tracked follow-up. For the same
reason `uuid` is pinned to v11 (the last dual CJS/ESM major).

## Known dependency advisory

`npm audit` (dev only) reports `sprintf-js` (GHSA-hp3w-g68c-fv3c) via Jest's coverage tooling.
All versions are affected and it never ships in the image. `npm audit --omit=dev` is clean;
`js-yaml` under `@nestjs/swagger` is forced to a patched version via `overrides`.

## Layout

```
src/main.ts                    bootstrap (bodyParser: false; see configure-app.ts)
src/configure-app.ts           helmet, CORS, JSON parser, filters, Swagger: shared with tests
src/app.module.ts              AppModule.forRoot(env)
src/common/                    logger options, correlation IDs, RFC 9457 problems, validation pipe
src/auth/                      JWT verification (Auth's JWKS), global guard, @Roles()
src/inventory/                 controllers, DTOs, ReservationService, StockService, expiry scheduler
src/database/                  entities list, data source (app + CLI), migrations, sql() helper
src/outbox/                    outbox entity + writeEvent() (same transaction as the change)
src/health/                    /health/live, /health/ready, ReadinessService (+ shutdown hook)
test/                          Jest + Supertest against real Postgres: concurrency, idempotency, schemas
```
