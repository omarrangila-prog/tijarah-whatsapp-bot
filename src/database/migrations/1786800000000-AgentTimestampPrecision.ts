import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives the agent tables' `createdAt` millisecond precision on SQLite.
 *
 * AddAgentChannel created these as `@CreateDateColumn()`, which on SQLite writes
 * 'YYYY-MM-DD HH:MM:SS' — whole seconds. `createdAt` is the sort key for the audit trail
 * (`recentTurns`), for the pending-approval lookup that decides which prepared action an
 * APPROVE refers to, and for the event queue. At second precision two rows written in the
 * same second came back in arbitrary order, so an audit trail could not say whether the
 * approval came before or after the send, and a burst of approvals could resolve to the
 * wrong one.
 *
 * The entities now use the repo's cross-dialect pattern (`dateColumnType` +
 * `DateTransformer`), which stores ISO-8601 text on SQLite — where lexicographic order is
 * chronological order — and a native `timestamp` on Postgres, which already had microsecond
 * precision and needs nothing.
 *
 * This migration only rewrites the rows already on disk. Mixing the two formats in one
 * column would be worse than either alone: 'T' sorts above ' ', so every new row would sort
 * above every old one regardless of when it happened.
 *
 * The SQLite column keeps its declared `datetime` type and its `datetime('now')` default.
 * The declared type is NUMERIC affinity, under which neither format parses as a number, so
 * both are stored as TEXT and compared as TEXT — the rewrite below is what makes the order
 * correct, not the declaration. The default now only matters to a raw SQL insert that omits
 * the column, and nothing in the codebase does that.
 */
export class AgentTimestampPrecision1786800000000 implements MigrationInterface {
  name = 'AgentTimestampPrecision1786800000000';

  private static readonly TABLES = ['agent_turns', 'agent_approvals', 'agent_events', 'agent_admin_numbers'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type === 'postgres') return;

    for (const table of AgentTimestampPrecision1786800000000.TABLES) {
      if (!(await queryRunner.hasTable(table))) continue;
      /*
       * 'YYYY-MM-DD HH:MM:SS' (UTC, as SQLite's datetime('now') and the driver both write it)
       * becomes 'YYYY-MM-DDTHH:MM:SS.000Z'. Rows already carrying a 'T' are left alone, which
       * also makes the migration safe to run twice.
       */
      await queryRunner.query(
        `UPDATE "${table}" SET "createdAt" = replace("createdAt", ' ', 'T') || '.000Z' ` +
          `WHERE "createdAt" IS NOT NULL AND "createdAt" NOT LIKE '%T%'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type === 'postgres') return;

    for (const table of AgentTimestampPrecision1786800000000.TABLES) {
      if (!(await queryRunner.hasTable(table))) continue;
      // Back to whole seconds: drop the milliseconds and the zone marker, restore the space.
      await queryRunner.query(
        `UPDATE "${table}" SET "createdAt" = replace(substr("createdAt", 1, 19), 'T', ' ') ` +
          `WHERE "createdAt" IS NOT NULL AND "createdAt" LIKE '%T%'`,
      );
    }
  }
}
