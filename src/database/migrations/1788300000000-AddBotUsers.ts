import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Which Tijarah Books company each WhatsApp number belongs to.
 *
 * `sid` and `grp` were per-installation defaults on the document-type registry. They are
 * per-client: two businesses using the same bot would both have received company 1006's
 * documents, silently. This moves them to where they belong — the person asking.
 */
export class AddBotUsers1788300000000 implements MigrationInterface {
  name = 'AddBotUsers1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('bot_users')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const ts = (name: string): string => `"${name}" ${pg ? 'timestamp' : 'text'} NOT NULL`;

    await queryRunner.query(
      `CREATE TABLE "bot_users" (
        ${pg ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `"id" varchar PRIMARY KEY NOT NULL`},
        "whatsAppNo" varchar(20) NOT NULL,
        "displayName" varchar(190),
        "sid" integer NOT NULL,
        "grp" varchar(16) NOT NULL,
        "aYear" varchar(8) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT ${pg ? 'true' : '(1)'},
        ${ts('createdAt')},
        ${ts('updatedAt')}
      )`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_bot_users_phone" ON "bot_users" ("whatsAppNo")`);

    /*
     * Seeded from the numbers already on the agent allowlist, onto the company this deployment
     * has been using. Without it every existing administrator would stop being served the
     * moment this migration ran — and a silent loss of access is worse than an explicit one.
     */
    const admins = (await queryRunner.hasTable('agent_admin_numbers'))
      ? ((await queryRunner.query(
          `SELECT "phoneE164", "label" FROM "agent_admin_numbers" WHERE "isActive" = ${pg ? 'true' : '1'}`,
        )) as Array<{ phoneE164: string; label: string | null }>)
      : [];

    for (const admin of admins) {
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      const label = (admin.label ?? '').replace(/'/g, "''");
      await queryRunner.query(
        `INSERT INTO "bot_users" ("id","whatsAppNo","displayName","sid","grp","aYear","isActive","createdAt","updatedAt")
         VALUES (${id}, '${admin.phoneE164}', '${label}', 1006, 'GR', '2026', ${pg ? 'true' : '1'}, ${now}, ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "bot_users"`);
  }
}
