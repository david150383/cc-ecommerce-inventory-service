# Inventory Service API (v1)

Base URL (local): `http://localhost:4003`. Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.
Generated OpenAPI: `GET /docs` (UI) and `GET /docs-json`, produced by `@nestjs/swagger` from the controllers
and the `class-validator` DTOs that also validate requests.

Status: **implemented** (Phase 2). The SQS command consumer that the saga uses arrives in Phase 3 and calls
the same `ReservationService`.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/inventory` | admin | n/a | List stock (cursor by SKU, `skuPrefix` filter) |
| GET | `/api/v1/inventory/low-stock` | admin | n/a | SKUs with `available <= lowStockThreshold` |
| GET | `/api/v1/inventory/{sku}` | public → `{sku, available, inStock}`; admin → full record | n/a | Stock for one SKU |
| GET | `/api/v1/inventory/{sku}/movements` | admin | n/a | Audit history (newest first) |
| PATCH | `/api/v1/inventory/{sku}` | admin | `Idempotency-Key` **required** | Restock / write-off / correction (`delta` + `reason`), or set `lowStockThreshold` |
| POST | `/api/v1/inventory/reservations` | service, admin | `Idempotency-Key` **required** | Reserve all lines or none |
| GET | `/api/v1/inventory/reservations/{id}` | service, admin | n/a | Reservation state |
| POST | `/api/v1/inventory/reservations/{id}/confirm` | service | idempotent | Deduct reserved stock permanently |
| POST | `/api/v1/inventory/reservations/{id}/release` | service, admin | idempotent | Return reserved stock |

## Data model

```
stock_items(sku PK, on_hand, reserved, low_stock_threshold, version, updated_at)
  CHECK on_hand >= 0, reserved >= 0, reserved <= on_hand, sku format
  available = on_hand - reserved   (computed, never stored)

reservations(id, order_id, saga_id, idempotency_key UNIQUE, request_hash,
             status ACTIVE|CONFIRMED|RELEASED|EXPIRED|REJECTED, expires_at,
             unavailable_lines, release_reason, created_at, updated_at)
  UNIQUE (order_id) WHERE status IN ('ACTIVE','CONFIRMED')   -- one live reservation per order
reservation_lines(reservation_id, sku, quantity > 0)
stock_movements(id, sku, delta_on_hand, delta_reserved, reason, reference_id, actor, correlation_id, note, created_at)
idempotency_records(key, request_hash, status_code, response_body)    -- admin adjustments
outbox(id, message_type, envelope, created_at, published_at, attempts)
```

## How overselling is prevented

For each line **in SKU order** (a consistent lock order means two orders over the same SKUs cannot
deadlock), inside one transaction:

```sql
UPDATE stock_items
   SET reserved = reserved + :qty
 WHERE sku = :sku AND on_hand - reserved >= :qty
RETURNING ...
```

The availability check and the increment are **one statement under a row lock**, so there is no window
between "check" and "act". If any line matches no row, the transaction rolls back to a savepoint
taken before the first line, and nothing is held. Three layers:

1. **Atomic conditional update** (above).
2. **`CHECK (reserved <= on_hand)`**: even buggy code cannot store an oversold state.
3. **Unique idempotency key + one live reservation per order**: duplicates cannot double-reserve.

Verified by tests: 40 concurrent buyers of a SKU with 7 units → exactly 7 succeed; 30 two-line orders
over the same SKUs in opposite orders → no oversell, no deadlock; confirm racing release → exactly one wins.

## POST /api/v1/inventory/reservations

```json
// request: Idempotency-Key: <key>
{ "orderId": "uuid", "sagaId": "uuid", "lines": [{ "sku": "TEE-BLK-M", "quantity": 2 }], "ttlSeconds": 2700 }

// 201 Created (Location header), or 200 + Idempotency-Replayed: true for a repeated key
{ "reservation": { "id": "uuid", "orderId": "uuid", "sagaId": "uuid", "status": "ACTIVE",
                   "lines": [{ "sku": "TEE-BLK-M", "quantity": 2 }], "expiresAt": "2026-10-14T10:15:00.000Z",
                   "unavailableLines": null, "releaseReason": null, "createdAt": "…", "updatedAt": "…" } }

// 409 INSUFFICIENT_STOCK: nothing reserved
{ "code": "INSUFFICIENT_STOCK", "reservationId": "uuid", "replayed": false,
  "unavailableLines": [{ "sku": "TEE-BLK-M", "requested": 2, "available": 1 }] }
```

### Idempotency semantics

1. The key is claimed **first** (`INSERT … ON CONFLICT (idempotency_key) DO NOTHING`). A concurrent
   duplicate blocks on the unique index until the first request commits, then sees its outcome. Tested
   with 10 simultaneous identical requests: one 201, nine 200, one reservation.
2. **Failures are remembered too.** A rejected attempt is stored as `REJECTED`, so retrying the same key
   returns the same 409 even if stock has arrived since. A retry must not change the answer; a *new*
   attempt needs a new key.
3. The same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`.
4. A second live reservation for the same order with a different key returns `409 ORDER_ALREADY_RESERVED`.

## Confirm, release, expiry

| From | confirm | release | expiry sweep |
|---|---|---|---|
| ACTIVE (not expired) | → CONFIRMED (on_hand −q, reserved −q) | → RELEASED (reserved −q) | n/a |
| ACTIVE (past expires_at) | → EXPIRED, then `409 RESERVATION_EXPIRED` | → RELEASED | → EXPIRED |
| CONFIRMED | 200 (no-op) | `409 RESERVATION_CONFIRMED` (use a RETURN adjustment) | n/a |
| RELEASED / EXPIRED | `409 RESERVATION_RELEASED/EXPIRED` | 200 (no-op) | n/a |

Each operation locks the reservation row (`FOR UPDATE`), so confirm, release and expiry for one
reservation are serialized. The sweeper runs every `EXPIRY_SWEEP_INTERVAL_MS` on every instance and
uses `FOR UPDATE SKIP LOCKED`, so each expired reservation is processed exactly once even with many
instances. Tested: two concurrent sweeps release one reservation once.

## PATCH /api/v1/inventory/{sku}

```json
{ "delta": 50, "reason": "RESTOCK", "note": "PO-1001" }        // reasons: RESTOCK, RETURN, DAMAGED, CORRECTION
{ "lowStockThreshold": 5 }
```

- The first positive adjustment of an unknown SKU creates its stock record. Inventory does not call the
  Product Service; admins are trusted to use real SKUs.
- `on_hand` can never drop below `reserved`: `409 WOULD_UNDERCUT_RESERVATIONS` reports the maximum removable.
- Idempotent per `(sku, Idempotency-Key)`; a replay returns the stored response. A *failed* adjustment is
  not stored, so it can be retried with the same key.
- Every change writes a `stock_movements` row with the admin's user id and the correlation id.

## Errors

`400 VALIDATION_FAILED` (with `errors[]`), `400 IDEMPOTENCY_KEY_REQUIRED`, `401`, `403`, `404 NOT_FOUND`,
`409 INSUFFICIENT_STOCK | ORDER_ALREADY_RESERVED | RESERVATION_CONFIRMED | RESERVATION_RELEASED |
RESERVATION_EXPIRED | WOULD_UNDERCUT_RESERVATIONS`, `422 IDEMPOTENCY_KEY_REUSED`, `503 DEPENDENCY_UNAVAILABLE`.
