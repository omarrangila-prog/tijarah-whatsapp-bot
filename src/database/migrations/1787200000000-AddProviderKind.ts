import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a document type say how its document is obtained.
 *
 * `http` fetches a response from an API. `browser` drives a signed-in Chrome, for a host that
 * renders its PDFs client-side — which is what Tijarah Books does: `/internal/pdf/...` is a
 * route in its single-page app and the file is built by html2pdf in the browser, so there is
 * no response to fetch.
 *
 * Defaults to `http`, so every existing row keeps its behaviour.
 */
export class AddProviderKind1787200000000 implements MigrationInterface {
  name = 'AddProviderKind1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const table = await queryRunner.getTable('document_type_registry');
    if (!table?.findColumnByName('providerKind')) {
      await queryRunner.query(
        `ALTER TABLE "document_type_registry" ADD "providerKind" varchar(16) NOT NULL DEFAULT 'http'`,
      );
    }
    // The eight Phase One types all come from the browser-rendered app.
    await queryRunner.query(
      `UPDATE "document_type_registry" SET "providerKind" = 'browser'
       WHERE "documentType" IN ('digital_invoice','sale_invoice','purchase_invoice','sale_return',
                                'purchase_return','payment_voucher','receive_voucher','general_ledger')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    await queryRunner.query(`UPDATE "document_type_registry" SET "providerKind" = 'http'`);
  }
}
