import { IdempotencyRecord } from "../inventory/entities/idempotency-record.entity";
import { Reservation, ReservationLine } from "../inventory/entities/reservation.entity";
import { StockItem } from "../inventory/entities/stock-item.entity";
import { StockMovement } from "../inventory/entities/stock-movement.entity";
import { OutboxMessage } from "../outbox/outbox-message.entity";

export const ENTITIES = [StockItem, Reservation, ReservationLine, StockMovement, IdempotencyRecord, OutboxMessage];
