import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets the business write the message its customers read.
 *
 * The caption above a document is the company speaking to a customer about their own money,
 * and the right wording is a business decision, not a developer's. Leaving it in code means
 * every change to a greeting is a deployment; a column means an operator edits a row.
 *
 * Left NULL, a type uses the default for its kind in caption.ts — a sale invoice thanks the
 * customer, a purchase invoice does not, a receipt confirms the money arrived.
 */
export class AddCaptionTemplate1787700000000 implements MigrationInterface {
  name = 'AddCaptionTemplate1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const table = await queryRunner.getTable('document_type_registry');
    if (!table?.findColumnByName('captionTemplate')) {
      await queryRunner.query(`ALTER TABLE "document_type_registry" ADD "captionTemplate" text`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // The column is additive and nullable; dropping it would discard wording an operator wrote.
  }
}
