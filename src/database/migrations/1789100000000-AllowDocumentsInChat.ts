import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a registered client ask for an invoice or a voucher by number, in chat.
 *
 * AddChatRequestableReports left these off, reasoning that "send me invoice 104" from whoever
 * is on the allowlist is how one customer's invoice reaches another. That reasoning assumed
 * the allowlist might hold END CUSTOMERS. It does not: every registered number is a BUSINESS
 * — on 8 October 2026 the four live ones are Hafiz Usman and Muhammad Ahmed Rangila (company
 * 1006), Fama Originals (1042) and a test account (1006) — and each asks about its own books.
 *
 * The fence that makes this safe is the one already enforced on every request:
 * `companyId`/`branch` come from the ASKING number's own registration, never from the
 * message, so the path built for Fama Originals is `/internal/pdf/SL/1042/GR/...` and cannot
 * address company 1006's documents at all. An invoice number is only meaningful inside the
 * company that issued it.
 *
 * ⚠ This is safe only while registered numbers are businesses. Registering an end customer —
 * one of a client's own customers — would let them read that client's other invoices by
 * guessing numbers. The inbox panel and USER_GUIDE say so where someone is about to add one.
 */
export class AllowDocumentsInChat1789100000000 implements MigrationInterface {
  name = 'AllowDocumentsInChat1789100000000';

  /** Every remaining Tijarah type: the seven by-number documents plus the ten other reports. */
  private static readonly TYPES = [
    'sale_invoice',
    'purchase_invoice',
    'digital_invoice',
    'sale_return',
    'purchase_return',
    'payment_voucher',
    'receive_voucher',
    'trial_balance',
    'stock_summary',
    'income_statement',
    'balance_sheet',
    'cash_bank_book',
    'sales_book_report',
    'purchase_book_report',
    'sale_return_report',
    'purchase_return_report',
    'item_ledger',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const list = AllowDocumentsInChat1789100000000.TYPES.map(t => `'${t}'`).join(',');
    // Only types that are switched on: a disabled row stays unreachable, including the demo
    // `invoice` type retired next door.
    await queryRunner.query(
      `UPDATE "document_type_registry" SET "chatRequestable" = ${pg ? 'true' : '1'}
        WHERE "documentType" IN (${list}) AND "enabled" = ${pg ? 'true' : '1'}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('document_type_registry'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const list = AllowDocumentsInChat1789100000000.TYPES.map(t => `'${t}'`).join(',');
    await queryRunner.query(
      `UPDATE "document_type_registry" SET "chatRequestable" = ${pg ? 'false' : '0'}
        WHERE "documentType" IN (${list})`,
    );
  }
}
