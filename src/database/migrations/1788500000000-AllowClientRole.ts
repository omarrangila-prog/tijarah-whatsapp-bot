import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Gives a Tijarah client the policies its own tools need.
 *
 * Every earlier policy was seeded for `admin` and `staff`, the two roles that existed. A
 * `client` — a number mapped to a company in `bot_users` — would therefore fall to the
 * default, which for a write is REQUIRE_APPROVAL, and a client has nobody to approve for
 * them: asking for their own ledger would hang waiting on an administrator who was never
 * told. Default-closed is the right default and the reason this migration exists rather
 * than a code change that loosens it.
 *
 * What a client is allowed is the Tijarah set and only that, enforced twice over: by these
 * rows, and by `CLIENT_ALLOWED_TOOLS` in the permission guard, which is an allowlist checked
 * before the policy is even read. A row added here by mistake still could not reach a tool
 * the guard does not list.
 *
 * Every tool below is `senderScoped`, so the most any of them can touch is the company the
 * sending number is mapped to. `SubmitDraftForApproval` leaves the building and is included
 * for the reason given in AllowDraftComposition: what it creates is a PENDING row on
 * Tijarah's approval screen, which IS the human gate.
 */
export class AllowClientRole1788500000000 implements MigrationInterface {
  name = 'AllowClientRole1788500000000';

  /** Mirrors `CLIENT_ALLOWED_TOOLS`. The guard is the fence; these rows are the permission. */
  private static readonly TOOLS = [
    'ListAccountingReports',
    'RequestAccountingReport',
    'ListCreatableDocuments',
    'StartDocumentDraft',
    'SetDraftField',
    'AnswerDraftPrompt',
    'AddDraftLineItem',
    'ComposeDocument',
    'ReviewDraft',
    'SubmitDraftForApproval',
    'CancelDraft',
    'AgentRequestHuman',
    'AgentOptOut',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';

    for (const toolName of AllowClientRole1788500000000.TOOLS) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "agent_tool_policies" WHERE "toolName" = '${toolName}' AND "senderRole" = 'client'`,
      )) as unknown[];
      if (existing.length) continue;

      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      await queryRunner.query(
        `INSERT INTO "agent_tool_policies" ("id","toolName","senderRole","level","note","updatedAt")
         VALUES (${id}, '${toolName}', 'client', 'ALLOW_AUTOMATICALLY',
                 'Sender-scoped: acts only on the company this number is mapped to.', ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    await queryRunner.query(`DELETE FROM "agent_tool_policies" WHERE "senderRole" = 'client'`);
  }
}
