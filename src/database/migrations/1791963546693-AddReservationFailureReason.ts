import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReservationFailureReason1791963546693 implements MigrationInterface {
    name = 'AddReservationFailureReason1791963546693'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "reservations" ADD "failure_reason" character varying(30)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "reservations" DROP COLUMN "failure_reason"`);
    }

}
