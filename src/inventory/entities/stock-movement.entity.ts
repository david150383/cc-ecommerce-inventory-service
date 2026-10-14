import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

export type MovementReason =
  | "RESTOCK"
  | "RETURN"
  | "DAMAGED"
  | "CORRECTION"
  | "RESERVED"
  | "RESERVATION_CONFIRMED"
  | "RESERVATION_RELEASED"
  | "RESERVATION_EXPIRED";

/** Append-only audit trail: every change to on_hand or reserved writes one row. */
@Entity("stock_movements")
@Index("ix_stock_movements_sku_created", ["sku", "createdAt"])
export class StockMovement {
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "pk_stock_movements" })
  id!: string;

  @Column({ type: "varchar", length: 64 })
  sku!: string;

  @Column({ name: "delta_on_hand", type: "integer" })
  deltaOnHand!: number;

  @Column({ name: "delta_reserved", type: "integer" })
  deltaReserved!: number;

  @Column({ type: "varchar", length: 30 })
  reason!: MovementReason;

  /** Reservation id, or the idempotency key of an admin adjustment. */
  @Column({ name: "reference_id", type: "varchar", length: 255, nullable: true })
  referenceId!: string | null;

  /** Token subject (admin user id or service name). */
  @Column({ type: "varchar", length: 255, nullable: true })
  actor!: string | null;

  @Column({ name: "correlation_id", type: "varchar", length: 128, nullable: true })
  correlationId!: string | null;

  @Column({ type: "varchar", length: 500, nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
