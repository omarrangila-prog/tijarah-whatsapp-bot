import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Folds the ledger's CUSTOMER / VENDOR / EXPENSE variants into the one registry row.
 *
 * The client's specification lists them as "Endpoint 2/3/4" beside the general ledger —
 * `/CUSTOMER`, `/VENDOR`, `/EXPENSE` — without saying whether they replace the `L` segment or
 * follow it. Rather than create three rows on a guess, the subject becomes a parameter:
 *
 *   general  → parameters: {}                      → .../2026/L?...
 *   customer → parameters: { subject: '/CUSTOMER' } → .../2026/L/CUSTOMER?...
 *
 * If the real shape turns out to be a replacement rather than a suffix, that is one template
 * edit here instead of four rows to reconcile — and until it is confirmed the row stays
 * disabled, so no one can accidentally fetch one party's ledger under another's name.
 */
export class LedgerSubjectVariants1787100000000 implements MigrationInterface {
  name = 'LedgerSubjectVariants1787100000000';

  private static readonly ENDPOINT =
    '/internal/pdf/GL/{companyId}/{branch}/{year}/L{subject}?scode=0101001&from={from}&to={to}&lot=ALL';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    // `subject` defaults to empty, so an unqualified request is the general ledger — the
    // behaviour the specification describes for the bare endpoint.
    const defaults = JSON.stringify({ companyId: '1006', branch: 'GR', year: '2026', subject: '' });
    await queryRunner.query(
      `UPDATE "document_type_registry"
         SET "endpoint" = '${LedgerSubjectVariants1787100000000.ENDPOINT}',
             "optionalParameters" = '["from","to","subject"]',
             "defaultParameters" = '${defaults.replace(/'/g, "''")}'
       WHERE "documentType" = 'general_ledger'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const defaults = JSON.stringify({ companyId: '1006', branch: 'GR', year: '2026' });
    await queryRunner.query(
      `UPDATE "document_type_registry"
         SET "endpoint" = '/internal/pdf/GL/{companyId}/{branch}/{year}/L?scode=0101001&from={from}&to={to}&lot=ALL',
             "optionalParameters" = '["from","to"]',
             "defaultParameters" = '${defaults.replace(/'/g, "''")}'
       WHERE "documentType" = 'general_ledger'`,
    );
  }
}
