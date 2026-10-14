import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialInventorySchema1791958927166 implements MigrationInterface {
    name = 'InitialInventorySchema1791958927166'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "idempotency_records" ("key" character varying(300) NOT NULL, "request_hash" character(64) NOT NULL, "status_code" integer, "response_body" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_idempotency_records" PRIMARY KEY ("key"))`);
        await queryRunner.query(`CREATE TYPE "public"."reservation_status" AS ENUM('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'REJECTED')`);
        await queryRunner.query(`CREATE TABLE "reservations" ("id" uuid NOT NULL, "order_id" uuid NOT NULL, "saga_id" uuid, "idempotency_key" character varying(255) NOT NULL, "request_hash" character(64) NOT NULL, "status" "public"."reservation_status" NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "unavailable_lines" jsonb, "release_reason" character varying(50), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_reservations_expiry_after_creation" CHECK ("expires_at" > "created_at"), CONSTRAINT "pk_reservations" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_reservations_expiry" ON "reservations"  ("expires_at") WHERE "status" = 'ACTIVE'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_reservations_live_order" ON "reservations"  ("order_id") WHERE "status" IN ('ACTIVE', 'CONFIRMED')`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_reservations_idempotency_key" ON "reservations"  ("idempotency_key") `);
        await queryRunner.query(`CREATE TABLE "reservation_lines" ("reservation_id" uuid NOT NULL, "sku" character varying(64) NOT NULL, "quantity" integer NOT NULL, CONSTRAINT "ck_reservation_lines_quantity_positive" CHECK ("quantity" > 0), CONSTRAINT "pk_reservation_lines" PRIMARY KEY ("reservation_id", "sku"))`);
        await queryRunner.query(`CREATE TABLE "stock_items" ("sku" character varying(64) NOT NULL, "on_hand" integer NOT NULL DEFAULT '0', "reserved" integer NOT NULL DEFAULT '0', "low_stock_threshold" integer NOT NULL DEFAULT '5', "version" integer NOT NULL DEFAULT '1', "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "ck_stock_items_sku_format" CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9-]{2,63}$'), CONSTRAINT "ck_stock_items_reserved_within_on_hand" CHECK ("reserved" <= "on_hand"), CONSTRAINT "ck_stock_items_reserved_non_negative" CHECK ("reserved" >= 0), CONSTRAINT "ck_stock_items_on_hand_non_negative" CHECK ("on_hand" >= 0), CONSTRAINT "pk_stock_items" PRIMARY KEY ("sku"))`);
        await queryRunner.query(`CREATE TABLE "stock_movements" ("id" uuid NOT NULL, "sku" character varying(64) NOT NULL, "delta_on_hand" integer NOT NULL, "delta_reserved" integer NOT NULL, "reason" character varying(30) NOT NULL, "reference_id" character varying(255), "actor" character varying(255), "correlation_id" character varying(128), "note" character varying(500), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "pk_stock_movements" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_stock_movements_sku_created" ON "stock_movements"  ("sku", "created_at") `);
        await queryRunner.query(`CREATE TABLE "outbox" ("id" uuid NOT NULL, "message_type" character varying(100) NOT NULL, "envelope" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "pk_outbox" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_outbox_unpublished" ON "outbox"  ("created_at") WHERE "published_at" IS NULL`);
        await queryRunner.query(`ALTER TABLE "reservation_lines" ADD CONSTRAINT "fk_reservation_lines_reservation_id_reservations" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "reservation_lines" DROP CONSTRAINT "fk_reservation_lines_reservation_id_reservations"`);
        await queryRunner.query(`DROP INDEX "public"."ix_outbox_unpublished"`);
        await queryRunner.query(`DROP TABLE "outbox"`);
        await queryRunner.query(`DROP INDEX "public"."ix_stock_movements_sku_created"`);
        await queryRunner.query(`DROP TABLE "stock_movements"`);
        await queryRunner.query(`DROP TABLE "stock_items"`);
        await queryRunner.query(`DROP TABLE "reservation_lines"`);
        await queryRunner.query(`DROP INDEX "public"."uq_reservations_idempotency_key"`);
        await queryRunner.query(`DROP INDEX "public"."uq_reservations_live_order"`);
        await queryRunner.query(`DROP INDEX "public"."ix_reservations_expiry"`);
        await queryRunner.query(`DROP TABLE "reservations"`);
        await queryRunner.query(`DROP TYPE "public"."reservation_status"`);
        await queryRunner.query(`DROP TABLE "idempotency_records"`);
    }

}
