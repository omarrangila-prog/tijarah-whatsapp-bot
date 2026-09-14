import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * Points the Phase One document types at the API host, and switches them on.
 *
 * The specification originally gave `https://my.tijarahbooks.com`, which is the dashboard: the
 * same paths there are routes in its single-page app, every one returns the app shell, and a
 * request asking for `application/pdf` is answered 406. The corrected host,
 * `https://api.tijarabooks.com`, serves the real thing — `application/pdf`, 57–68 KB, valid
 * PDF 1.4, verified on all eight. So these are ordinary HTTP fetches after all and the
 * browser-rendering path is not needed for them.
 *
 * The ledger variants are settled here too. The specification listed `/CUSTOMER`, `/VENDOR`
 * and `/EXPENSE` beside the general ledger without saying where they attach. Appending them
 * after `L` 404s; they REPLACE the `GL` segment, and each is its own report — the PDFs come
 * back titled "CUSTOMER LEDGER", "VENDOR LEDGER", "EXPENSE LEDGER". They are therefore three
 * document types rather than a parameter on one, which is also how a caller thinks about them.
 */
export class ConnectTijarahApi1787300000000 implements MigrationInterface {
  name = 'ConnectTijarahApi1787300000000';

  private static readonly LEDGERS = [
    { type: 'customer_ledger', name: 'Customer Ledger', code: 'CUSTOMER' },
    { type: 'vendor_ledger', name: 'Vendor Ledger', code: 'VENDOR' },
    { type: 'expense_ledger', name: 'Expense Ledger', code: 'EXPENSE' },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const phaseOne = `('digital_invoice','sale_invoice','purchase_invoice','sale_return',
                       'purchase_return','payment_voucher','receive_voucher','general_ledger')`;

    /*
     * Fetched over HTTP, not rendered in a browser, and no credential: the host serves these
     * openly. `authProfile` is cleared rather than left naming a profile that does not exist,
     * so nobody later goes looking for a token that was never needed.
     */
    await queryRunner.query(
      `UPDATE "document_type_registry"
          SET "providerKind" = 'http',
              "authProfile" = NULL,
              "enabled" = ${pg ? 'true' : '1'}
        WHERE "documentType" IN ${phaseOne}`,
    );

    // The general ledger's subject parameter is gone: the variants are their own types below.
    await queryRunner.query(
      `UPDATE "document_type_registry"
          SET "endpoint" = '/internal/pdf/GL/{companyId}/{branch}/{year}/L?scode=0101001&from={from}&to={to}&lot=ALL',
              "optionalParameters" = '["from","to"]',
              "defaultParameters" = '{"companyId":"1006","branch":"GR","year":"2026"}'
        WHERE "documentType" = 'general_ledger'`,
    );

    for (const ledger of ConnectTijarahApi1787300000000.LEDGERS) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "document_type_registry" WHERE "documentType" = '${ledger.type}'`,
      )) as unknown[];
      if (existing.length) continue;

      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      await queryRunner.query(
        `INSERT INTO "document_type_registry"
          ("id","documentType","displayName","endpoint","method","providerKind","requiredParameters",
           "optionalParameters","defaultParameters","responseFormat","expectedMimeType","filenameRule",
           "enabled","targetProcessingSeconds","targetSuccessRate","maximumAttempts","timeoutSeconds",
           "createdAt","updatedAt")
         VALUES (${id}, '${ledger.type}', '${ledger.name}',
           '/internal/pdf/${ledger.code}/{companyId}/{branch}/{year}/L?scode=0101001&from={from}&to={to}&lot=ALL',
           'GET', 'http', '[]', '["from","to"]', '{"companyId":"1006","branch":"GR","year":"2026"}',
           'binary', 'application/pdf', '${ledger.name.replace(/\s+/g, '-')}-{year}.pdf',
           ${pg ? 'true' : '1'}, 20, 99, 3, 30, ${now}, ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    await queryRunner.query(
      `DELETE FROM "document_type_registry"
        WHERE "documentType" IN ('customer_ledger','vendor_ledger','expense_ledger')`,
    );
    await queryRunner.query(
      `UPDATE "document_type_registry" SET "providerKind" = 'browser', "authProfile" = 'tijarah',
              "enabled" = ${pg ? 'false' : '0'}
        WHERE "documentType" IN ('digital_invoice','sale_invoice','purchase_invoice','sale_return',
                                 'purchase_return','payment_voucher','receive_voucher','general_ledger')`,
    );
  }
}
