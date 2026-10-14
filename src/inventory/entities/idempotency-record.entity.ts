import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

/** Stored outcome of an idempotent admin request (stock adjustments). */
@Entity("idempotency_records")
export class IdempotencyRecord {
  @PrimaryColumn({ type: "varchar", length: 300, primaryKeyConstraintName: "pk_idempotency_records" })
  key!: string;

  @Column({ name: "request_hash", type: "char", length: 64 })
  requestHash!: string;

  @Column({ name: "status_code", type: "integer", nullable: true })
  statusCode!: number | null;

  @Column({ name: "response_body", type: "jsonb", nullable: true })
  responseBody!: unknown;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
