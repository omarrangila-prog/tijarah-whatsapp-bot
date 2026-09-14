import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a ledger be fetched for one party rather than the whole company.
 *
 * Phase Two as the client describes it is "Ahmed is my customer, send me his ledger" — one
 * account, not every customer. The host supports it in the last path segment: `.../2026/L`
 * returns everyone and `.../2026/C-1005` returns that party, with the PDF titling itself
 * "CUSTOMER LEDGER - C-1005" so the filtering is visible on the document.
 *
 * `partyCode` defaults to `L`, which is the host's own value for "all", so an unqualified
 * request behaves exactly as it did before this migration.
 */
export class AddPartyLedgerFilter1788200000000 implements MigrationInterface {
  name = 'AddPartyLedgerFilter1788200000000';

  private static readonly LEDGERS: Readonly<Record<string, string>> = {
    general_ledger: 'GL',
    customer_ledger: 'CUSTOMER',
    vendor_ledger: 'VENDOR',
    expense_ledger: 'EXPENSE',
  };

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;

    for (const [documentType, code] of Object.entries(AddPartyLedgerFilter1788200000000.LEDGERS)) {
      const defaults = JSON.stringify({ companyId: '1006', branch: 'GR', year: '2026', partyCode: 'L' });
      await queryRunner.query(
        `UPDATE "document_type_registry"
            SET "endpoint" = '/internal/pdf/${code}/{companyId}/{branch}/{year}/{partyCode}?scode=0101001&from={from}&to={to}&lot=ALL',
                "optionalParameters" = '["from","to","partyCode"]',
                "defaultParameters" = '${defaults.replace(/'/g, "''")}'
          WHERE "documentType" = '${documentType}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    for (const [documentType, code] of Object.entries(AddPartyLedgerFilter1788200000000.LEDGERS)) {
      const defaults = JSON.stringify({ companyId: '1006', branch: 'GR', year: '2026' });
      await queryRunner.query(
        `UPDATE "document_type_registry"
            SET "endpoint" = '/internal/pdf/${code}/{companyId}/{branch}/{year}/L?scode=0101001&from={from}&to={to}&lot=ALL',
                "optionalParameters" = '["from","to"]',
                "defaultParameters" = '${defaults.replace(/'/g, "''")}'
          WHERE "documentType" = '${documentType}'`,
      );
    }
  }
}
