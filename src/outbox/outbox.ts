import type { EntityManager } from "typeorm";
import { v7 as uuidv7 } from "uuid";
import { SERVICE_NAME } from "../common/logger.options";
import { sql } from "../database/sql";

export interface EventMeta {
  correlationId: string;
  causationId?: string | null;
  sagaId?: string | null;
}

/**
 * Writes an event to the outbox using the CALLER's transaction, so it commits or rolls
 * back together with the stock change it describes. Envelope: events/schemas/envelope.v1.
 */
export async function writeEvent(manager: EntityManager, messageType: string, payload: object, meta: EventMeta): Promise<void> {
  const envelope = {
    messageId: uuidv7(),
    messageKind: "event",
    messageType,
    messageVersion: 1,
    producer: SERVICE_NAME,
    occurredAt: new Date().toISOString(),
    correlationId: meta.correlationId,
    causationId: meta.causationId ?? null,
    sagaId: meta.sagaId ?? null,
    idempotencyKey: null,
    payload,
  };
  await sql(manager, `INSERT INTO outbox (id, message_type, envelope) VALUES ($1, $2, $3)`, [
    envelope.messageId,
    messageType,
    JSON.stringify(envelope),
  ]);
}
