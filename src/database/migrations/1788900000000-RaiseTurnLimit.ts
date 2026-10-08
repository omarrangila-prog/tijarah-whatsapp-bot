import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Raises the per-sender hourly turn cap from 30 to 120.
 *
 * 30 was set before anyone had composed a document in chat. Doing that is a dozen short
 * messages — the type, the party, the date, each line, submit — so on 8 October a client
 * composing a purchase invoice hit the cap mid-draft and was answered "You have sent a lot of
 * messages in a short time", with the invoice left half-finished and nothing explaining it.
 *
 * The cap exists to bound a runaway loop, not to ration a working session, and 120 still does
 * that. Only the stored row is raised, and only where it is still the old default: a
 * deployment that has deliberately chosen its own number keeps it.
 */
export class RaiseTurnLimit1788900000000 implements MigrationInterface {
  name = 'RaiseTurnLimit1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_settings'))) return;
    await queryRunner.query(
      `UPDATE "agent_settings" SET "maxTurnsPerSenderPerHour" = 120 WHERE "maxTurnsPerSenderPerHour" = 30`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_settings'))) return;
    await queryRunner.query(
      `UPDATE "agent_settings" SET "maxTurnsPerSenderPerHour" = 30 WHERE "maxTurnsPerSenderPerHour" = 120`,
    );
  }
}
