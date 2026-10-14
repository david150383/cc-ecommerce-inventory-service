import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import { ReservationService } from "./reservation.service";

/** Periodically releases expired reservations. Safe to run on every instance (SKIP LOCKED). */
@Injectable()
export class ExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ExpiryScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly reservations: ReservationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.EXPIRY_SWEEP_INTERVAL_MS === 0) return;
    this.timer = setInterval(() => void this.sweep(), this.env.EXPIRY_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.running) return; // never overlap with a slow previous sweep
    this.running = true;
    try {
      const released = await this.reservations.expireDue();
      if (released > 0) this.logger.log({ released }, "expired reservations released");
    } catch (err) {
      this.logger.error({ err }, "expiry sweep failed");
    } finally {
      this.running = false;
    }
  }
}
