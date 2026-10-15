import { Logger } from "@nestjs/common";
import { ProblemException } from "../common/problem.exception";
import type { RequestMeta } from "../common/request-meta";
import type { ReservationService } from "../inventory/reservation.service";
import { type CommandEnvelope, type CommandHandler, InvalidCommand } from "./command-consumer";

/**
 * Executes inventory commands from the saga. Rule: every command yields exactly one result
 * EVENT, also when it is a duplicate, so a sender that crashed and re-sent still gets its answer.
 */
export class InventoryCommandHandler implements CommandHandler {
  private readonly logger = new Logger(InventoryCommandHandler.name);

  constructor(private readonly reservations: ReservationService) {}

  async handle(cmd: CommandEnvelope): Promise<void> {
    const meta: RequestMeta = { correlationId: cmd.correlationId, actor: "saga-command", causationId: cmd.messageId };
    switch (cmd.messageType) {
      case "InventoryReservationRequested":
        return this.reserve(cmd, meta);
      case "InventoryReservationConfirmRequested":
        return this.confirm(cmd, meta);
      case "InventoryReservationReleaseRequested":
        return this.release(cmd, meta);
      case "InventoryReturnRequested":
        return this.restock(cmd, meta);
      default:
        throw new InvalidCommand(`no handler for ${cmd.messageType}`);
    }
  }

  private async reserve(cmd: CommandEnvelope, meta: RequestMeta): Promise<void> {
    const p = cmd.payload as { orderId: string; lines: { sku: string; quantity: number }[]; ttlSeconds?: number };
    try {
      const { reservation, replayed } = await this.reservations.reserve(
        cmd.idempotencyKey,
        { orderId: p.orderId, sagaId: cmd.sagaId, lines: p.lines, ...(p.ttlSeconds && { ttlSeconds: p.ttlSeconds }) },
        meta,
      );
      // First time: InventoryReserved was written in the reserving transaction. Duplicate: re-emit.
      if (replayed) await this.reservations.emitOutcome(reservation.id, meta);
    } catch (err) {
      if (!(err instanceof ProblemException)) throw err; // infrastructure error: retry
      if (err.code === "INSUFFICIENT_STOCK") {
        // First time: InventoryReservationFailed was written in the rejecting transaction.
        const extra = err.problem.extra as { reservationId: string; replayed: boolean };
        if (extra.replayed) await this.reservations.emitOutcome(extra.reservationId, meta);
        return;
      }
      if (err.code === "ORDER_ALREADY_RESERVED") {
        // Another key already reserved this order: answer with that reservation's state.
        const live = await this.reservations.findLiveByOrder(p.orderId);
        if (live) return this.reservations.emitOutcome(live.id, meta);
      }
      if (err.code === "IDEMPOTENCY_KEY_REUSED") throw new InvalidCommand(err.message);
      throw err;
    }
  }

  private async confirm(cmd: CommandEnvelope, meta: RequestMeta): Promise<void> {
    const p = cmd.payload as { reservationId: string; orderId: string };
    try {
      const before = await this.reservations.get(p.reservationId);
      await this.reservations.confirm(p.reservationId, meta);
      if (before.status === "CONFIRMED" || before.status === "RETURNED") await this.reservations.emitOutcome(p.reservationId, meta); // duplicate
    } catch (err) {
      if (!(err instanceof ProblemException)) throw err;
      if (err.code === "NOT_FOUND") throw new InvalidCommand(`unknown reservation ${p.reservationId}`);
      // Expired, released or rejected: the confirm cannot happen. Tell the saga so it can re-reserve or refund.
      const reason = err.code === "RESERVATION_EXPIRED" ? "RESERVATION_EXPIRED" : "INVALID_REQUEST";
      const view = await this.reservations.get(p.reservationId);
      await this.reservations.emitEvent(
        "InventoryReservationFailed",
        { orderId: p.orderId, reason, unavailableLines: [] },
        { ...meta, sagaId: view.sagaId },
      );
    }
  }

  private async release(cmd: CommandEnvelope, meta: RequestMeta): Promise<void> {
    const p = cmd.payload as { orderId: string; reservationId: string | null; reason: string };
    const reservationId = p.reservationId ?? (await this.reservations.findLiveByOrder(p.orderId))?.id ?? null;
    if (!reservationId) {
      // Nothing was ever reserved (e.g. the saga timed out before the reservation): still answer.
      return this.reservations.emitEvent(
        "InventoryReservationReleased",
        { orderId: p.orderId, reservationId: null, reason: "NOTHING_TO_RELEASE" },
        { ...meta, sagaId: cmd.sagaId },
      );
    }
    try {
      const before = await this.reservations.get(reservationId);
      await this.reservations.release(reservationId, meta);
      if (before.status !== "ACTIVE") await this.reservations.emitOutcome(reservationId, meta); // already released/expired
    } catch (err) {
      if (err instanceof ProblemException && err.code === "RESERVATION_CONFIRMED") {
        // Stock already left the warehouse; releasing would be wrong. Needs a human (or a refund flow).
        this.logger.error({ orderId: p.orderId, reservationId, correlationId: cmd.correlationId }, "release requested for a CONFIRMED reservation");
        return this.reservations.emitOutcome(reservationId, meta);
      }
      if (err instanceof ProblemException && err.code === "NOT_FOUND") throw new InvalidCommand(`unknown reservation ${reservationId}`);
      throw err;
    }
  }

  private async restock(cmd: CommandEnvelope, meta: RequestMeta): Promise<void> {
    const p = cmd.payload as { orderId: string; reservationId: string; reason: string };
    try {
      const { outcome } = await this.reservations.restock(p.reservationId, meta); // writes InventoryReturned
      if (outcome === "NOTHING_TO_RETURN") {
        this.logger.warn({ orderId: p.orderId, reservationId: p.reservationId, correlationId: cmd.correlationId }, "return requested for a reservation that was never confirmed");
      }
    } catch (err) {
      if (err instanceof ProblemException && err.code === "NOT_FOUND") throw new InvalidCommand(`unknown reservation ${p.reservationId}`);
      throw err;
    }
  }
}
