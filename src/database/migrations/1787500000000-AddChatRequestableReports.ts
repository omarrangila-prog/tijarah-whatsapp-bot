import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marks which document types an authorised person may ask for in a WhatsApp conversation.
 *
 * Phase Two of the client's specification: "Chat with Bot in WhatsApp" for report views. A
 * report is safe to request this way because it belongs to the business rather than to one
 * customer, and the answer goes back to the person who asked.
 *
 * An invoice is deliberately NOT requestable. It belongs to a named customer, needs a document
 * number, and "send me invoice 104" from whoever happens to be on the allowlist is how one
 * customer's invoice reaches another. Invoices are queued by the accounting system or raised
 * through the dashboard, where there is a recipient chosen on purpose.
 */
export class AddChatRequestableReports1787500000000 implements MigrationInterface {
  name = 'AddChatRequestableReports1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const table = await queryRunner.getTable('document_type_registry');

    if (!table?.findColumnByName('chatRequestable')) {
      await queryRunner.query(
        `ALTER TABLE "document_type_registry" ADD "chatRequestable" boolean NOT NULL DEFAULT ${pg ? 'false' : '(0)'}`,
      );
    }
    // The four ledgers are the reports whose endpoints are known and verified.
    await queryRunner.query(
      `UPDATE "document_type_registry" SET "chatRequestable" = ${pg ? 'true' : '1'}
        WHERE "documentType" IN ('general_ledger','customer_ledger','vendor_ledger','expense_ledger')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    await queryRunner.query(`UPDATE "document_type_registry" SET "chatRequestable" = ${pg ? 'false' : '0'}`);
  }
}
