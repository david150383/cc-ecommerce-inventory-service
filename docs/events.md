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

## Runtime (Phase 3)

| Piece | Behaviour |
|---|---|
| Outbox relay | Every `OUTBOX_POLL_INTERVAL_MS`: claims unpublished rows `FOR UPDATE SKIP LOCKED`, publishes to `EVENTS_TOPIC_ARN` with the `messageType` attribute, marks them published. A failed publish leaves the row for the next tick. At-least-once. |
| Command consumer | Long-polls `COMMANDS_QUEUE_NAME`. Each command is validated against **this repo's** schema, then handled by the same `ReservationService` as REST. The message is deleted only after success. |
| Business "no" | Insufficient stock, an expired reservation, nothing to release: answered with an event; the message is deleted. |
| Duplicates | The work is not repeated (idempotency key / state), but the result event is emitted again, so a re-sending saga gets its answer. |
| Poison messages | Malformed JSON, schema violations, unknown types, unknown reservations: never deleted. After `maxReceiveCount` (5) receives SQS moves them to the DLQ (alarm). |

Tested against Floci with a private topic and queues per test run: relay publishing and retry, duplicate
delivery, failure outcomes, release by order, expired confirm, DLQ redrive.
