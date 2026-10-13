# Inventory Service API (v1)

Base URL (local): `http://localhost:4003`. Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.
Generated OpenAPI: `GET /docs` (UI) and `GET /docs-json`, produced by `@nestjs/swagger` from controllers and DTOs.
Status: **documented, not yet implemented** (Phase 2). Implemented today: health, OpenAPI shell.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/inventory` | admin | n/a | List stock items (cursor pagination, filter by SKU prefix) |
| GET | `/api/v1/inventory/{sku}` | public (availability only) / admin (full) | n/a | Stock for one SKU |
| GET | `/api/v1/inventory/low-stock` | admin | n/a | SKUs with `available <= lowStockThreshold` |
| PATCH | `/api/v1/inventory/{sku}` | admin | `Idempotency-Key` required | Adjust/restock (`delta`), or set threshold. Audited |
| POST | `/api/v1/inventory/reservations` | service token | `Idempotency-Key` required | Reserve stock for an order (all lines or none) |
| GET | `/api/v1/inventory/reservations/{reservationId}` | service token / admin | n/a | Reservation state |
| POST | `/api/v1/inventory/reservations/{reservationId}/confirm` | service token | idempotent | Deduct reserved stock permanently |
| POST | `/api/v1/inventory/reservations/{reservationId}/release` | service token / admin | idempotent | Return reserved stock |

The REST reservation endpoints and the SQS command handlers call **the same domain service**.
REST is for operations, admin tools and tests; the saga uses commands.

## Data model

```
stock_items(sku PK, on_hand INT, reserved INT, low_stock_threshold INT, version INT, updated_at)
  CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
  available = on_hand - reserved  (computed, never stored)

reservations(id PK, order_id UNIQUE, saga_id, idempotency_key UNIQUE,
             status: ACTIVE|CONFIRMED|RELEASED|EXPIRED, expires_at, created_at, updated_at)
reservation_lines(reservation_id, sku, quantity)
stock_movements(id, sku, delta_on_hand, delta_reserved, reason, reference_id, actor, correlation_id, created_at)
```

## How overselling is prevented

Inside one transaction, for each line **in SKU order** (consistent lock order means no deadlocks):

```sql
UPDATE stock_items
   SET reserved = reserved + :qty, version = version + 1, updated_at = now()
 WHERE sku = :sku AND on_hand - reserved >= :qty
RETURNING sku;
```

If any update affects 0 rows, the whole transaction rolls back and `InventoryReservationFailed`
is emitted. Three layers protect the stock:

1. **Atomic conditional update.** The availability check and the increment happen in one statement under a row lock.
2. **CHECK constraint.** Even buggy code cannot store `reserved > on_hand`.
3. **UNIQUE(idempotency_key) and UNIQUE(order_id).** A duplicate command cannot create a second reservation.

A concurrency test in Phase 2 fires N parallel reservations at a SKU with stock < N and asserts
that exactly `stock` succeed.

## POST /api/v1/inventory/reservations

```json
// request
{ "orderId": "uuid", "sagaId": "uuid", "lines": [{ "sku": "TSHIRT-BLK-M", "quantity": 2 }], "ttlSeconds": 2700 }
// 201 (or 200 with Idempotency-Replayed: true)
{ "reservation": { "id": "uuid", "orderId": "uuid", "status": "ACTIVE",
                   "lines": [{ "sku": "TSHIRT-BLK-M", "quantity": 2 }],
                   "expiresAt": "2026-10-13T10:15:00.000Z" } }
// 409 INSUFFICIENT_STOCK
{ "code": "INSUFFICIENT_STOCK", "...": "...",
  "unavailableLines": [{ "sku": "TSHIRT-BLK-M", "requested": 2, "available": 1 }] }
```

## PATCH /api/v1/inventory/{sku}

`{ "delta": 50, "reason": "RESTOCK" }` or `{ "lowStockThreshold": 5 }`. `delta` may be negative
(`DAMAGED`, `CORRECTION`) but can never reduce `on_hand` below `reserved` (`409`). Every change
writes a `stock_movements` row.

## Expiry

A scheduled job releases `ACTIVE` reservations past `expires_at` (`FOR UPDATE SKIP LOCKED` batches,
so multiple instances can run it safely) and emits `InventoryReservationReleased{reason: EXPIRED}`.
