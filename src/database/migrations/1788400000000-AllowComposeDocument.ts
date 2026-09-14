import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * The one-step compose tool joins the same policy as the step-by-step ones.
 *
 * Same reasoning as AllowDraftComposition: it is sender-scoped, so it can only touch the
 * composer's own draft, and it submits nothing — the approval screen remains the human gate.
 */
export class AllowComposeDocument1788400000000 implements MigrationInterface {
  name = 'AllowComposeDocument1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    for (const senderRole of ['admin', 'staff']) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "agent_tool_policies" WHERE "toolName" = 'ComposeDocument' AND "senderRole" = '${senderRole}'`,
      )) as unknown[];
      if (existing.length) continue;
      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      await queryRunner.query(
        `INSERT INTO "agent_tool_policies" ("id","toolName","senderRole","level","note","updatedAt")
         VALUES (${id}, 'ComposeDocument', '${senderRole}', 'ALLOW_AUTOMATICALLY',
                 'Sender-scoped: composes the caller''s own draft. Submission is a separate, later step.', ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    await queryRunner.query(`DELETE FROM "agent_tool_policies" WHERE "toolName" = 'ComposeDocument'`);
  }
}
