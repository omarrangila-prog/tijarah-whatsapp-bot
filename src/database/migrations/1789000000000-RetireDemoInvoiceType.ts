import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Switches off the demo `invoice` type left over from before Tijarah was connected.
 *
 * It is called "Sales Invoice" — a name a person would plausibly pick — but its endpoint is
 * `/api/documents/invoices/{invoiceId}/pdf`, which is this project's own example path and not
 * anything Tijarah serves. It also takes `invoiceId` where every real type takes
 * `documentNumber`, so a job made from it fails on the fetch.
 *
 * Nothing has ever used it (0 of 53 jobs on the live deployment), but it is `enabled`, so it
 * appears in the dashboard's Send to WhatsApp list right beside the real Sale Invoice. Two
 * entries with near-identical names, one of which cannot work, is a trap for whoever is
 * sending a document in a hurry.
 *
 * Disabled rather than deleted: the row is the record of what the registry once held, and a
 * deployment that genuinely uses this endpoint can switch it back on.
 */
export class RetireDemoInvoiceType1789000000000 implements MigrationInterface {
  name = 'RetireDemoInvoiceType1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    await queryRunner.query(
      `UPDATE "document_type_registry" SET "enabled" = ${pg ? 'false' : '0'}
        WHERE "documentType" = 'invoice' AND "endpoint" LIKE '/api/documents/invoices/%'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    await queryRunner.query(
      `UPDATE "document_type_registry" SET "enabled" = ${pg ? 'true' : '1'}
        WHERE "documentType" = 'invoice' AND "endpoint" LIKE '/api/documents/invoices/%'`,
    );
  }
}
