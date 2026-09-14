import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase Three: documents composed in a WhatsApp conversation, awaiting approval.
 *
 * A draft is never an accounting entry. It is collected here, reviewed by the person building
 * it, and then submitted to Tijarah Books' approval screen — which is the only thing this
 * phase is permitted to do. `submittedRef` holds the pending record's id on the host side.
 */
export class AddDocumentDrafts1788000000000 implements MigrationInterface {
  name = 'AddDocumentDrafts1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('document_drafts')) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const ts = (name: string): string => `"${name}" ${pg ? 'timestamp' : 'text'}`;

    await queryRunner.query(
      `CREATE TABLE "document_drafts" (
        ${pg ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar` : `"id" varchar PRIMARY KEY NOT NULL`},
        "reference" varchar(32) NOT NULL,
        "documentType" varchar(64) NOT NULL,
        "displayName" varchar(190) NOT NULL,
        "createdByPhone" varchar(20) NOT NULL,
        "conversationId" varchar(64),
        "status" varchar(24) NOT NULL DEFAULT 'COLLECTING',
        "fields" text,
        "lineItems" text,
        "submittedRef" varchar(120),
        ${ts('submittedAt')},
        "errorMessage" varchar(500),
        ${ts('createdAt')} NOT NULL,
        ${ts('updatedAt')} NOT NULL
      )`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_draft_reference" ON "document_drafts" ("reference")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_draft_owner" ON "document_drafts" ("createdByPhone", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_draft_status" ON "document_drafts" ("status", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "document_drafts"`);
  }
}
