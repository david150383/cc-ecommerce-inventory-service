import type { EntityManager } from "typeorm";

/**
 * Runs raw SQL and ALWAYS returns the result rows.
 *
 * Why: TypeORM's `manager.query()` returns rows for SELECT but `[rows, affectedCount]` for
 * UPDATE/DELETE ... RETURNING. An UPDATE that matched nothing then yields `[[], 0]`, whose
 * first element `[]` is truthy, which made a failed conditional reservation look successful
 * (found by the overselling tests). The structured-result API is consistent for every statement.
 */
export async function sql<T = Record<string, unknown>>(m: EntityManager, text: string, params: unknown[] = []): Promise<T[]> {
  const runner = m.queryRunner ?? m.connection.createQueryRunner();
  try {
    const result = await runner.query(text, params, true);
    return result.records as T[];
  } finally {
    if (!m.queryRunner) await runner.release();
  }
}
