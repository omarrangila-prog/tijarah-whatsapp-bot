import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * The real Phase Two endpoints, replacing the `TODO://` sentinels.
 *
 * Two things differ from Phase One and both are easy to get wrong:
 *
 *  - **The prefix is `/report/pdf/`, not `/internal/pdf/`.** Only the ledgers stayed on the
 *    original path. A report placed on the wrong prefix returns nothing useful.
 *  - **The last path segment is not a document number.** It is a per-report flag the host
 *    expects — `Y` for Trial Balance and Stock Summary, `0` for the rest — and it is part of
 *    the endpoint rather than a parameter, because a caller has no way to know which to send.
 *
 * The Sale & Purchase report is four reports behind one code, exactly as the ledger was:
 * `SP/…/SL` returns the Sales Book, `/SR` a Sale Return, `/PR` the Purchase Book, `/RP` a
 * Purchase Return. Each is its own type so a person can ask for it by name.
 *
 * Every endpoint here was fetched and confirmed to return a titled PDF before being written.
 */
export class ConnectPhaseTwoReports1787900000000 implements MigrationInterface {
  name = 'ConnectPhaseTwoReports1787900000000';

  /** documentType → the path after the host, with its report-specific final segment. */
  private static readonly ENDPOINTS: Readonly<Record<string, string>> = {
    trial_balance: '/report/pdf/TB/{companyId}/{branch}/{year}/Y?from={from}&to={to}',
    item_ledger: '/report/pdf/IL/{companyId}/{branch}/{year}/0?from={from}&to={to}',
    stock_summary: '/report/pdf/SS/{companyId}/{branch}/{year}/Y?from={from}&to={to}',
    income_statement: '/report/pdf/IS/{companyId}/{branch}/{year}/0?from={from}&to={to}',
    balance_sheet: '/report/pdf/BS/{companyId}/{branch}/{year}/0?from={from}&to={to}',
    cash_bank_book: '/report/pdf/CB/{companyId}/{branch}/{year}/0?from={from}&to={to}',
  };

  /** The four reports behind the SP code, each verified to return its own titled PDF. */
  private static readonly SALE_PURCHASE = [
    { type: 'sales_book_report', name: 'Sales Book Report', code: 'SL' },
    { type: 'sale_return_report', name: 'Sale Return Report', code: 'SR' },
    { type: 'purchase_book_report', name: 'Purchase Book Report', code: 'PR' },
    { type: 'purchase_return_report', name: 'Purchase Return Report', code: 'RP' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const on = pg ? 'true' : '1';

    for (const [documentType, endpoint] of Object.entries(ConnectPhaseTwoReports1787900000000.ENDPOINTS)) {
      await queryRunner.query(
        `UPDATE "document_type_registry"
            SET "endpoint" = '${endpoint}', "enabled" = ${on}, "providerKind" = 'http'
          WHERE "documentType" = '${documentType}'`,
      );
    }

    /*
     * The placeholder row for the combined report is retired in favour of the four real ones.
     * Removed rather than left disabled: a type nobody can use is a question for whoever reads
     * the registry next.
     */
    await queryRunner.query(`DELETE FROM "document_type_registry" WHERE "documentType" = 'sale_purchase_report'`);

    for (const report of ConnectPhaseTwoReports1787900000000.SALE_PURCHASE) {
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
           '/report/pdf/SP/{companyId}/{branch}/{year}/${report.code}?from={from}&to={to}',
           'GET', 'http', '[]', '["from","to"]',
           '{"companyId":"1006","branch":"GR","year":"2026"}', 'binary', 'application/pdf',
           '${report.name.replace(/[^A-Za-z0-9]+/g, '-')}-{year}.pdf',
           ${on}, ${on}, 20, 99, 3, 30, ${now}, ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const list = ConnectPhaseTwoReports1787900000000.SALE_PURCHASE.map(r => `'${r.type}'`).join(',');
    await queryRunner.query(`DELETE FROM "document_type_registry" WHERE "documentType" IN (${list})`);
    for (const documentType of Object.keys(ConnectPhaseTwoReports1787900000000.ENDPOINTS)) {
      await queryRunner.query(
        `UPDATE "document_type_registry"
            SET "endpoint" = 'TODO://endpoint-not-yet-supplied-for-${documentType}',
                "enabled" = ${queryRunner.dataSource.options.type === 'postgres' ? 'false' : '0'}
          WHERE "documentType" = '${documentType}'`,
      );
    }
  }
}
