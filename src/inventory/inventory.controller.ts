import { Body, Controller, Get, Param, Patch, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { Principal } from "../auth/principal";
import { Roles } from "../auth/auth.guard";
import { ProblemException } from "../common/problem.exception";
import { Meta, type RequestMeta } from "../common/request-meta";
import { AdjustStockDto, ListStockQuery, SKU_PATTERN } from "./dto";
import { IdempotencyKey } from "./idempotency-key.decorator";
import { StockService } from "./stock.service";

function validSku(sku: string): string {
  if (!SKU_PATTERN.test(sku)) throw new ProblemException(404, "NOT_FOUND", "Unknown SKU");
  return sku;
}

@ApiTags("stock")
@ApiBearerAuth()
@Controller("api/v1/inventory")
export class InventoryController {
  constructor(private readonly stock: StockService) {}

  @Get()
  @Roles("admin")
  @ApiOperation({ summary: "List stock (admin, cursor pagination by SKU)" })
  list(@Query() query: ListStockQuery) {
    return this.stock.list(query).then(({ data, nextCursor }) => ({ data, page: { limit: query.limit, nextCursor } }));
  }

  // Declared before ":sku" so "low-stock" is not captured as a SKU.
  @Get("low-stock")
  @Roles("admin")
  @ApiOperation({ summary: "SKUs at or below their low-stock threshold (admin)" })
  async lowStock() {
    return { data: await this.stock.lowStock() };
  }

  @Get(":sku")
  @ApiOperation({ summary: "Availability (public) or full stock record (admin)" })
  getOne(@Param("sku") sku: string, @Req() req: Request & { principal?: Principal }) {
    validSku(sku);
    return req.principal?.roles.has("admin") ? this.stock.get(sku) : this.stock.availability(sku);
  }

  @Get(":sku/movements")
  @Roles("admin")
  @ApiOperation({ summary: "Audit history of stock changes for a SKU (admin, newest first)" })
  async movements(@Param("sku") sku: string) {
    return { data: await this.stock.movements(validSku(sku), 200) };
  }

  @Patch(":sku")
  @Roles("admin")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Restock, write off, correct, or set the low-stock threshold (admin, idempotent)" })
  async adjust(
    @Param("sku") sku: string,
    @Body() body: AdjustStockDto,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { stock, replayed } = await this.stock.adjust(validSku(sku), key, body, meta);
    if (replayed) res.setHeader("Idempotency-Replayed", "true");
    return stock;
  }
}
