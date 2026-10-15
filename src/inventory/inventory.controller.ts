import { Body, Controller, Get, Param, Patch, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiExtraModels, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { Principal } from "../auth/principal";
import { Roles } from "../auth/auth.guard";
import { ProblemException } from "../common/problem.exception";
import { Meta, type RequestMeta } from "../common/request-meta";
import { AdjustStockDto, ListStockQuery, SKU_PATTERN } from "./dto";
import { IdempotencyKey } from "./idempotency-key.decorator";
import { AvailabilityDto, LowStockListDto, MovementListDto, ProblemDto, StockDto, StockListDto } from "./responses";
import { StockService } from "./stock.service";
const problem = (status: number, description: string) =>
  ApiResponse({ status, description, content: { "application/problem+json": { schema: { $ref: getSchemaPath(ProblemDto) } } } });


function validSku(sku: string): string {
  if (!SKU_PATTERN.test(sku)) throw new ProblemException(404, "NOT_FOUND", "Unknown SKU");
  return sku;
}

@ApiTags("stock")
@ApiBearerAuth()
@ApiExtraModels(ProblemDto, StockDto, AvailabilityDto)
@Controller("api/v1/inventory")
export class InventoryController {
  constructor(private readonly stock: StockService) {}

  @Get()
  @Roles("admin")
  @ApiOperation({ summary: "List stock (admin, cursor pagination by SKU)" })
  @ApiOkResponse({ type: StockListDto })
  @problem(400, "Invalid query")
  @problem(401, "Not signed in")
  @problem(403, "Not an admin")
  list(@Query() query: ListStockQuery) {
    return this.stock.list(query).then(({ data, nextCursor }) => ({ data, page: { limit: query.limit, nextCursor } }));
  }

  // Declared before ":sku" so "low-stock" is not captured as a SKU.
  @Get("low-stock")
  @Roles("admin")
  @ApiOperation({ summary: "SKUs at or below their low-stock threshold (admin)" })
  @ApiOkResponse({ type: LowStockListDto })
  @problem(401, "Not signed in")
  @problem(403, "Not an admin")
  async lowStock() {
    return { data: await this.stock.lowStock() };
  }

  @Get(":sku")
  @ApiOperation({ summary: "Availability (public) or full stock record (admin)" })
  @ApiOkResponse({
    description: "Admins get the full stock record; everyone else only availability",
    schema: { oneOf: [{ $ref: getSchemaPath(AvailabilityDto) }, { $ref: getSchemaPath(StockDto) }] },
  })
  @problem(404, "Unknown SKU")
  getOne(@Param("sku") sku: string, @Req() req: Request & { principal?: Principal }) {
    validSku(sku);
    return req.principal?.roles.has("admin") ? this.stock.get(sku) : this.stock.availability(sku);
  }

  @Get(":sku/movements")
  @Roles("admin")
  @ApiOperation({ summary: "Audit history of stock changes for a SKU (admin, newest first)" })
  @ApiOkResponse({ type: MovementListDto })
  @problem(401, "Not signed in")
  @problem(403, "Not an admin")
  @problem(404, "Unknown SKU")
  async movements(@Param("sku") sku: string) {
    return { data: await this.stock.movements(validSku(sku), 200) };
  }

  @Patch(":sku")
  @Roles("admin")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({ summary: "Restock, write off, correct, or set the low-stock threshold (admin, idempotent)" })
  @ApiOkResponse({ type: StockDto, description: "Header Idempotency-Replayed: true on a replay" })
  @problem(400, "Invalid body or missing Idempotency-Key")
  @problem(401, "Not signed in")
  @problem(403, "Not an admin")
  @problem(404, "Unknown SKU")
  @problem(409, "WOULD_UNDERCUT_RESERVATIONS: on hand would drop below what is reserved")
  @problem(422, "IDEMPOTENCY_KEY_REUSED: the key was used for a different adjustment")
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
