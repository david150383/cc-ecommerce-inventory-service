import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { Logger } from "@nestjs/common";
import type { DataSource } from "typeorm";
import { sql } from "../database/sql";

interface OutboxRow {
  id: string;
  message_type: string;
  envelope: Record<string, unknown>;
}

/**
 * Publishes committed outbox rows to SNS. Guarantees:
 *  - nothing committed is lost (rows stay until published)
 *  - at-least-once: a crash after Publish but before marking re-publishes the row later;
 *    consumers dedupe on messageId
 *  - several instances can run: rows are claimed with FOR UPDATE SKIP LOCKED
 * Order: by created_at within a batch; consumers must not depend on global ordering.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly db: DataSource,
    private readonly sns: SNSClient,
    private readonly topicArn: string,
    private readonly intervalMs: number,
    private readonly batchSize = 50,
  ) {}

  start(): void {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.publishPending()
        .then(() => undefined)
        .catch((err) => this.logger.error({ err }, "outbox relay tick failed"))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Publishes until the outbox is drained (or a publish fails). Returns how many were published. */
  async publishPending(): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.db.transaction(async (m) => {
        const rows = await sql<OutboxRow>(
          m,
          `SELECT id, message_type, envelope FROM outbox
            WHERE published_at IS NULL
            ORDER BY created_at, id
            LIMIT $1
              FOR UPDATE SKIP LOCKED`,
          [this.batchSize],
        );
        let ok = 0;
        for (const row of rows) {
          try {
            await this.sns.send(
              new PublishCommand({
                TopicArn: this.topicArn,
                Message: JSON.stringify(row.envelope),
                // Filter policies on the subscriptions match on this attribute.
                MessageAttributes: { messageType: { DataType: "String", StringValue: row.message_type } },
              }),
            );
            await sql(m, `UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1`, [row.id]);
            ok++;
          } catch (err) {
            await sql(m, `UPDATE outbox SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
            this.logger.warn({ err, messageId: row.id, messageType: row.message_type }, "publish failed; will retry");
            return { ok, more: false };
          }
        }
        return { ok, more: rows.length === this.batchSize };
      });
      total += published.ok;
      if (!published.more) return total;
    }
  }
}
