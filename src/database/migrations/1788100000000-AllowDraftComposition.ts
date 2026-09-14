import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Lets an administrator compose and submit a document in chat without a second approval here.
 *
 * Every one of these tools is `senderScoped`, so the most any of them can touch is the draft
 * belonging to the number using it. Composing one writes a local row and reaches nothing.
 *
 * `SubmitDraftForApproval` is included deliberately, and it is the one worth explaining. It
 * does leave the building — but what it creates is a PENDING record on Tijarah Books' approval
 * screen, where a person accepts or rejects it. That screen IS the human gate the
 * specification asks for. Requiring a second administrator to approve *putting something in
 * front of an approver* is friction with nothing behind it, and it would make Phase Three
 * unusable in the conversation it exists for.
 *
 * What stays gated is anything that would post an entry — and no tool in this system can.
 */
export class AllowDraftComposition1788100000000 implements MigrationInterface {
  name = 'AllowDraftComposition1788100000000';

  private static readonly TOOLS = [
    'StartDocumentDraft',
    'SetDraftField',
    'AddDraftLineItem',
    'SubmitDraftForApproval',
    'CancelDraft',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';

    for (const toolName of AllowDraftComposition1788100000000.TOOLS) {
      for (const senderRole of ['admin', 'staff']) {
        const existing = (await queryRunner.query(
          `SELECT "id" FROM "agent_tool_policies" WHERE "toolName" = '${toolName}' AND "senderRole" = '${senderRole}'`,
        )) as unknown[];
        if (existing.length) continue;

        const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
        const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
        await queryRunner.query(
          `INSERT INTO "agent_tool_policies" ("id","toolName","senderRole","level","note","updatedAt")
           VALUES (${id}, '${toolName}', '${senderRole}', 'ALLOW_AUTOMATICALLY',
                   'Sender-scoped: acts only on the composer''s own draft. Submission creates a pending record for a human to approve, never an entry.', ${now})`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    const list = AllowDraftComposition1788100000000.TOOLS.map(t => `'${t}'`).join(',');
    await queryRunner.query(`DELETE FROM "agent_tool_policies" WHERE "toolName" IN (${list})`);
  }
}
