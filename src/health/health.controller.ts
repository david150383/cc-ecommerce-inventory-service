import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Response } from "express";
import { ReadinessService } from "./readiness.service";

@ApiExcludeController()
@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res() res: Response): Promise<void> {
    const { ready, checks } = await this.readiness.evaluate();
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ready ? "ready" : "not_ready",
      checks,
    });
  }
}
