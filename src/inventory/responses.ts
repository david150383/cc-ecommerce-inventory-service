import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ReservationStatus } from "./entities/reservation.entity";

// Response shapes, for the OpenAPI document only (the services return plain objects of these shapes; the
// drift test in test/openapi.spec.ts and the response tests keep the two in step).

export class StockDto {
  @ApiProperty({ example: "TEE-CLASSIC-BLK-M" }) sku!: string;
  @ApiProperty({ minimum: 0 }) onHand!: number;
  @ApiProperty({ minimum: 0 }) reserved!: number;
  @ApiProperty({ description: "onHand - reserved" }) available!: number;
  @ApiProperty({ minimum: 0 }) lowStockThreshold!: number;
  @ApiProperty() lowStock!: boolean;
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}

/** What anonymous visitors and customers see: no warehouse numbers. */
export class AvailabilityDto {
  @ApiProperty({ example: "TEE-CLASSIC-BLK-M" }) sku!: string;
  @ApiProperty({ description: "Units that can still be ordered (0 when out of stock)" }) available!: number;
  @ApiProperty() inStock!: boolean;
}

export class CursorPageDto {
  @ApiProperty() limit!: number;
  @ApiProperty({ type: String, nullable: true, description: "Pass as `cursor` for the next page; null on the last page" }) nextCursor!: string | null;
}

export class StockListDto {
  @ApiProperty({ type: [StockDto] }) data!: StockDto[];
  @ApiProperty({ type: CursorPageDto }) page!: CursorPageDto;
}

export class LowStockListDto {
  @ApiProperty({ type: [StockDto] }) data!: StockDto[];
}

export class MovementDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty() deltaOnHand!: number;
  @ApiProperty() deltaReserved!: number;
  @ApiProperty({
    enum: ["RESTOCK", "RETURN", "DAMAGED", "CORRECTION", "RESERVED", "RESERVATION_CONFIRMED", "RESERVATION_RELEASED", "RESERVATION_EXPIRED", "RESERVATION_RETURNED"],
  })
  reason!: string;
  @ApiProperty({ type: String, nullable: true, description: "Reservation id or adjustment key" }) referenceId!: string | null;
  @ApiProperty({ type: String, nullable: true }) actor!: string | null;
  @ApiProperty({ type: String, nullable: true }) correlationId!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

export class MovementListDto {
  @ApiProperty({ type: [MovementDto] }) data!: MovementDto[];
}

export class ReservedLineDto {
  @ApiProperty() sku!: string;
  @ApiProperty({ minimum: 1 }) quantity!: number;
}

export class UnavailableLineDto {
  @ApiProperty() sku!: string;
  @ApiProperty() requested!: number;
  @ApiProperty() available!: number;
}

export class ReservationDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) orderId!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) sagaId!: string | null;
  @ApiProperty({ enum: ReservationStatus, enumName: "ReservationStatus" }) status!: ReservationStatus;
  @ApiProperty({ type: [ReservedLineDto] }) lines!: ReservedLineDto[];
  @ApiProperty({ format: "date-time" }) expiresAt!: string;
  @ApiProperty({ type: [UnavailableLineDto], nullable: true }) unavailableLines!: UnavailableLineDto[] | null;
  @ApiProperty({ type: String, nullable: true }) releaseReason!: string | null;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}

export class ReservationEnvelopeDto {
  @ApiProperty({ type: ReservationDto }) reservation!: ReservationDto;
}

export class FieldErrorDto {
  @ApiProperty() path!: string;
  @ApiProperty() message!: string;
}

/** RFC 9457 problem+json (see conventions.md). Extra members depend on `code`. */
export class ProblemDto {
  @ApiProperty({ example: "https://errors.ecommerce.local/not-found" }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: number;
  @ApiProperty({ example: "NOT_FOUND" }) code!: string;
  @ApiPropertyOptional() detail?: string;
  @ApiProperty() instance!: string;
  @ApiProperty() correlationId!: string;
  @ApiPropertyOptional({ type: [FieldErrorDto] }) errors?: FieldErrorDto[];
}
