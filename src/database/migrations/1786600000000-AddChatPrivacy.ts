import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `privateAssignedChats` to the workspace settings row.
 *
 * A shared inbox has two legitimate shapes and one setting cannot serve both. A small team wants
 * every conversation visible so anyone can pick up a dropped thread; a larger floor wants an agent
 * to see only their own work, because reading a colleague's customer conversation is neither
 * necessary nor appropriate. This flag chooses between them at runtime.
 *
 * Default OFF: turning it on silently would make conversations vanish from inboxes that could see
 * them yesterday, which reads as data loss rather than as a policy change.
 *
 * Unassigned conversations stay visible to everyone regardless — they are the shared queue, and
 * hiding them would leave new customers with nobody able to claim them.
 */
export class AddChatPrivacy1786600000000 implements MigrationInterface {
  name = 'AddChatPrivacy1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('cc_workspace_settings'))) return;
    const table = await queryRunner.getTable('cc_workspace_settings');
    if (table?.findColumnByName('privateAssignedChats')) return;

    const pg = queryRunner.dataSource.options.type === 'postgres';
    await queryRunner.query(
      `ALTER TABLE "cc_workspace_settings" ADD "privateAssignedChats" boolean NOT NULL DEFAULT ${pg ? 'false' : '(0)'}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('cc_workspace_settings');
    if (!table?.findColumnByName('privateAssignedChats')) return;
    await queryRunner.query(`ALTER TABLE "cc_workspace_settings" DROP COLUMN "privateAssignedChats"`);
  }
}
