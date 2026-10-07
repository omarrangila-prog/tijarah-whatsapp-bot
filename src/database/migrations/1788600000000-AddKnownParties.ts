import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The names of a client's customers, so a ledger can be asked for by name.
 *
 * `GetBotCustomers` carries `lcode`, `telNo` and `email` and no name, so "send me Danyal's
 * ledger" could only be answered with "give me the account code". The queue
 * (`GetPendingBotInvoices`) names the customer on every document it delivers, so this table
 * keeps those names as they go past and matches them to an account code by phone number.
 *
 * Scoped to `sid`/`grp` like everything else a client can reach: a name learned in one
 * company's books is never offered to another's.
 */
export class AddKnownParties1788600000000 implements MigrationInterface {
  name = 'AddKnownParties1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('known_parties')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const ts = (name: string): string => `"${name}" ${pg ? 'timestamp' : 'text'} NOT NULL`;

    await queryRunner.query(
      `CREATE TABLE "known_parties" (
        ${pg ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `"id" varchar PRIMARY KEY NOT NULL`},
        "sid" integer NOT NULL,
        "grp" varchar(16) NOT NULL,
        "phone" varchar(20) NOT NULL,
        "name" varchar(190) NOT NULL,
        "lcode" varchar(40),
        ${ts('lastSeenAt')},
        ${ts('createdAt')}
      )`,
    );
    // One row per customer per company: the business renaming someone updates rather than duplicates.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_known_parties_tenant_phone" ON "known_parties" ("sid", "grp", "phone")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_known_parties_tenant" ON "known_parties" ("sid", "grp")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "known_parties"`);
  }
}
