import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

/** Transactional outbox: written in the same transaction as the stock change; published by a relay (Phase 3). */
@Entity("outbox")
@Index("ix_outbox_unpublished", ["createdAt"], { where: `"published_at" IS NULL` })
export class OutboxMessage {
  @PrimaryColumn({ type: "uuid", primaryKeyConstraintName: "pk_outbox" })
  id!: string;

  @Column({ name: "message_type", type: "varchar", length: 100 })
  messageType!: string;

  @Column({ type: "jsonb" })
  envelope!: unknown;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;

  @Column({ type: "integer", default: 0 })
  attempts!: number;
}
