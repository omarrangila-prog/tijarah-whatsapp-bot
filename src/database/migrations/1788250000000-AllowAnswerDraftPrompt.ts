import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Adds the policy for `AnswerDraftPrompt`, which arrived after the first draft policies ran.
 *
 * A separate migration rather than an edit to the previous one: that migration has already
 * been applied, so changing its list would leave a database that ran the old version without
 * the new policy and no way to notice.
 *
 * The tool is the conversational primitive — a person answering the question in front of them
 * rather than naming a field. It is sender-scoped and writes to the composer's own draft, so
 * it carries exactly the same reasoning as the rest.
 */
export class AllowAnswerDraftPrompt1788250000000 implements MigrationInterface {
  name = 'AllowAnswerDraftPrompt1788250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';

    for (const senderRole of ['admin', 'staff']) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "agent_tool_policies"
          WHERE "toolName" = 'AnswerDraftPrompt' AND "senderRole" = '${senderRole}'`,
      )) as unknown[];
      if (existing.length) continue;

      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      await queryRunner.query(
        `INSERT INTO "agent_tool_policies" ("id","toolName","senderRole","level","note","updatedAt")
         VALUES (${id}, 'AnswerDraftPrompt', '${senderRole}', 'ALLOW_AUTOMATICALLY',
                 'Sender-scoped: applies a value to the composer''s own draft.', ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    await queryRunner.query(`DELETE FROM "agent_tool_policies" WHERE "toolName" = 'AnswerDraftPrompt'`);
  }
}
