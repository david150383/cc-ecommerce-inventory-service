import { MigrationInterface, QueryRunner } from "typeorm";

/** RETURNED: a confirmed reservation whose stock went back on hand because the order was cancelled. */
export class AddReservationReturned1792051200000 implements MigrationInterface {
    name = 'AddReservationReturned1792051200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Allowed inside a transaction since PostgreSQL 12, as long as this transaction does not use the value.
        await queryRunner.query(`ALTER TYPE "public"."reservation_status" ADD VALUE IF NOT EXISTS 'RETURNED'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // PostgreSQL cannot drop an enum value: recreate the type. Fails (on purpose) while RETURNED rows exist.
        await queryRunner.query(`DROP INDEX "public"."uq_reservations_live_order"`);
        await queryRunner.query(`DROP INDEX "public"."ix_reservations_expiry"`);
        await queryRunner.query(`ALTER TYPE "public"."reservation_status" RENAME TO "reservation_status_old"`);
        await queryRunner.query(`CREATE TYPE "public"."reservation_status" AS ENUM('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'REJECTED')`);
        await queryRunner.query(`ALTER TABLE "reservations" ALTER COLUMN "status" TYPE "public"."reservation_status" USING "status"::text::"public"."reservation_status"`);
        await queryRunner.query(`DROP TYPE "public"."reservation_status_old"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_reservations_live_order" ON "reservations" ("order_id") WHERE "status" IN ('ACTIVE', 'CONFIRMED')`);
        await queryRunner.query(`CREATE INDEX "ix_reservations_expiry" ON "reservations" ("expires_at") WHERE "status" = 'ACTIVE'`);
    }

}
