import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `cc_workspace_settings` — the single row holding how inbound conversations are distributed
 * across agents (manual, round-robin, or least-busy), which team receives them, whether offline
 * agents are skipped, and the per-agent open-conversation ceiling.
 *
 * A table rather than env vars because these are shift-time operational decisions a supervisor
 * changes while the gateway is running, not deployment configuration that warrants a restart.
 *
 * Live agent presence is deliberately NOT persisted: it is ephemeral state measured in seconds, and
 * a write per heartbeat per agent would be pure churn to store something that is wrong the moment
 * the process dies (see PresenceService).
 */
export class AddWorkspaceRouting1786500000000 implements MigrationInterface {
  name = 'AddWorkspaceRouting1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('cc_workspace_settings')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';

    await queryRunner.query(
      `CREATE TABLE "cc_workspace_settings" (` +
        `"id" varchar(20) PRIMARY KEY NOT NULL, ` +
        `"routingStrategy" varchar(20) NOT NULL DEFAULT 'manual', ` +
        `"routingTeamId" varchar, ` +
        `"routeToOnlineOnly" boolean NOT NULL DEFAULT ${pg ? 'true' : '(1)'}, ` +
        `"maxOpenPerAgent" integer NOT NULL DEFAULT ${pg ? '0' : '(0)'}, ` +
        `"presenceTimeoutMinutes" integer NOT NULL DEFAULT ${pg ? '5' : '(5)'}, ` +
        `"updatedAt" ${pg ? 'timestamp NOT NULL DEFAULT NOW()' : "datetime NOT NULL DEFAULT (datetime('now'))"})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cc_workspace_settings"`);
  }
}
