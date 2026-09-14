import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the WA Command Center schema: the business layer wrapped around OpenWA's WhatsApp data.
 *
 * Hand-authored (like every migration here) because `synchronize` is off on the `data` connection
 * for Postgres and optional on SQLite, so both dialects need an explicit branch. The column types
 * mirror what the entities declare through `column-types.ts`: JSON columns are plain `text`
 * (`simple-json` on both dialects — never `jsonb`, see the helper's rationale), and nullable date
 * columns are `timestamp` on Postgres and `text` on SQLite, which is what `dateColumnType()` +
 * `DateTransformer` read back.
 *
 * No cross-table foreign keys beyond `sessionId → sessions`: the rest are soft references so that
 * deleting an agent or a tag degrades a conversation to "unassigned"/"untagged" rather than
 * cascading a customer's whole history away. `sessionId` DOES cascade — a conversation has no
 * meaning once its number is gone, matching `automation_rules`.
 */
export class AddCommandCenter1786400000000 implements MigrationInterface {
  name = 'AddCommandCenter1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pg = queryRunner.dataSource.options.type === 'postgres';

    /** Primary key column, matching `@PrimaryGeneratedColumn('uuid')` on a varchar column. */
    const pk = pg
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;
    /** `@CreateDateColumn` / `@UpdateDateColumn`. */
    const stamp = (name: string): string =>
      pg ? `"${name}" timestamp NOT NULL DEFAULT NOW()` : `"${name}" datetime NOT NULL DEFAULT (datetime('now'))`;
    /** Nullable business timestamp — what `dateColumnType()` resolves to. */
    const ts = (name: string): string => `"${name}" ${pg ? 'timestamp' : 'text'}`;
    const bool = (name: string, def: boolean): string =>
      `"${name}" boolean NOT NULL DEFAULT ${pg ? String(def) : def ? '(1)' : '(0)'}`;
    const int = (name: string, def: number): string =>
      `"${name}" integer NOT NULL DEFAULT ${pg ? String(def) : `(${def})`}`;

    const create = async (table: string, columns: string[], extra: string[] = []): Promise<void> => {
      if (await queryRunner.hasTable(table)) return;
      await queryRunner.query(`CREATE TABLE "${table}" (${[pk, ...columns, ...extra].join(', ')})`);
    };
    const index = async (name: string, table: string, columns: string, unique = false): Promise<void> => {
      await queryRunner.query(
        `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns})`,
      );
    };

    // ---------------------------------------------------------------- people

    await create('cc_agents', [
      `"name" varchar(120) NOT NULL`,
      `"email" varchar(190)`,
      `"apiKeyId" varchar(64)`,
      `"role" varchar(20) NOT NULL DEFAULT 'operator'`,
      `"color" varchar(9) NOT NULL DEFAULT '#25d366'`,
      bool('active', true),
      ts('lastSeenAt'),
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_agents_apiKeyId', 'cc_agents', '"apiKeyId"');

    await create('cc_teams', [
      `"name" varchar(100) NOT NULL`,
      `"description" varchar(240)`,
      `"color" varchar(9) NOT NULL DEFAULT '#2563eb'`,
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_teams_name', 'cc_teams', '"name"', true);

    await create(
      'cc_team_members',
      [
        `"teamId" varchar NOT NULL`,
        `"agentId" varchar NOT NULL`,
        `"teamRole" varchar(20) NOT NULL DEFAULT 'member'`,
        stamp('createdAt'),
      ],
      [`CONSTRAINT "UQ_cc_team_members_team_agent" UNIQUE ("teamId", "agentId")`],
    );
    await index('IDX_cc_team_members_teamId', 'cc_team_members', '"teamId"');
    await index('IDX_cc_team_members_agentId', 'cc_team_members', '"agentId"');

    // --------------------------------------------------------- conversations

    await create(
      'cc_conversations',
      [
        `"sessionId" varchar NOT NULL`,
        `"chatId" varchar(190) NOT NULL`,
        `"chatName" varchar(190)`,
        `"kind" varchar(20) NOT NULL DEFAULT 'individual'`,
        `"status" varchar(20) NOT NULL DEFAULT 'open'`,
        `"priority" varchar(20) NOT NULL DEFAULT 'normal'`,
        `"assigneeId" varchar`,
        `"teamId" varchar`,
        bool('starred', false),
        bool('muted', false),
        ts('lastMessageAt'),
        `"lastMessagePreview" varchar(260)`,
        `"lastMessageType" varchar(20)`,
        `"lastMessageDirection" varchar(10)`,
        int('unreadCount', 0),
        bool('manualUnread', false),
        ts('firstInboundAt'),
        ts('firstResponseAt'),
        ts('pendingSince'),
        ts('resolvedAt'),
        ts('lastReadAt'),
        stamp('createdAt'),
        stamp('updatedAt'),
      ],
      [
        `CONSTRAINT "UQ_cc_conversations_session_chat" UNIQUE ("sessionId", "chatId")`,
        `CONSTRAINT "FK_cc_conversations_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE`,
      ],
    );
    await index('IDX_cc_conversations_session_lastMessageAt', 'cc_conversations', '"sessionId", "lastMessageAt"');
    await index('IDX_cc_conversations_lastMessageAt', 'cc_conversations', '"lastMessageAt"');
    await index('IDX_cc_conversations_status', 'cc_conversations', '"status"');
    await index('IDX_cc_conversations_assigneeId', 'cc_conversations', '"assigneeId"');

    await create('cc_conversation_notes', [
      `"conversationId" varchar NOT NULL`,
      `"authorId" varchar`,
      `"authorName" varchar(120)`,
      `"body" text NOT NULL`,
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_conversation_notes_conversationId', 'cc_conversation_notes', '"conversationId"');

    await create('cc_assignment_history', [
      `"conversationId" varchar NOT NULL`,
      `"action" varchar(20) NOT NULL`,
      `"fromAgentId" varchar`,
      `"toAgentId" varchar`,
      `"teamId" varchar`,
      `"actor" varchar(120)`,
      `"reason" varchar(240)`,
      stamp('createdAt'),
    ]);
    await index('IDX_cc_assignment_history_conversationId', 'cc_assignment_history', '"conversationId"');

    // ------------------------------------------------------------------ tags

    await create('cc_tags', [
      `"name" varchar(60) NOT NULL`,
      `"color" varchar(9) NOT NULL DEFAULT '#6366f1'`,
      stamp('createdAt'),
    ]);
    await index('IDX_cc_tags_name', 'cc_tags', '"name"', true);

    await create(
      'cc_conversation_tags',
      [`"conversationId" varchar NOT NULL`, `"tagId" varchar NOT NULL`, stamp('createdAt')],
      [`CONSTRAINT "UQ_cc_conversation_tags_pair" UNIQUE ("conversationId", "tagId")`],
    );
    await index('IDX_cc_conversation_tags_conversationId', 'cc_conversation_tags', '"conversationId"');
    await index('IDX_cc_conversation_tags_tagId', 'cc_conversation_tags', '"tagId"');

    // --------------------------------------------------------------- customers

    await create('cc_customer_profiles', [
      `"waId" varchar(190) NOT NULL`,
      `"phone" varchar(32)`,
      `"displayName" varchar(120)`,
      `"company" varchar(120)`,
      `"email" varchar(190)`,
      `"source" varchar(60)`,
      `"customerType" varchar(60)`,
      `"city" varchar(90)`,
      `"customFields" text`,
      ts('firstInteractionAt'),
      ts('lastInteractionAt'),
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_customer_profiles_waId', 'cc_customer_profiles', '"waId"', true);
    await index('IDX_cc_customer_profiles_phone', 'cc_customer_profiles', '"phone"');

    await create('cc_contact_consent', [
      `"waId" varchar(190) NOT NULL`,
      `"status" varchar(20) NOT NULL DEFAULT 'unknown'`,
      `"source" varchar(190)`,
      ts('optedInAt'),
      ts('optedOutAt'),
      `"recordedBy" varchar(120)`,
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_contact_consent_waId', 'cc_contact_consent', '"waId"', true);
    await index('IDX_cc_contact_consent_status', 'cc_contact_consent', '"status"');

    // ---------------------------------------------------------- productivity

    await create('cc_quick_replies', [
      `"shortcut" varchar(40) NOT NULL`,
      `"title" varchar(120) NOT NULL`,
      `"body" text NOT NULL`,
      `"folder" varchar(60) NOT NULL DEFAULT 'General'`,
      int('useCount', 0),
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_quick_replies_shortcut', 'cc_quick_replies', '"shortcut"', true);
    await index('IDX_cc_quick_replies_folder', 'cc_quick_replies', '"folder"');

    await create('cc_follow_ups', [
      `"conversationId" varchar`,
      `"assigneeId" varchar`,
      `"title" varchar(190) NOT NULL`,
      `"notes" text`,
      `"dueAt" ${pg ? 'timestamp' : 'text'} NOT NULL`,
      `"status" varchar(20) NOT NULL DEFAULT 'pending'`,
      `"createdVia" varchar(20) NOT NULL DEFAULT 'manual'`,
      ts('completedAt'),
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_follow_ups_due', 'cc_follow_ups', '"status", "dueAt"');
    await index('IDX_cc_follow_ups_conversationId', 'cc_follow_ups', '"conversationId"');

    // -------------------------------------------------------------------- ai

    await create('cc_ai_insights', [
      `"conversationId" varchar NOT NULL`,
      `"summary" text`,
      `"intent" varchar(60)`,
      `"sentiment" varchar(20)`,
      `"language" varchar(40)`,
      `"keyPoints" text`,
      `"extracted" text`,
      `"suggestedReply" text`,
      `"nextBestAction" varchar(240)`,
      `"provider" varchar(40) NOT NULL`,
      `"model" varchar(80)`,
      int('messageCountAtAnalysis', 0),
      stamp('createdAt'),
    ]);
    await index('IDX_cc_ai_insights_conversationId', 'cc_ai_insights', '"conversationId"');

    // ------------------------------------------------------------ automation

    await create('cc_automation_flows', [
      `"name" varchar(120) NOT NULL`,
      `"description" varchar(240)`,
      `"sessionId" varchar`,
      `"trigger" varchar(40) NOT NULL DEFAULT 'message_received'`,
      `"triggerAfterMinutes" integer`,
      `"conditions" text`,
      `"actions" text NOT NULL`,
      bool('enabled', true),
      int('cooldownSeconds', 300),
      int('executionCount', 0),
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_automation_flows_enabled', 'cc_automation_flows', '"enabled"');

    await create('cc_automation_executions', [
      `"flowId" varchar NOT NULL`,
      `"flowName" varchar(120)`,
      `"conversationId" varchar`,
      `"sessionId" varchar`,
      `"chatId" varchar(190)`,
      `"outcome" varchar(20) NOT NULL`,
      `"reason" varchar(240)`,
      `"actionResults" text`,
      stamp('createdAt'),
    ]);
    await index('IDX_cc_automation_executions_flowId', 'cc_automation_executions', '"flowId"');
    await index('IDX_cc_automation_executions_createdAt', 'cc_automation_executions', '"createdAt"');

    // ------------------------------------------------------- outbound queues

    await create('cc_scheduled_messages', [
      `"sessionId" varchar NOT NULL`,
      `"chatId" varchar(190) NOT NULL`,
      `"body" text NOT NULL`,
      `"runAt" ${pg ? 'timestamp' : 'text'} NOT NULL`,
      `"status" varchar(20) NOT NULL DEFAULT 'pending'`,
      `"error" varchar(240)`,
      `"createdBy" varchar(120)`,
      ts('sentAt'),
      stamp('createdAt'),
    ]);
    await index('IDX_cc_scheduled_messages_due', 'cc_scheduled_messages', '"status", "runAt"');

    await create('cc_broadcasts', [
      `"name" varchar(120) NOT NULL`,
      `"sessionId" varchar NOT NULL`,
      `"body" text NOT NULL`,
      `"audience" text`,
      `"status" varchar(20) NOT NULL DEFAULT 'draft'`,
      int('throttleMs', 3000),
      ts('scheduledAt'),
      `"approvedBy" varchar(120)`,
      ts('approvedAt'),
      ts('startedAt'),
      ts('completedAt'),
      int('totalRecipients', 0),
      int('sentCount', 0),
      int('failedCount', 0),
      stamp('createdAt'),
      stamp('updatedAt'),
    ]);
    await index('IDX_cc_broadcasts_status', 'cc_broadcasts', '"status"');

    await create('cc_broadcast_recipients', [
      `"broadcastId" varchar NOT NULL`,
      `"waId" varchar(190) NOT NULL`,
      `"name" varchar(120)`,
      `"status" varchar(20) NOT NULL DEFAULT 'pending'`,
      `"waMessageId" varchar(190)`,
      `"error" varchar(240)`,
      ts('sentAt'),
      stamp('createdAt'),
    ]);
    await index('IDX_cc_broadcast_recipients_broadcastId', 'cc_broadcast_recipients', '"broadcastId"');
    await index('IDX_cc_broadcast_recipients_pending', 'cc_broadcast_recipients', '"broadcastId", "status"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse creation order so a dialect that enforces the sessions FK drops the child first.
    // IF EXISTS throughout so a revert is idempotent on a synchronize-bootstrapped database, where
    // up() early-returned on hasTable and never created these objects itself.
    for (const table of [
      'cc_broadcast_recipients',
      'cc_broadcasts',
      'cc_scheduled_messages',
      'cc_automation_executions',
      'cc_automation_flows',
      'cc_ai_insights',
      'cc_follow_ups',
      'cc_quick_replies',
      'cc_contact_consent',
      'cc_customer_profiles',
      'cc_conversation_tags',
      'cc_tags',
      'cc_assignment_history',
      'cc_conversation_notes',
      'cc_conversations',
      'cc_team_members',
      'cc_teams',
      'cc_agents',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}
