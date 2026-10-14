import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
} from "class-validator";

export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

// One class = runtime validation (class-validator) + OpenAPI schema (@nestjs/swagger).

export class ReservationLineDto {
  @ApiProperty({ example: "TEE-CLASSIC-BLK-M" })
  @Matches(SKU_PATTERN, { message: "sku must match ^[A-Z0-9][A-Z0-9-]{2,63}$" })
  sku!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 1000 })
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity!: number;
}

export class CreateReservationDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  orderId!: string;

  @ApiPropertyOptional({ format: "uuid", nullable: true })
  @IsOptional()
  @IsUUID()
  sagaId?: string;

  @ApiProperty({ type: [ReservationLineDto] })
  @ValidateNested({ each: true })
  @Type(() => ReservationLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  lines!: ReservationLineDto[];

  @ApiPropertyOptional({ example: 2700, minimum: 60, maximum: 86400, description: "Default 2700 (45 min)" })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86_400)
  ttlSeconds?: number;
}

export class AdjustStockDto {
  @ApiPropertyOptional({ example: 50, description: "Change to on_hand (negative for write-offs). Requires reason." })
  @IsOptional()
  @IsInt()
  @NotEquals(0)
  @Min(-100_000)
  @Max(100_000)
  delta?: number;

  @ApiPropertyOptional({ enum: ["RESTOCK", "RETURN", "DAMAGED", "CORRECTION"] })
  @IsOptional()
  @IsIn(["RESTOCK", "RETURN", "DAMAGED", "CORRECTION"])
  reason?: "RESTOCK" | "RETURN" | "DAMAGED" | "CORRECTION";

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ example: 5, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  lowStockThreshold?: number;
}

export class ListStockQuery {
  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ description: "nextCursor from the previous page" })
  @IsOptional()
  @Matches(SKU_PATTERN)
  cursor?: string;

  @ApiPropertyOptional({ example: "TEE-" })
  @IsOptional()
  @Matches(/^[A-Z0-9-]{1,64}$/)
  skuPrefix?: string;
}
