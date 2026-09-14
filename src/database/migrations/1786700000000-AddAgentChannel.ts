import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The agent channel's own tables.
 *
 * Six tables, none of which hold WhatsApp data: the gateway already stores sessions,
 * messages and conversations. These hold what only the agent knows — who may instruct it,
 * what it is allowed to do unattended, what it has prepared and is waiting on, what it
 * decided and why, and the queue between a schedule and a turn.
 *
 * Follows the same shape as AddCommandCenter: idempotent (`hasTable` guards), dialect-aware
 * for the three types that differ (`simple-json` is TEXT on both, timestamps are `timestamp`
 * on Postgres and `text`/`datetime` on SQLite), and no foreign keys — the codebase's data
 * connection does not use them, and `externalPartyId`-style references point at rows this
 * database does not own anyway.
 */
export class AddAgentChannel1786700000000 implements MigrationInterface {
  name = 'AddAgentChannel1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pg = queryRunner.dataSource.options.type === 'postgres';

    const pk = pg
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;
    const stamp = (name: string): string =>
      pg ? `"${name}" timestamp NOT NULL DEFAULT NOW()` : `"${name}" datetime NOT NULL DEFAULT (datetime('now'))`;
    const ts = (name: string): string => `"${name}" ${pg ? 'timestamp' : 'text'}`;
    const bool = (name: string, def: boolean): string =>
      `"${name}" boolean NOT NULL DEFAULT ${pg ? String(def) : def ? '(1)' : '(0)'}`;
    const int = (name: string, def: number): string =>
      `"${name}" integer NOT NULL DEFAULT ${pg ? String(def) : `(${def})`}`;

    const create = async (table: string, columns: string[], withPk = true): Promise<void> => {
      if (await queryRunner.hasTable(table)) return;
      await queryRunner.query(`CREATE TABLE "${table}" (${(withPk ? [pk, ...columns] : columns).join(', ')})`);
    };
    const index = async (name: string, table: string, columns: string, unique = false): Promise<void> => {
      await queryRunner.query(
        `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns})`,
      );
    };

    /* ------------------------------------------------------------- settings */

    /*
     * A single row keyed 'default'. Not `pk` — the id is a caller-supplied name rather than
     * a generated uuid, because there is exactly one and code looks it up by that name.
     */
    await create(
      'agent_settings',
      [
        `"id" varchar(32) PRIMARY KEY NOT NULL`,
        // Manual by default: a business opts in to automation, it is never opted in for them.
        `"mode" varchar(16) NOT NULL DEFAULT 'manual'`,
        bool('automationHalted', false),
        `"haltedReason" varchar(190)`,
        ts('haltedAt'),
        `"haltedBy" varchar(120)`,
        `"unknownSenderPolicy" varchar(16) NOT NULL DEFAULT 'ignore'`,
        `"unknownSenderMessage" text`,
        `"quietHoursEnd" varchar(5) NOT NULL DEFAULT '09:00'`,
        `"quietHoursStart" varchar(5) NOT NULL DEFAULT '21:00'`,
        `"timezone" varchar(64) NOT NULL DEFAULT 'Asia/Karachi'`,
        int('maxAutomaticSendsPerDay', 200),
        int('maxAutomaticSendsPerContactPerDay', 5),
        int('approvalTtlMinutes', 60),
        int('maxTurnsPerSenderPerHour', 30),
        stamp('updatedAt'),
      ],
      false,
    );

    /* ------------------------------------------------------------ allowlist */

    await create('agent_admin_numbers', [
      // Digits only, country code included. One comparison form everywhere.
      `"phoneE164" varchar(20) NOT NULL`,
      `"label" varchar(120) NOT NULL`,
      `"role" varchar(16) NOT NULL DEFAULT 'admin'`,
      `"apiKeyId" varchar`,
      bool('isActive', true),
      `"addedBy" varchar(120)`,
      stamp('createdAt'),
    ]);
    // Unique: one row per number, so "is this an admin?" cannot have two answers.
    await index('IDX_agent_admin_numbers_phone', 'agent_admin_numbers', '"phoneE164"', true);

    /* --------------------------------------------------------------- policy */

    await create('agent_tool_policies', [
      `"toolName" varchar(80) NOT NULL`,
      `"senderRole" varchar(16) NOT NULL`,
      `"level" varchar(24) NOT NULL DEFAULT 'REQUIRE_APPROVAL'`,
      // simple-array: TypeORM stores a comma-joined string in a text column.
      `"allowedRecipients" text`,
      `"note" varchar(300)`,
      stamp('updatedAt'),
    ]);
    await index('IDX_agent_tool_policies_scope', 'agent_tool_policies', '"toolName", "senderRole"', true);

    /* ------------------------------------------------------------ approvals */

    await create('agent_approvals', [
      `"reference" varchar(24) NOT NULL`,
      `"toolName" varchar(80) NOT NULL`,
      `"toolInput" text NOT NULL`,
      `"summary" text NOT NULL`,
      `"requestedByPhone" varchar(20) NOT NULL`,
      `"recipientPhone" varchar(20)`,
      `"recipientLabel" varchar(190)`,
      `"verifiedContext" text`,
      `"state" varchar(16) NOT NULL DEFAULT 'pending'`,
      `"idempotencyKey" varchar(80)`,
      `${ts('expiresAt').replace(/$/, ' NOT NULL')}`,
      `"decidedByPhone" varchar(20)`,
      ts('decidedAt'),
      `"resultMessageId" varchar(190)`,
      `"failureReason" varchar(500)`,
      `"conversationId" varchar(64)`,
      `"turnId" varchar`,
      stamp('createdAt'),
    ]);
    await index('IDX_agent_approvals_reference', 'agent_approvals', '"reference"', true);
    await index('IDX_agent_approvals_state', 'agent_approvals', '"state", "expiresAt"');
    /*
     * The single-use claim.
     *
     * Two APPROVE replies arriving together would both pass a "is it pending?" read. This
     * index is what makes the second one a constraint violation rather than a duplicate
     * message to a customer.
     */
    await index('IDX_agent_approvals_idem', 'agent_approvals', '"idempotencyKey"', true);

    /* ---------------------------------------------------------------- turns */

    await create('agent_turns', [
      `"channel" varchar(16) NOT NULL DEFAULT 'whatsapp'`,
      `"inboundMessageId" varchar(190) NOT NULL`,
      `"conversationId" varchar(64) NOT NULL`,
      `"senderPhone" varchar(20) NOT NULL`,
      `"senderRole" varchar(16) NOT NULL`,
      `"inboundText" text`,
      `"injectionFlag" varchar(190)`,
      `"replyText" text`,
      `"actions" text`,
      `"outcome" varchar(24) NOT NULL DEFAULT 'ok'`,
      `"outcomeDetail" varchar(500)`,
      `"providerId" varchar(40)`,
      `"model" varchar(80)`,
      int('inputTokens', 0),
      int('outputTokens', 0),
      int('durationMs', 0),
      stamp('createdAt'),
    ]);
    await index('IDX_agent_turns_conversation', 'agent_turns', '"conversationId", "createdAt"');
    /*
     * Duplicate protection for redelivery.
     *
     * Engines redeliver on reconnect. Unique on the inbound message id means the second
     * delivery loses the insert and produces no second reply — and, for an admin, no second
     * approval request for one action.
     */
    await index('IDX_agent_turns_message', 'agent_turns', '"inboundMessageId"', true);

    /* --------------------------------------------------------------- events */

    await create('agent_events', [
      `"eventType" varchar(40) NOT NULL`,
      `"eventKey" varchar(190) NOT NULL`,
      `"subjectPhone" varchar(20)`,
      `"subjectContactId" varchar(190)`,
      `"payload" text`,
      `"state" varchar(16) NOT NULL DEFAULT 'pending'`,
      `"outcomeDetail" varchar(300)`,
      int('attempts', 0),
      `${ts('runAfter').replace(/$/, ' NOT NULL')}`,
      `"turnId" varchar`,
      stamp('createdAt'),
    ]);
    // Deduplication in the database: overlapping cron runs converge on one row.
    await index('IDX_agent_events_key', 'agent_events', '"eventKey"', true);
    await index('IDX_agent_events_due', 'agent_events', '"state", "runAfter"');

    /* -------------------------------------------------------------- seeding */

    /*
     * The settings row is created here rather than lazily on first read.
     *
     * `PermissionGuard.loadSettings` does create it if absent, but a row that exists from
     * migration time means the dashboard renders a mode on a fresh install instead of
     * nothing, and the default is visible in the database rather than implied by code.
     */
    const existing: unknown = await queryRunner.query(`SELECT "id" FROM "agent_settings" WHERE "id" = 'default'`);
    if (!Array.isArray(existing) || existing.length === 0) {
      await queryRunner.query(`INSERT INTO "agent_settings" ("id") VALUES ('default')`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'agent_events',
      'agent_turns',
      'agent_approvals',
      'agent_tool_policies',
      'agent_admin_numbers',
      'agent_settings',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}
