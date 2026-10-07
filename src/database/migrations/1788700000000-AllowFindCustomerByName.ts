import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Lets a client resolve one of their own customers by name.
 *
 * Without a policy row the default for a read is ALLOW_AUTOMATICALLY, but the client role is
 * seeded explicitly for every tool it may use (see AllowClientRole) so that what a client can
 * reach is visible in one place rather than inferred from a default. The guard's
 * `CLIENT_ALLOWED_TOOLS` is the fence; this row is the permission.
 *
 * The tool reads only names learned in the asking client's own `sid`/`grp`, which is why it is
 * `senderScoped` and why it is a read.
 */
export class AllowFindCustomerByName1788700000000 implements MigrationInterface {
  name = 'AllowFindCustomerByName1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';

    for (const role of ['client', 'admin', 'staff']) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "agent_tool_policies" WHERE "toolName" = 'FindCustomerByName' AND "senderRole" = '${role}'`,
      )) as unknown[];
      if (existing.length) continue;

      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      await queryRunner.query(
        `INSERT INTO "agent_tool_policies" ("id","toolName","senderRole","level","note","updatedAt")
         VALUES (${id}, 'FindCustomerByName', '${role}', 'ALLOW_AUTOMATICALLY',
                 'Sender-scoped: reads only the customers known in this number''s own company.', ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agent_tool_policies'))) return;
    await queryRunner.query(`DELETE FROM "agent_tool_policies" WHERE "toolName" = 'FindCustomerByName'`);
  }
}
