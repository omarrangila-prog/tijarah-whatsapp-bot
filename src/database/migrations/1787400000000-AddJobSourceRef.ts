import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remembers which row in the host's own queue a job came from.
 *
 * Tijarah Books queues work of its own: `GetPendingBotInvoices` hands out rows, and
 * `MarkInvoiceProcessed` is how it is told to stop handing one out. To acknowledge a delivery
 * we have to remember the queue id, and to be sure we acknowledge it exactly once we have to
 * remember whether we already did.
 *
 * `sourceAckAt` is separate from the job's own status on purpose: delivering and acknowledging
 * are two systems, and either can fail alone. A job that is SENT but unacknowledged is retried
 * as an acknowledgement, never as a second delivery.
 */
export class AddJobSourceRef1787400000000 implements MigrationInterface {
  name = 'AddJobSourceRef1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('whatsapp_document_jobs'))) return;
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const table = await queryRunner.getTable('whatsapp_document_jobs');

    if (!table?.findColumnByName('sourceSystem')) {
      await queryRunner.query(`ALTER TABLE "whatsapp_document_jobs" ADD "sourceSystem" varchar(32)`);
    }
    if (!table?.findColumnByName('sourceRef')) {
      await queryRunner.query(`ALTER TABLE "whatsapp_document_jobs" ADD "sourceRef" varchar(64)`);
    }
    if (!table?.findColumnByName('sourceAckAt')) {
      await queryRunner.query(`ALTER TABLE "whatsapp_document_jobs" ADD "sourceAckAt" ${pg ? 'timestamp' : 'text'}`);
    }
    // The sweep that acknowledges deliveries reads exactly this shape.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wdj_source_ack" ON "whatsapp_document_jobs" ("sourceSystem", "sourceAckAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wdj_source_ack"`);
  }
}
