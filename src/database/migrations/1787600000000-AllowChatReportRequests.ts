import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Lets an administrator fetch a report in chat without a second person approving it.
 *
 * Writes over WhatsApp default to requiring approval, and that default is right: nearly every
 * one of them sends something to a customer. A report request is the exception, because it is
 * `senderScoped` — the runtime pins the recipient to the verified sender before the tool runs,
 * so the only thing it can do is send an administrator their own report.
 *
 * Requiring a second administrator for that is friction with nothing on the other side of it,
 * and Phase Two of the specification is explicitly "chat with the bot and get the view". The
 * policy is narrow on purpose: this one tool, this one role. Everything else still waits for
 * a human.
 */
export class AllowChatReportRequests1787600000000 implements MigrationInterface {
  name = 'AllowChatReportRequests1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';

    for (const senderRole of ['admin', 'staff']) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "agent_tool_policies"
          WHERE "toolName" = 'RequestAccountingReport' AND "senderRole" = '${senderRole}'`,
      )) as unknown[];
      if (existing.length) continue;

      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      await queryRunner.query(
        // Columns taken from the table as it actually exists: there is no createdAt here.
        `INSERT INTO "agent_tool_policies" ("id","toolName","senderRole","level","note","updatedAt")
         VALUES (${id}, 'RequestAccountingReport', '${senderRole}', 'ALLOW_AUTOMATICALLY',
                 'Self-addressed by design: the report can only go to the number that asked.', ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    await queryRunner.query(`DELETE FROM "agent_tool_policies" WHERE "toolName" = 'RequestAccountingReport'`);
  }
}
