# Inventory Service: messages

Schemas: [`events/schemas/`](../events/schemas). Examples: [`events/examples/`](../events/examples).

## Consumed commands (owned here, SQS `inventory-commands`)

| Command | Sender | Result event(s) | Idempotency |
|---|---|---|---|
| `InventoryReservationRequested` v1 | Saga | `InventoryReserved` or `InventoryReservationFailed` | `UNIQUE(idempotency_key)`. A replay re-emits the original outcome |
| `InventoryReservationConfirmRequested` v1 | Saga | `InventoryReservationConfirmed`, or `InventoryReservationFailed{RESERVATION_EXPIRED}` | Confirming a CONFIRMED reservation re-emits Confirmed |
| `InventoryReservationReleaseRequested` v1 | Saga | `InventoryReservationReleased` | Releasing a RELEASED/unknown reservation emits Released `{NOTHING_TO_RELEASE}` |

**Every command produces exactly one result event, including duplicates.** The saga may have
crashed before seeing the first reply, so it needs the answer again.

## Produced events (owned here, SNS `inventory-events`)

| Event | Consumers |
|---|---|
| `InventoryReserved` v1 | Saga |
| `InventoryReservationFailed` v1 | Saga |
| `InventoryReservationConfirmed` v1 | Saga |
| `InventoryReservationReleased` v1 | Saga |
| `InventoryLowStock` v1 | Notification (admin alert) |

All events are written to the `outbox` table in the same transaction as the stock change.
