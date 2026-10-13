# ecommerce-inventory-service

Stock for the e-commerce platform: on-hand and reserved quantities per SKU, all-or-nothing
reservations, confirmation, release, expiry, restocking and adjustments, a full movement audit
trail, and low-stock alerts. It is designed so that **overselling is impossible**, even under
concurrent checkouts and duplicate messages (see [docs/api.md](docs/api.md#how-overselling-is-prevented)).

| | |
|---|---|
| Stack | Node.js 24, NestJS 11, TypeScript 5.9, PostgreSQL 17, TypeORM *(Phase 2)*, Jest |
| Port | 4003 |
| Database | `inventory_db` (PostgreSQL), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md); generated OpenAPI at `/docs` |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ Nest app with pino logging (redaction), correlation IDs, RFC 9457 filter, own JSON parser with problem responses, readiness service with shutdown hook, Swagger, Dockerfile, CI, message schemas |
| 2: features | ⏳ TypeORM entities & migrations, reservations with row-level locking, idempotency, audit, concurrency test |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # nest start --watch, http://localhost:4003/health/live, /docs
npm test               # Jest
```

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
src/common/                    logger options, correlation IDs, RFC 9457 problem filter
src/health/                    /health/live, /health/ready, ReadinessService (+ shutdown hook)
test/                          Jest + Supertest, schema validation
```
