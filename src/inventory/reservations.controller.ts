import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Roles } from "../auth/auth.guard";
import { Meta, type RequestMeta } from "../common/request-meta";
import { CreateReservationDto } from "./dto";
import { IdempotencyKey } from "./idempotency-key.decorator";
import { ReservationService } from "./reservation.service";

// The saga uses SQS commands (Phase 3) that call the same ReservationService;
// these REST endpoints serve operations, admin tools and tests.
@ApiTags("reservations")
@ApiBearerAuth()
@Controller("api/v1/inventory/reservations")
export class ReservationsController {
  constructor(private readonly reservations: ReservationService) {}

  @Post()
  @Roles("service", "admin")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Reserve stock for an order (all lines or none). 201 new, 200 replay, 409 insufficient" })
  async create(
    @Body() body: CreateReservationDto,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { reservation, replayed } = await this.reservations.reserve(
      key,
      { orderId: body.orderId, sagaId: body.sagaId ?? null, lines: body.lines, ...(body.ttlSeconds && { ttlSeconds: body.ttlSeconds }) },
      meta,
    );
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotency-Replayed", "true");
    else res.setHeader("Location", `/api/v1/inventory/reservations/${reservation.id}`);
    return { reservation };
  }

  @Get(":id")
  @Roles("service", "admin")
  @ApiOperation({ summary: "Reservation state" })
  async get(@Param("id", new ParseUUIDPipe()) id: string) {
    return { reservation: await this.reservations.get(id) };
  }

  @Post(":id/confirm")
  @HttpCode(200)
  @Roles("service")
  @ApiOperation({ summary: "Deduct reserved stock permanently (idempotent). 409 if expired or released" })
  async confirm(@Param("id", new ParseUUIDPipe()) id: string, @Meta() meta: RequestMeta) {
    return { reservation: await this.reservations.confirm(id, meta) };
  }

  @Post(":id/release")
  @HttpCode(200)
  @Roles("service", "admin")
  @ApiOperation({ summary: "Return reserved stock (idempotent). 409 if already confirmed" })
  async release(@Param("id", new ParseUUIDPipe()) id: string, @Meta() meta: RequestMeta) {
    return { reservation: await this.reservations.release(id, meta) };
  }
}
