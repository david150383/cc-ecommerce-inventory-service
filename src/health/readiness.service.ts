import { type BeforeApplicationShutdown, Injectable } from "@nestjs/common";

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

// Holds readiness checks registered by other modules (database in Phase 2,
// SQS in Phase 3) and flips to "not ready" as soon as shutdown begins.
@Injectable()
export class ReadinessService implements BeforeApplicationShutdown {
  private readonly checks: ReadinessCheck[] = [];
  private shuttingDown = false;

  register(check: ReadinessCheck): void {
    this.checks.push(check);
  }

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }

  async evaluate(): Promise<{ ready: boolean; checks: Record<string, "ok" | "failed"> }> {
    const all: ReadinessCheck[] = [
      {
        name: "accepting-traffic",
        check: async () => {
          if (this.shuttingDown) throw new Error("shutting down");
        },
      },
      ...this.checks,
    ];
    const results = await Promise.allSettled(all.map((c) => withTimeout(c.check(), CHECK_TIMEOUT_MS)));
    const checks: Record<string, "ok" | "failed"> = {};
    all.forEach((c, i) => {
      checks[c.name] = results[i]?.status === "fulfilled" ? "ok" : "failed";
    });
    return { ready: Object.values(checks).every((s) => s === "ok"), checks };
  }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
