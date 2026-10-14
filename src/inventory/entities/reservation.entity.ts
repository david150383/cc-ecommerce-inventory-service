import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

export enum ReservationStatus {
  /** Stock is held until expires_at. */
  ACTIVE = "ACTIVE",
  /** Stock permanently deducted (payment succeeded). */
  CONFIRMED = "CONFIRMED",
  /** Stock returned on request. */
  RELEASED = "RELEASED",
  /** Stock returned because nobody confirmed in time. */
  EXPIRED = "EXPIRED",
  /** Nothing was reserved (insufficient stock). Kept so a retry with the same key gets the same answer. */
  REJECTED = "REJECTED",
}

export interface UnavailableLine {
  sku: string;
  requested: number;
  available: number;
}

@Entity("reservations")
// One idempotency key = one outcome, forever.
@Index("uq_reservations_idempotency_key", ["idempotencyKey"], { unique: true })
// An order may hold at most ONE live reservation; rejected/released ones do not count.
@Index("uq_reservations_live_order", ["orderId"], { unique: true, where: `"status" IN ('ACTIVE', 'CONFIRMED')` })
@Index("ix_reservations_expiry", ["expiresAt"], { where: `"status" = 'ACTIVE'` })
@Check("ck_reservations_expiry_after_creation", `"expires_at" > "created_at"`)
export class Reservation {
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "pk_reservations" })
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @Column({ name: "saga_id", type: "uuid", nullable: true })
  sagaId!: string | null;

  @Column({ name: "idempotency_key", type: "varchar", length: 255 })
  idempotencyKey!: string;

  /** SHA-256 of the canonical request, to detect a key reused for a different request. */
  @Column({ name: "request_hash", type: "char", length: 64 })
  requestHash!: string;

  @Column({ type: "enum", enum: ReservationStatus, enumName: "reservation_status" })
  status!: ReservationStatus;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt!: Date;

  @Column({ name: "unavailable_lines", type: "jsonb", nullable: true })
  unavailableLines!: UnavailableLine[] | null;

  @Column({ name: "release_reason", type: "varchar", length: 50, nullable: true })
  releaseReason!: string | null;

  @OneToMany(() => ReservationLine, (line) => line.reservation, { cascade: ["insert"] })
  lines!: ReservationLine[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("reservation_lines")
@Check("ck_reservation_lines_quantity_positive", `"quantity" > 0`)
export class ReservationLine {
  @PrimaryColumn({ name: "reservation_id", type: "uuid", primaryKeyConstraintName: "pk_reservation_lines" })
  reservationId!: string;

  @PrimaryColumn({ type: "varchar", length: 64, primaryKeyConstraintName: "pk_reservation_lines" })
  sku!: string;

  @Column({ type: "integer" })
  quantity!: number;

  @ManyToOne(() => Reservation, (r) => r.lines, { onDelete: "CASCADE" })
  @JoinColumn({ name: "reservation_id", foreignKeyConstraintName: "fk_reservation_lines_reservation_id_reservations" })
  reservation!: Reservation;
}
