import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { ENV, type Env } from "../config/env";
import { InventoryModule } from "../inventory/inventory.module";
import { ReservationService } from "../inventory/reservation.service";
import { createSns, createSqs } from "./aws";
import { CommandConsumer } from "./command-consumer";
import { commandParser } from "./command-schemas";
import { InventoryCommandHandler } from "./inventory-command-handler";
import { OutboxRelay } from "./outbox-relay";

/** Starts the outbox relay and the command consumer with the app, and stops them gracefully. */
@Injectable()
export class MessagingRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MessagingRunner.name);
  readonly relay: OutboxRelay;
  readonly consumer: CommandConsumer;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectDataSource() db: DataSource,
    reservations: ReservationService,
  ) {
    this.relay = new OutboxRelay(db, createSns(env), env.EVENTS_TOPIC_ARN, env.OUTBOX_POLL_INTERVAL_MS);
    this.consumer = new CommandConsumer(
      createSqs(env),
      env.COMMANDS_QUEUE_NAME,
      new InventoryCommandHandler(reservations),
      commandParser(),
      env.CONSUMER_WAIT_TIME_SECONDS,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.env.MESSAGING_ENABLED) {
      this.logger.warn("messaging disabled: outbox rows accumulate and commands are not consumed");
      return;
    }
    this.relay.start();
    this.consumer.start();
    this.logger.log({ topic: this.env.EVENTS_TOPIC_ARN, queue: this.env.COMMANDS_QUEUE_NAME }, "messaging started");
  }

  async onApplicationShutdown(): Promise<void> {
    // Stop taking new commands first, then let the relay finish its current batch.
    await this.consumer.stop();
    await this.relay.stop();
  }
}

@Module({ imports: [InventoryModule], providers: [MessagingRunner], exports: [MessagingRunner] })
export class MessagingModule {}
