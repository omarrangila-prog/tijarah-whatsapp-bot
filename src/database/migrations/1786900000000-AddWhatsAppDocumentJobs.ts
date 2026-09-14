import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 of the WhatsApp document-delivery system: the jobs table and the type registry.
 *
 * Same shape as the other migrations here: idempotent via `hasTable`, dialect-aware for the
 * three types that differ, and no foreign keys — the data connection does not use them, and
 * `clientId`/`partyId` point at records in a host accounting system this database does not own.
 */
export class AddWhatsAppDocumentJobs1786900000000 implements MigrationInterface {
  name = 'AddWhatsAppDocumentJobs1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pg = queryRunner.dataSource.options.type === 'postgres';

    const pk = pg
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;
    const ts = (name: string): string => `"${name}" ${pg ? 'timestamp' : 'text'}`;
    const bool = (name: string, def: boolean): string =>
      `"${name}" boolean NOT NULL DEFAULT ${pg ? String(def) : def ? '(1)' : '(0)'}`;
    const int = (name: string, def: number): string =>
      `"${name}" integer NOT NULL DEFAULT ${pg ? String(def) : `(${def})`}`;

    const create = async (table: string, columns: string[]): Promise<void> => {
      if (await queryRunner.hasTable(table)) return;
      await queryRunner.query(`CREATE TABLE "${table}" (${[pk, ...columns].join(', ')})`);
    };
    const index = async (name: string, table: string, columns: string, unique = false): Promise<void> => {
      await queryRunner.query(
        `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns})`,
      );
    };

    /* ------------------------------------------------------- document types */

    await create('document_type_registry', [
      `"documentType" varchar(64) NOT NULL`,
      `"displayName" varchar(190) NOT NULL`,
      `"endpoint" text NOT NULL`,
      `"method" varchar(10) NOT NULL DEFAULT 'GET'`,
      // The NAME of an auth profile. Never a secret — see the entity's class comment.
      `"authProfile" varchar(64)`,
      `"requiredParameters" text`,
      `"optionalParameters" text`,
      `"requestHeaders" text`,
      `"requestBodyMapping" text`,
      `"responseFormat" varchar(16) NOT NULL DEFAULT 'binary'`,
      `"responseParser" text`,
      `"expectedMimeType" varchar(120) NOT NULL DEFAULT 'application/pdf'`,
      int('maximumFileSize', 10485760),
      `"filenameRule" varchar(190) NOT NULL DEFAULT '{documentReference}.pdf'`,
      bool('enabled', true),
      int('targetProcessingSeconds', 20),
      int('targetSuccessRate', 99),
      int('maximumAttempts', 3),
      int('timeoutSeconds', 30),
      int('duplicatesPrevented', 0),
      `${ts('createdAt')} NOT NULL`,
      `${ts('updatedAt')} NOT NULL`,
    ]);
    await index('IDX_dtr_type', 'document_type_registry', '"documentType"', true);

    /* ---------------------------------------------------------------- jobs */

    await create('whatsapp_document_jobs', [
      `"reference" varchar(32) NOT NULL`,
      `"source" varchar(24) NOT NULL`,
      `"requestedByUserId" varchar(64)`,
      `"documentType" varchar(64) NOT NULL`,
      `"documentName" varchar(190)`,
      `"documentReference" varchar(120)`,
      `"clientId" varchar(64)`,
      `"partyId" varchar(64)`,
      `"recipientName" varchar(190)`,
      `"recipientWhatsAppNumber" varchar(20) NOT NULL`,
      `"messageText" text`,
      `"parametersJson" text`,
      int('priority', 0),
      `"status" varchar(32) NOT NULL DEFAULT 'PENDING'`,
      `"idempotencyKey" varchar(190) NOT NULL`,
      int('attemptCount', 0),
      int('maximumAttempts', 3),
      ts('nextRetryAt'),
      `"claimedBy" varchar(64)`,
      ts('claimedAt'),
      ts('processingLeaseExpiresAt'),
      `"documentUrl" text`,
      `"documentStorageKey" varchar(400)`,
      `"documentMimeType" varchar(120)`,
      `"documentSize" integer`,
      `"whatsappMessageId" varchar(190)`,
      `"errorCode" varchar(48)`,
      `"errorMessage" varchar(500)`,
      `"timeline" text`,
      `${ts('createdAt')} NOT NULL`,
      ts('startedAt'),
      ts('documentReceivedAt'),
      ts('sentAt'),
      ts('completedAt'),
      `${ts('updatedAt')} NOT NULL`,
    ]);

    await index('IDX_wdj_reference', 'whatsapp_document_jobs', '"reference"', true);
    // The duplicate-send guard. Unique, so a race produces one winner rather than two jobs.
    await index('IDX_wdj_idempotency', 'whatsapp_document_jobs', '"idempotencyKey"', true);
    await index('IDX_wdj_status_priority', 'whatsapp_document_jobs', '"status", "priority", "createdAt"');
    await index('IDX_wdj_next_retry', 'whatsapp_document_jobs', '"status", "nextRetryAt"');
    await index('IDX_wdj_client', 'whatsapp_document_jobs', '"clientId"');
    await index('IDX_wdj_party', 'whatsapp_document_jobs', '"partyId"');
    await index('IDX_wdj_created', 'whatsapp_document_jobs', '"createdAt"');
    await index('IDX_wdj_document_type', 'whatsapp_document_jobs', '"documentType"');

    /* ---------------------------------------------------- seed: the demo type */

    const existing = (await queryRunner.query(
      `SELECT "id" FROM "document_type_registry" WHERE "documentType" = 'invoice'`,
    )) as unknown[];
    if (!existing.length) {
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      const id = pg ? 'gen_random_uuid()::varchar' : `'${cryptoId()}'`;
      await queryRunner.query(
        `INSERT INTO "document_type_registry"
          ("id","documentType","displayName","endpoint","method","requiredParameters","optionalParameters",
           "responseFormat","expectedMimeType","filenameRule","enabled","targetProcessingSeconds",
           "targetSuccessRate","maximumAttempts","timeoutSeconds","createdAt","updatedAt")
         VALUES (${id}, 'invoice', 'Sales Invoice', '/api/documents/invoices/{invoiceId}/pdf', 'GET',
           '["invoiceId"]', '["companyId"]', 'binary', 'application/pdf', '{documentReference}.pdf',
           ${pg ? 'true' : '1'}, 20, 99, 3, 30, ${now}, ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "whatsapp_document_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "document_type_registry"`);
  }
}

/** A uuid for the SQLite branch, which has no generator function of its own. */
function cryptoId(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('node:crypto') as typeof import('node:crypto')).randomUUID();
}
