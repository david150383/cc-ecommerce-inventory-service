import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, type EntityManager, QueryFailedError } from "typeorm";
import { v7 as uuidv7 } from "uuid";
import { ProblemException } from "../common/problem.exception";
import type { RequestMeta } from "../common/request-meta";
import { ENV, type Env } from "../config/env";
import { writeEvent } from "../outbox/outbox";
import { type Reservation, ReservationStatus, type UnavailableLine } from "./entities/reservation.entity";
import type { MovementReason } from "./entities/stock-movement.entity";
import { sql } from "../database/sql";

export interface ReserveInput {
  orderId: string;
  sagaId: string | null;
  lines: { sku: string; quantity: number }[];
  ttlSeconds?: number;
}

export interface ReservationView {
  id: string;
  orderId: string;
  sagaId: string | null;
  status: ReservationStatus;
  lines: { sku: string; quantity: number }[];
  expiresAt: string;
  unavailableLines: UnavailableLine[] | null;
  releaseReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveResult {
  reservation: ReservationView;
  /** True when the outcome was recorded earlier under the same idempotency key. */
  replayed: boolean;
}

type ReleaseReason = "REQUESTED" | "EXPIRED";

/** Canonical JSON (sorted keys) so that semantically equal requests hash equally. */
function requestHash(input: ReserveInput): string {
  const canonical = JSON.stringify({
    orderId: input.orderId,
    sagaId: input.sagaId,
    ttlSeconds: input.ttlSeconds ?? null,
    lines: [...input.lines].sort((a, b) => a.sku.localeCompare(b.sku)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function pgConstraint(err: unknown): string | undefined {
  if (!(err instanceof QueryFailedError)) return undefined;
  return (err.driverError as { constraint?: string }).constraint;
}

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ======================================================================= reserve

  /**
   * All-or-nothing reservation of every line, idempotent per key.
   *
   * 1. Claim the idempotency key FIRST (INSERT ... ON CONFLICT DO NOTHING). A concurrent
   *    duplicate blocks on the unique index until we commit, then sees our outcome.
   * 2. Inside a SAVEPOINT, atomically move stock from available to reserved, line by line
   *    in SKU order (a consistent lock order means concurrent orders cannot deadlock).
   * 3. If any line is short: roll back to the savepoint (no stock held), but COMMIT the
   *    reservation as REJECTED, so a retry with the same key gets the same answer.
   */
  async reserve(idempotencyKey: string, input: ReserveInput, meta: RequestMeta): Promise<ReserveResult> {
    const hash = requestHash(input);
    const id = uuidv7();
    const ttl = input.ttlSeconds ?? this.env.RESERVATION_DEFAULT_TTL_SECONDS;
    const lines = [...input.lines].sort((a, b) => a.sku.localeCompare(b.sku));

    const outcome = await this.db.transaction(async (m) => {
      let claimed: { id: string }[];
      try {
        claimed = await sql(m, 
          `INSERT INTO reservations (id, order_id, saga_id, idempotency_key, request_hash, status, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'ACTIVE', now() + make_interval(secs => $6))
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [id, input.orderId, input.sagaId, idempotencyKey, hash, ttl],
        );
      } catch (err) {
        if (pgConstraint(err) === "uq_reservations_live_order") {
          throw new ProblemException(409, "ORDER_ALREADY_RESERVED", "This order already holds a reservation", {
            detail: "Release or confirm the existing reservation, or retry with its original idempotency key.",
          });
        }
        throw err;
      }
      if (claimed.length === 0) return { kind: "existing" as const };

      await sql(m, "SAVEPOINT reserve_lines");
      const short: string[] = [];
      const lowStock: { sku: string; available: number; threshold: number }[] = [];
      for (const line of lines) {
        // The availability check and the increment are ONE statement under a row lock:
        // there is no gap between "check" and "act" for a concurrent request to slip into.
        const rows: { available: number; threshold: number }[] = await sql(m, 
          `UPDATE stock_items
              SET reserved = reserved + $2, version = version + 1, updated_at = now()
            WHERE sku = $1 AND on_hand - reserved >= $2
        RETURNING on_hand - reserved AS available, low_stock_threshold AS threshold`,
          [line.sku, line.quantity],
        );
        const row = rows[0];
        if (!row) {
          short.push(line.sku);
          continue;
        }
        if (row.available <= row.threshold && row.available + line.quantity > row.threshold) {
          lowStock.push({ sku: line.sku, available: row.available, threshold: row.threshold });
        }
      }

      if (short.length > 0) {
        await sql(m, "ROLLBACK TO SAVEPOINT reserve_lines");
        const unavailable = await this.availability(m, lines);
        const known = await sql<{ sku: string }>(m, `SELECT sku FROM stock_items WHERE sku = ANY($1)`, [lines.map((l) => l.sku)]);
        const failureReason = lines.some((l) => !known.some((k) => k.sku === l.sku)) ? "UNKNOWN_SKU" : "INSUFFICIENT_STOCK";
        await sql(
          m,
          `UPDATE reservations SET status = 'REJECTED', unavailable_lines = $2, failure_reason = $3, updated_at = now() WHERE id = $1`,
          [id, JSON.stringify(unavailable), failureReason],
        );
        // The failure is an outcome too: the saga waits for exactly one result event per command.
        await writeEvent(
          m,
          "InventoryReservationFailed",
          { orderId: input.orderId, reason: failureReason, unavailableLines: unavailable },
          { correlationId: meta.correlationId, causationId: meta.causationId ?? null, sagaId: input.sagaId },
        );
        return { kind: "rejected" as const };
      }
      await sql(m, "RELEASE SAVEPOINT reserve_lines");

      for (const line of lines) {
        await sql(m, `INSERT INTO reservation_lines (reservation_id, sku, quantity) VALUES ($1, $2, $3)`, [
          id,
          line.sku,
          line.quantity,
        ]);
        await this.movement(m, line.sku, 0, line.quantity, "RESERVED", id, meta);
      }
      const reservation = await this.load(m, id);
      await writeEvent(
        m,
        "InventoryReserved",
        { reservationId: id, orderId: input.orderId, lines, expiresAt: reservation.expiresAt },
        { correlationId: meta.correlationId, causationId: meta.causationId ?? null, sagaId: input.sagaId },
      );
      for (const low of lowStock) await this.lowStockEvent(m, low, meta);
      return { kind: "created" as const };
    });

    const existing = await this.findByKey(idempotencyKey);
    if (outcome.kind === "existing" && existing.requestHash !== hash) {
      throw new ProblemException(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different request");
    }
    const replayed = outcome.kind === "existing";
    const view = this.toView(existing);
    if (view.status === ReservationStatus.REJECTED) throw this.rejection(view, replayed);
    return { reservation: view, replayed };
  }

  // ======================================================================= confirm

  /** ACTIVE -> CONFIRMED: reserved stock leaves on_hand for good. Idempotent. */
  async confirm(id: string, meta: RequestMeta): Promise<ReservationView> {
    const expired = await this.db.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.status === ReservationStatus.CONFIRMED) return false;
      if (r.status === ReservationStatus.RELEASED || r.status === ReservationStatus.EXPIRED || r.status === ReservationStatus.REJECTED) {
        throw this.notConfirmable(r);
      }
      if (new Date(r.expires_at) <= new Date()) {
        // Too late: expire it now (stock returns to available) and tell the caller.
        await this.returnStock(m, r, "EXPIRED", meta);
        return true;
      }
      for (const line of r.lines) {
        await sql(m, 
          `UPDATE stock_items SET on_hand = on_hand - $2, reserved = reserved - $2, version = version + 1, updated_at = now()
            WHERE sku = $1`,
          [line.sku, line.quantity],
        );
        await this.movement(m, line.sku, -line.quantity, -line.quantity, "RESERVATION_CONFIRMED", id, meta);
      }
      await sql(m, `UPDATE reservations SET status = 'CONFIRMED', updated_at = now() WHERE id = $1`, [id]);
      await writeEvent(m, "InventoryReservationConfirmed", { reservationId: id, orderId: r.order_id }, {
        correlationId: meta.correlationId,
        causationId: meta.causationId ?? null,
        sagaId: r.saga_id,
      });
      return false;
    });
    const view = await this.get(id);
    if (expired) throw this.notConfirmable({ status: ReservationStatus.EXPIRED, id });
    return view;
  }

  // ======================================================================= release

  /** ACTIVE -> RELEASED: reserved stock becomes available again. Idempotent. */
  async release(id: string, meta: RequestMeta): Promise<ReservationView> {
    await this.db.transaction(async (m) => {
      const r = await this.lock(m, id);
      if (r.status === ReservationStatus.CONFIRMED) {
        throw new ProblemException(409, "RESERVATION_CONFIRMED", "A confirmed reservation cannot be released", {
          detail: "Its stock has already left the warehouse; use a RETURN adjustment instead.",
        });
      }
      if (r.status !== ReservationStatus.ACTIVE) return; // already released/expired/rejected: nothing to do
      await this.returnStock(m, r, "REQUESTED", meta);
    });
    return this.get(id);
  }

  // ======================================================================= expiry

  /**
   * Releases ACTIVE reservations past their expiry, in batches. FOR UPDATE SKIP LOCKED lets
   * several instances sweep concurrently: each row is processed by exactly one of them, and
   * rows locked by an in-flight confirm/release are skipped rather than waited on.
   */
  async expireDue(batchSize = 100): Promise<number> {
    let total = 0;
    for (;;) {
      const count = await this.db.transaction(async (m) => {
        const due: { id: string }[] = await sql(m, 
          `SELECT id FROM reservations
            WHERE status = 'ACTIVE' AND expires_at <= now()
            ORDER BY expires_at
            LIMIT $1
              FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );
        for (const { id } of due) {
          const r = await this.lock(m, id);
          await this.returnStock(m, r, "EXPIRED", { correlationId: `expiry-${uuidv7()}`, actor: "expiry-sweeper" });
        }
        return due.length;
      });
      total += count;
      if (count < batchSize) return total;
    }
  }

  // ======================================================================= outcomes for commands

  /**
   * Re-emits the result event matching a reservation's CURRENT state. Used when a command is a
   * duplicate (e.g. the saga re-sent it after a crash): the work is not repeated, but the sender
   * still gets its answer. Consumers dedupe by state, so an extra copy is harmless.
   */
  async emitOutcome(reservationId: string, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (m) => {
      const r = await m.getRepository<Reservation>("Reservation").findOneOrFail({
        where: { id: reservationId },
        relations: { lines: true },
      });
      const eventMeta = { correlationId: meta.correlationId, causationId: meta.causationId ?? null, sagaId: r.sagaId };
      const lines = [...r.lines].sort((a, b) => a.sku.localeCompare(b.sku)).map((l) => ({ sku: l.sku, quantity: l.quantity }));
      switch (r.status) {
        case ReservationStatus.ACTIVE:
          return writeEvent(m, "InventoryReserved", { reservationId: r.id, orderId: r.orderId, lines, expiresAt: r.expiresAt.toISOString() }, eventMeta);
        case ReservationStatus.CONFIRMED:
          return writeEvent(m, "InventoryReservationConfirmed", { reservationId: r.id, orderId: r.orderId }, eventMeta);
        case ReservationStatus.RELEASED:
        case ReservationStatus.EXPIRED:
          return writeEvent(m, "InventoryReservationReleased", { reservationId: r.id, orderId: r.orderId, reason: r.releaseReason ?? "REQUESTED" }, eventMeta);
        case ReservationStatus.REJECTED:
          return writeEvent(
            m,
            "InventoryReservationFailed",
            { orderId: r.orderId, reason: r.failureReason ?? "INSUFFICIENT_STOCK", unavailableLines: r.unavailableLines ?? [] },
            eventMeta,
          );
      }
    });
  }

  /** Writes a standalone event (e.g. "nothing to release", "cannot confirm") for a command outcome. */
  async emitEvent(messageType: string, payload: object, meta: RequestMeta & { sagaId: string | null }): Promise<void> {
    await this.db.transaction((m) =>
      writeEvent(m, messageType, payload, { correlationId: meta.correlationId, causationId: meta.causationId ?? null, sagaId: meta.sagaId }),
    );
  }

  /** The order's live (ACTIVE or CONFIRMED) reservation, if any. At most one exists (partial unique index). */
  async findLiveByOrder(orderId: string): Promise<{ id: string; status: ReservationStatus } | null> {
    const rows = await sql<{ id: string; status: ReservationStatus }>(
      this.db.manager,
      `SELECT id, status FROM reservations WHERE order_id = $1 AND status IN ('ACTIVE', 'CONFIRMED')`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  // ======================================================================= reads

  async get(id: string): Promise<ReservationView> {
    const rows = await sql(this.db.manager, `SELECT 1 FROM reservations WHERE id = $1`, [id]);
    if (rows.length === 0) throw new ProblemException(404, "NOT_FOUND", "Reservation not found");
    return this.load(this.db.manager, id);
  }

  // ======================================================================= internals

  private async returnStock(m: EntityManager, r: LockedReservation, reason: ReleaseReason, meta: RequestMeta): Promise<void> {
    const status = reason === "EXPIRED" ? ReservationStatus.EXPIRED : ReservationStatus.RELEASED;
    const movement: MovementReason = reason === "EXPIRED" ? "RESERVATION_EXPIRED" : "RESERVATION_RELEASED";
    for (const line of r.lines) {
      await sql(m, 
        `UPDATE stock_items SET reserved = reserved - $2, version = version + 1, updated_at = now() WHERE sku = $1`,
        [line.sku, line.quantity],
      );
      await this.movement(m, line.sku, 0, -line.quantity, movement, r.id, meta);
    }
    await sql(m, `UPDATE reservations SET status = $2, release_reason = $3, updated_at = now() WHERE id = $1`, [
      r.id,
      status,
      reason,
    ]);
    await writeEvent(m, "InventoryReservationReleased", { reservationId: r.id, orderId: r.order_id, reason }, {
      correlationId: meta.correlationId,
      causationId: meta.causationId ?? null,
      sagaId: r.saga_id,
    });
  }

  /** Row lock on the reservation: confirm, release and expiry for one reservation are serialized. */
  private async lock(m: EntityManager, id: string): Promise<LockedReservation> {
    const rows: Omit<LockedReservation, "lines">[] = await sql(m, 
      `SELECT id, order_id, saga_id, status, expires_at FROM reservations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new ProblemException(404, "NOT_FOUND", "Reservation not found");
    const lines: { sku: string; quantity: number }[] = await sql(m, 
      `SELECT sku, quantity FROM reservation_lines WHERE reservation_id = $1 ORDER BY sku`,
      [id],
    );
    return { ...row, lines };
  }

  private async availability(m: EntityManager, lines: { sku: string; quantity: number }[]): Promise<UnavailableLine[]> {
    const rows: { sku: string; available: number }[] = await sql(m, 
      `SELECT sku, on_hand - reserved AS available FROM stock_items WHERE sku = ANY($1)`,
      [lines.map((l) => l.sku)],
    );
    const available = new Map(rows.map((r) => [r.sku, r.available]));
    return lines
      .map((l) => ({ sku: l.sku, requested: l.quantity, available: available.get(l.sku) ?? 0 }))
      .filter((l) => l.available < l.requested);
  }

  private async movement(
    m: EntityManager,
    sku: string,
    deltaOnHand: number,
    deltaReserved: number,
    reason: MovementReason,
    referenceId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await sql(m, 
      `INSERT INTO stock_movements (id, sku, delta_on_hand, delta_reserved, reason, reference_id, actor, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuidv7(), sku, deltaOnHand, deltaReserved, reason, referenceId, meta.actor, meta.correlationId],
    );
  }

  private async lowStockEvent(m: EntityManager, low: { sku: string; available: number; threshold: number }, meta: RequestMeta) {
    await writeEvent(m, "InventoryLowStock", low, { correlationId: meta.correlationId, causationId: meta.causationId ?? null });
  }

  private async findByKey(key: string): Promise<Reservation> {
    const r = await this.db.getRepository<Reservation>("Reservation").findOne({
      where: { idempotencyKey: key },
      relations: { lines: true },
    });
    if (!r) throw new Error(`reservation for key ${key} vanished`);
    return r;
  }

  private async load(m: EntityManager, id: string): Promise<ReservationView> {
    const r = await m.getRepository<Reservation>("Reservation").findOneOrFail({ where: { id }, relations: { lines: true } });
    return this.toView(r);
  }

  private toView(r: Reservation): ReservationView {
    return {
      id: r.id,
      orderId: r.orderId,
      sagaId: r.sagaId,
      status: r.status,
      lines: [...r.lines].sort((a, b) => a.sku.localeCompare(b.sku)).map((l) => ({ sku: l.sku, quantity: l.quantity })),
      expiresAt: r.expiresAt.toISOString(),
      unavailableLines: r.unavailableLines,
      releaseReason: r.releaseReason,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private rejection(view: ReservationView, replayed: boolean): ProblemException {
    const unknown = (view.unavailableLines ?? []).some((l) => l.available === 0);
    return new ProblemException(409, "INSUFFICIENT_STOCK", "Not enough stock for one or more lines", {
      detail: "Nothing was reserved.",
      extra: {
        reservationId: view.id,
        unavailableLines: view.unavailableLines,
        replayed,
        ...(unknown && { note: "available 0 can also mean the SKU is not stocked at all" }),
      },
    });
  }

  private notConfirmable(r: { status: ReservationStatus; id: string }): ProblemException {
    const code = r.status === ReservationStatus.EXPIRED ? "RESERVATION_EXPIRED" : `RESERVATION_${r.status}`;
    return new ProblemException(409, code, `Reservation is ${r.status.toLowerCase()} and cannot be confirmed`, {
      extra: { reservationId: r.id },
    });
  }
}

interface LockedReservation {
  id: string;
  order_id: string;
  saga_id: string | null;
  status: ReservationStatus;
  expires_at: string;
  lines: { sku: string; quantity: number }[];
}
