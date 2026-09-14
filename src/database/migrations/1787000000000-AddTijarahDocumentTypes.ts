import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';

/**
 * The eight Phase One document types from the client's specification, and the registry column
 * that lets them be configured rather than hard-coded.
 *
 * Every row is seeded **disabled**. The endpoints supplied are browser routes in the Tijarah
 * Books single-page app, not server APIs: fetching any of them — including a deliberately
 * invented path — returns the same 2,462-byte HTML shell with HTTP 200, because the PDF is
 * rendered client-side after the app boots and authenticates. A worker calling them would
 * receive that shell every time.
 *
 * The document validator already refuses it ("Document API returned an HTML page, not a PDF"),
 * so nothing broken would reach a customer. But a type that can only ever fail should not be
 * switched on: enabling these before a real server-side endpoint exists would fill the queue
 * with jobs that retry and fail on a schedule. Each row is otherwise complete, so enabling one
 * is a single UPDATE once its endpoint is known.
 */
export class AddTijarahDocumentTypes1787000000000 implements MigrationInterface {
  name = 'AddTijarahDocumentTypes1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pg = queryRunner.dataSource.options.type === 'postgres';

    if (await queryRunner.hasTable('document_type_registry')) {
      const columns = await queryRunner.getTable('document_type_registry');
      if (!columns?.findColumnByName('defaultParameters')) {
        await queryRunner.query(`ALTER TABLE "document_type_registry" ADD "defaultParameters" text`);
      }
    }

    /*
     * Path shape, from the specification:
     *   /internal/pdf/{CODE}/{companyId}/{branch}/{year}/{documentNumber}
     * companyId, branch, year and the screen code belong to the integration rather than to a
     * request, so they are defaults here and a job carries only the document number.
     */
    const types: Array<{
      type: string;
      name: string;
      code: string;
      scode?: string;
      ledger?: boolean;
      note: string;
    }> = [
      { type: 'digital_invoice', name: 'Digital Invoice', code: 'DINV', scode: '0102010', note: 'Phase One' },
      { type: 'sale_invoice', name: 'Sale Invoice', code: 'SL', scode: '0102003', note: 'Phase One' },
      { type: 'purchase_invoice', name: 'Purchase Invoice', code: 'PR', scode: '0102001', note: 'Phase One' },
      { type: 'sale_return', name: 'Sale Return', code: 'SR', scode: '0102004', note: 'Phase One' },
      { type: 'purchase_return', name: 'Purchase Return', code: 'RP', scode: '0102002', note: 'Phase One' },
      { type: 'payment_voucher', name: 'Payment Voucher', code: 'CV', note: 'Phase One — no screen code given' },
      { type: 'receive_voucher', name: 'Receive Voucher', code: 'DV', note: 'Phase One — no screen code given' },
      {
        type: 'general_ledger',
        name: 'General Ledger',
        code: 'GL',
        scode: '0101001',
        ledger: true,
        note: 'Omitting from/to returns the last 7 days',
      },
    ];

    for (const entry of types) {
      const existing = (await queryRunner.query(
        `SELECT "id" FROM "document_type_registry" WHERE "documentType" = '${entry.type}'`,
      )) as unknown[];
      if (existing.length) continue;

      /*
       * The ledger takes a date range and a fixed `L` segment where the others take a document
       * number. Omitting the dates is meaningful to the host — it returns the last seven days —
       * so they are optional rather than required.
       */
      const endpoint = entry.ledger
        ? `/internal/pdf/${entry.code}/{companyId}/{branch}/{year}/L?scode=${entry.scode}&from={from}&to={to}&lot=ALL`
        : `/internal/pdf/${entry.code}/{companyId}/{branch}/{year}/{documentNumber}${entry.scode ? `?scode=${entry.scode}` : ''}`;

      const required = entry.ledger ? '[]' : '["documentNumber"]';
      const optional = entry.ledger ? '["from","to"]' : '[]';
      const defaults = JSON.stringify({ companyId: '1006', branch: 'GR', year: '2026' });
      const filename = entry.ledger
        ? `${entry.name.replace(/\s+/g, '-')}-{year}.pdf`
        : `${entry.code}-{documentNumber}-{year}.pdf`;

      const now = pg ? 'NOW()' : `'${new Date().toISOString()}'`;
      const id = pg ? 'gen_random_uuid()::varchar' : `'${randomUUID()}'`;
      await queryRunner.query(
        `INSERT INTO "document_type_registry"
          ("id","documentType","displayName","endpoint","method","authProfile","requiredParameters",
           "optionalParameters","defaultParameters","responseFormat","expectedMimeType","filenameRule",
           "enabled","targetProcessingSeconds","targetSuccessRate","maximumAttempts","timeoutSeconds",
           "createdAt","updatedAt")
         VALUES (${id}, '${entry.type}', '${entry.name}', '${endpoint}', 'GET', 'tijarah',
           '${required}', '${optional}', '${defaults.replace(/'/g, "''")}', 'binary', 'application/pdf',
           '${filename}', ${pg ? 'false' : '0'}, 20, 99, 3, 30, ${now}, ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "document_type_registry" WHERE "documentType" IN
        ('digital_invoice','sale_invoice','purchase_invoice','sale_return','purchase_return',
         'payment_voucher','receive_voucher','general_ledger')`,
    );
  }
}
