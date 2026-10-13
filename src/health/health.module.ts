import { Global, Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { ReadinessService } from "./readiness.service";

@Global()
@Module({
  controllers: [HealthController],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class HealthModule {}
