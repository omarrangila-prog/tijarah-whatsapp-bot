import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets the item ledger be fetched for one item rather than every item.
 *
 * The same shape as AddPartyLedgerFilter, for the same reason: "Blue Shirt ka item ledger"
 * is one product, not the whole catalogue. The host takes the item code in the last path
 * segment, where `0` means all — so `itemCode` defaults to `0` and an unqualified request
 * behaves exactly as it did before this migration.
 *
 * This became answerable on 8 October 2026, when `GetBotItems` began returning a code AND a
 * name. Until then nothing could turn "Blue Shirt" into `001001001`, so the segment was
 * hard-coded and a person could only ever receive every item.
 */
export class AddItemLedgerFilter1788800000000 implements MigrationInterface {
  name = 'AddItemLedgerFilter1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;

    const defaults = JSON.stringify({ companyId: '1006', branch: 'GR', year: '2026', itemCode: '0' });
    await queryRunner.query(
      `UPDATE "document_type_registry"
          SET "endpoint" = '/report/pdf/IL/{companyId}/{branch}/{year}/{itemCode}?from={from}&to={to}',
              "optionalParameters" = '["from","to","itemCode"]',
              "defaultParameters" = '${defaults.replace(/'/g, "''")}'
        WHERE "documentType" = 'item_ledger'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const defaults = JSON.stringify({ companyId: '1006', branch: 'GR', year: '2026' });
    await queryRunner.query(
      `UPDATE "document_type_registry"
          SET "endpoint" = '/report/pdf/IL/{companyId}/{branch}/{year}/0?from={from}&to={to}',
              "optionalParameters" = '["from","to"]',
              "defaultParameters" = '${defaults.replace(/'/g, "''")}'
        WHERE "documentType" = 'item_ledger'`,
    );
  }
}
