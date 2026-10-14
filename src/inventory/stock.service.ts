import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, type EntityManager } from "typeorm";
import { v7 as uuidv7 } from "uuid";
import { ProblemException } from "../common/problem.exception";
import type { RequestMeta } from "../common/request-meta";
import { writeEvent } from "../outbox/outbox";
import { sql } from "../database/sql";

export type AdjustmentReason = "RESTOCK" | "RETURN" | "DAMAGED" | "CORRECTION";

export interface AdjustInput {
  delta?: number;
  reason?: AdjustmentReason;
  note?: string;
  lowStockThreshold?: number;
}

export interface StockView {
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  lowStock: boolean;
  updatedAt: string;
}

export interface AvailabilityView {
  sku: string;
  available: number;
  inStock: boolean;
}

interface StockRow {
  sku: string;
  on_hand: number;
  reserved: number;
  low_stock_threshold: number;
  updated_at: Date;
}

const toView = (r: StockRow): StockView => {
  const available = r.on_hand - r.reserved;
  return {
    sku: r.sku,
    onHand: r.on_hand,
    reserved: r.reserved,
    available,
    lowStockThreshold: r.low_stock_threshold,
    lowStock: available <= r.low_stock_threshold,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
};

@Injectable()
export class StockService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Keyset pagination by SKU: stable and cheap at any depth. */
  async list(opts: { limit: number; cursor?: string; skuPrefix?: string }): Promise<{ data: StockView[]; nextCursor: string | null }> {
    const rows: StockRow[] = await sql(this.db.manager, 
      `SELECT sku, on_hand, reserved, low_stock_threshold, updated_at FROM stock_items
        WHERE ($1::text IS NULL OR sku > $1)
          AND ($2::text IS NULL OR sku LIKE $2 || '%')
        ORDER BY sku
        LIMIT $3`,
      [opts.cursor ?? null, opts.skuPrefix?.replace(/[%_\\]/g, "\\$&") ?? null, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit);
    return { data: page.map(toView), nextCursor: hasMore ? page[page.length - 1]!.sku : null };
  }

  async lowStock(): Promise<StockView[]> {
    const rows: StockRow[] = await sql(this.db.manager, 
      `SELECT sku, on_hand, reserved, low_stock_threshold, updated_at FROM stock_items
        WHERE on_hand - reserved <= low_stock_threshold
        ORDER BY on_hand - reserved, sku`,
    );
    return rows.map(toView);
  }

  async get(sku: string): Promise<StockView> {
    const rows: StockRow[] = await sql(this.db.manager, 
      `SELECT sku, on_hand, reserved, low_stock_threshold, updated_at FROM stock_items WHERE sku = $1`,
      [sku],
    );
    if (!rows[0]) throw new ProblemException(404, "NOT_FOUND", "No stock record for this SKU");
    return toView(rows[0]);
  }

  /** Public view: unknown SKUs are simply "not in stock", not an error. */
  async availability(sku: string): Promise<AvailabilityView> {
    const rows: { available: number }[] = await sql(this.db.manager, 
      `SELECT on_hand - reserved AS available FROM stock_items WHERE sku = $1`,
      [sku],
    );
    const available = rows[0]?.available ?? 0;
    return { sku, available, inStock: available > 0 };
  }

  /**
   * Restock / write-off / correction and threshold changes, idempotent per key.
   * Returns the stored response when the same key is replayed.
   */
  async adjust(
    sku: string,
    idempotencyKey: string,
    input: AdjustInput,
    meta: RequestMeta,
  ): Promise<{ stock: StockView; replayed: boolean }> {
    if (input.delta === undefined && input.lowStockThreshold === undefined) {
      throw new ProblemException(400, "VALIDATION_FAILED", "Provide delta and/or lowStockThreshold");
    }
    if (input.delta !== undefined && (input.delta === 0 || !input.reason)) {
      throw new ProblemException(400, "VALIDATION_FAILED", "delta must be non-zero and needs a reason");
    }
    const key = `adjust:${sku}:${idempotencyKey}`;
    const hash = createHash("sha256").update(JSON.stringify({ sku, ...input })).digest("hex");

    return this.db.transaction(async (m) => {
      const claimed: unknown[] = await sql(m, 
        `INSERT INTO idempotency_records (key, request_hash) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key, hash],
      );
      if (claimed.length === 0) {
        const [prior]: { request_hash: string; response_body: StockView }[] = await sql(m, 
          `SELECT request_hash, response_body FROM idempotency_records WHERE key = $1`,
          [key],
        );
        if (prior!.request_hash !== hash) {
          throw new ProblemException(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different request");
        }
        return { stock: prior!.response_body, replayed: true };
      }

      const stock = await this.applyAdjustment(m, sku, key, input, meta);
      await sql(m, `UPDATE idempotency_records SET status_code = 200, response_body = $2 WHERE key = $1`, [
        key,
        JSON.stringify(stock),
      ]);
      return { stock, replayed: false };
    });
  }

  private async applyAdjustment(
    m: EntityManager,
    sku: string,
    key: string,
    input: AdjustInput,
    meta: RequestMeta,
  ): Promise<StockView> {
    const existing: StockRow[] = await sql(m, 
      `SELECT sku, on_hand, reserved, low_stock_threshold, updated_at FROM stock_items WHERE sku = $1 FOR UPDATE`,
      [sku],
    );
    let before = existing[0];
    if (!before) {
      if ((input.delta ?? 0) < 0) throw new ProblemException(404, "NOT_FOUND", "No stock record for this SKU");
      // First receipt of a new SKU creates its stock record.
      const created: StockRow[] = await sql(m, 
        `INSERT INTO stock_items (sku) VALUES ($1) RETURNING sku, on_hand, reserved, low_stock_threshold, updated_at`,
        [sku],
      );
      before = created[0]!;
    }

    const delta = input.delta ?? 0;
    if (before.on_hand + delta < before.reserved) {
      throw new ProblemException(409, "WOULD_UNDERCUT_RESERVATIONS", "on_hand cannot drop below reserved stock", {
        detail: `on_hand ${before.on_hand}, reserved ${before.reserved}: at most ${before.on_hand - before.reserved} can be removed.`,
      });
    }

    const [after]: StockRow[] = await sql(m, 
      `UPDATE stock_items
          SET on_hand = on_hand + $2,
              low_stock_threshold = COALESCE($3, low_stock_threshold),
              version = version + 1, updated_at = now()
        WHERE sku = $1
    RETURNING sku, on_hand, reserved, low_stock_threshold, updated_at`,
      [sku, delta, input.lowStockThreshold ?? null],
    );

    if (delta !== 0) {
      await sql(m, 
        `INSERT INTO stock_movements (id, sku, delta_on_hand, delta_reserved, reason, reference_id, actor, correlation_id, note)
         VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8)`,
        [uuidv7(), sku, delta, input.reason, key, meta.actor, meta.correlationId, input.note ?? null],
      );
    }

    const wasLow = before.on_hand - before.reserved <= before.low_stock_threshold;
    const view = toView(after!);
    if (view.lowStock && !wasLow) {
      await writeEvent(m, "InventoryLowStock", { sku, available: view.available, threshold: view.lowStockThreshold }, {
        correlationId: meta.correlationId,
      });
    }
    return view;
  }

  async movements(sku: string, limit: number) {
    return sql(this.db.manager, 
      `SELECT id, delta_on_hand AS "deltaOnHand", delta_reserved AS "deltaReserved", reason,
              reference_id AS "referenceId", actor, correlation_id AS "correlationId", note, created_at AS "createdAt"
         FROM stock_movements WHERE sku = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [sku, limit],
    );
  }
}
