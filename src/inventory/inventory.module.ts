import { Module } from "@nestjs/common";
import { DatabaseHealth } from "../database/database-health";
import { ExpiryScheduler } from "./expiry.scheduler";
import { InventoryController } from "./inventory.controller";
import { ReservationService } from "./reservation.service";
import { ReservationsController } from "./reservations.controller";
import { StockService } from "./stock.service";

@Module({
  // ReservationsController first: GET /inventory/reservations/:id must win over /inventory/:sku/...
  controllers: [ReservationsController, InventoryController],
  providers: [StockService, ReservationService, ExpiryScheduler, DatabaseHealth],
  exports: [StockService, ReservationService],
})
export class InventoryModule {}
