import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * The remaining Phase Two reports, ready for their endpoints.
 *
 * Phase Two of the specification lists eight report views. Four are the ledgers, whose paths
 * are known and live. These seven are not yet known, so each is seeded with the sentinel
 * endpoint `TODO://` and left disabled.
 *
 * A sentinel rather than a plausible guess, deliberately. A wrong-but-well-formed path would
 * be fetched, return somebody else's report or an HTML page, and only be noticed once a
 * customer had it. `TODO://` cannot resolve, cannot be enabled (the service refuses it), and
 * says exactly what is missing. Filling one in is an UPDATE of two columns.
 */
export class AddPhaseTwoReports1787800000000 implements MigrationInterface {
  name = 'AddPhaseTwoReports1787800000000';

  /** Phase Two rows 2–8. `scode` and the path arrive from the client. */
  private static readonly REPORTS = [
    { type: 'trial_balance', name: 'Trial Balance' },
    { type: 'item_ledger', name: 'Item Ledger' },
    { type: 'stock_summary', name: 'Stock Summary' },
    { type: 'income_statement', name: 'Income Statement' },
    { type: 'balance_sheet', name: 'Balance Sheet' },
    { type: 'cash_bank_book', name: 'Cash & Bank Book' },
    { type: 'sale_purchase_report', name: 'Sale & Purchase Report' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';

    for (const report of AddPhaseTwoReports1787800000000.REPORTS) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "document_type_registry" WHERE "documentType" = '${report.type}'`,
      )) as unknown[];
      if (existing.length) continue;

      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      await queryRunner.query(
        `INSERT INTO "document_type_registry"
          ("id","documentType","displayName","endpoint","method","providerKind","requiredParameters",
           "optionalParameters","defaultParameters","responseFormat","expectedMimeType","filenameRule",
           "enabled","chatRequestable","targetProcessingSeconds","targetSuccessRate","maximumAttempts",
           "timeoutSeconds","createdAt","updatedAt")
         VALUES (${id}, '${report.type}', '${report.name}',
           'TODO://endpoint-not-yet-supplied-for-${report.type}', 'GET', 'http', '[]', '["from","to"]',
           '{"companyId":"1006","branch":"GR","year":"2026"}', 'binary', 'application/pdf',
           '${report.name.replace(/[^A-Za-z0-9]+/g, '-')}-{year}.pdf',
           ${pg ? 'false' : '0'}, ${pg ? 'true' : '1'}, 20, 99, 3, 30, ${now}, ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const list = AddPhaseTwoReports1787800000000.REPORTS.map(r => `'${r.type}'`).join(',');
    await queryRunner.query(`DELETE FROM "document_type_registry" WHERE "documentType" IN (${list})`);
  }
}
