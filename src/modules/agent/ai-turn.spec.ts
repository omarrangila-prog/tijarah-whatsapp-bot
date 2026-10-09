import { DataSource } from 'typeorm';
import { z } from 'zod';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AgentSettings } from './entities/agent-settings.entity';
import { AgentAdminNumber } from './entities/agent-admin-number.entity';
import { AgentToolPolicy } from './entities/agent-tool-policy.entity';
import { AgentApproval } from './entities/agent-approval.entity';
import { AgentTurn } from './entities/agent-turn.entity';
import { AgentEvent } from './entities/agent-event.entity';
import { CustomerProfile } from '../command-center/entities/customer-profile.entity';
import { ApprovalService } from './approval.service';
import { AgentRuntime, reportQuestion, rulesAreSure, whatsAppText } from './agent-runtime.service';
import { MockReasoningProvider } from './mock-reasoning.provider';
import { PermissionGuard } from '../../integrations/whatsapp/permission-guard';
import { ContactMapper } from '../../integrations/whatsapp/contact-mapper';
import { MockWhatsAppProvider } from '../../integrations/whatsapp/mock.provider';
import { MediaHandler } from '../../integrations/whatsapp/media-handler';
import { WhatsAppGateway } from '../../integrations/whatsapp/whatsapp.gateway';
import { defineTool } from '../../core/agent-tools/tool-descriptor';
import { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';
import { BotUserService } from '../whatsapp-jobs/tenancy/bot-user.service';
import type { ReasoningProvider, ReasoningRequest, ReasoningResponse } from './agent-reasoning.interface';

/**
 * A client's turn when a real model is configured.
 *
 * Found by replaying the clients' own messages through a live key: the model rephrased the
 * report tool's numbered questions (so the "2" that answered them matched nothing), drifted into
 * Hindi letters mid-word, printed **double asterisks**, and fetched SALE invoice 22 for "digital
 * invoce 22". A scripted model stands in for it here, so each of those is pinned without a key.
 */

const CLIENT = '923214455667';

/** Answers from a script, and records every request it was given. */
class ScriptedModel implements ReasoningProvider {
  readonly id = 'scripted';
  readonly model = 'scripted-1';
  readonly requests: ReasoningRequest[] = [];
  constructor(private readonly script: Array<Partial<ReasoningResponse>>) {}
  isAvailable(): boolean {
    return true;
  }
  reason(request: ReasoningRequest): Promise<ReasoningResponse> {
    this.requests.push(request);
    const next = this.script.shift() ?? { text: 'Done.' };
    const toolCalls = next.toolCalls ?? [];
    return Promise.resolve({
      text: next.text ?? '',
      toolCalls,
      finished: toolCalls.length === 0,
      inputTokens: 1,
      outputTokens: 1,
      model: this.model,
    });
  }
}

describe('a client turn answered by a model', () => {
  let ds: DataSource;
  let gateway: WhatsAppGateway;
  let reports: Array<Record<string, unknown>>;
  let reportAnswer: Record<string, unknown>;

  const boot = (model: ScriptedModel): void => {
    const registry = new ToolRegistryService([
      defineTool({
        name: 'RequestAccountingReport',
        description: 'Queue a report.',
        tier: 'write',
        requiredRole: ApiKeyRole.OPERATOR,
        senderScoped: true,
        inputSchema: z.object({
          senderPhone: z.string(),
          documentType: z.string(),
          documentNumber: z.string().optional(),
        }),
        handler: input => {
          reports.push(input);
          return Promise.resolve(reportAnswer);
        },
      }),
    ]);
    const auth = {
      validateApiKey: () => Promise.resolve({ id: 'key-1', role: ApiKeyRole.ADMIN }),
      hasPermission: () => true,
    };
    const approvals = new ApprovalService(ds.getRepository(AgentApproval), ds.getRepository(AgentSettings));
    const permissions = new PermissionGuard(
      ds.getRepository(AgentSettings),
      ds.getRepository(AgentToolPolicy),
      ds.getRepository(AgentTurn),
      ds.getRepository(AgentApproval),
      ds.getRepository(CustomerProfile),
    );
    const contacts = new ContactMapper(ds.getRepository(AgentAdminNumber), ds.getRepository(CustomerProfile));
    const tenant = { whatsAppNo: CLIENT, sid: 1, grp: 'GR', aYear: '2026', displayName: null };
    const botUsers = {
      lookup: (phone: string) =>
        Promise.resolve(phone.replace(/\D/g, '') === CLIENT ? { kind: 'registered', tenant } : { kind: 'unknown' }),
    };
    const moduleRef = {
      get: (token: unknown) => (token === BotUserService ? botUsers : registry),
    } as unknown as ConstructorParameters<typeof AgentRuntime>[0];
    const runtime = new AgentRuntime(
      moduleRef,
      auth as never,
      approvals,
      permissions,
      { get: () => undefined } as never,
      ds.getRepository(AgentTurn),
      // As deployed: the model first, the rules last.
      [model, new MockReasoningProvider()],
    );
    gateway = new WhatsAppGateway(runtime, contacts, new MediaHandler(), new MockWhatsAppProvider());
  };

  const say = (body: string) =>
    gateway.handleInbound('s1', {
      id: `W-${Math.random().toString(36).slice(2)}`,
      from: `${CLIENT}@c.us`,
      body,
      type: 'chat',
      timestamp: 1756900000,
    });

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        AgentSettings,
        AgentAdminNumber,
        AgentToolPolicy,
        AgentApproval,
        AgentTurn,
        AgentEvent,
        CustomerProfile,
      ],
      synchronize: true,
    });
    await ds.initialize();
    // The policy the AllowChatReportRequests migration writes: a client's report runs unasked.
    await ds.getRepository(AgentToolPolicy).save({
      toolName: 'RequestAccountingReport',
      senderRole: 'client',
      level: 'ALLOW_AUTOMATICALLY',
      allowedRecipients: null,
      note: null,
    });
    reports = [];
    reportAnswer = { queued: true, jobId: 'JOB-1' };
    process.env.AGENT_API_KEY = 'test-agent-key';
    // As on the Tijarah deployment: a number on the registry is served as a client.
    process.env.BOT_REQUIRE_REGISTRATION = 'true';
  });

  afterEach(async () => {
    await ds.destroy();
    delete process.env.AGENT_API_KEY;
    delete process.env.BOT_REQUIRE_REGISTRATION;
  });

  it("sends the report tool's question word for word, and stops there", async () => {
    const question =
      'Which customer?\n\nJust send me the name — for example *Danyal*.\nOr send *all* to get every customer.';
    reportAnswer = { queued: false, needsParty: 'customer', reason: question };
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'RequestAccountingReport', input: { documentType: 'customer_ledger' } }] },
      // Never reached: a rephrasing here is what the "2" afterwards could not be matched against.
      { text: 'Kaunsa customer chahiye?' },
    ]);
    boot(model);

    const result = await say('mujhe woh cheez bhejo jo pichli dafa maangi thi');

    expect(result.text).toBe(question);
    expect(model.requests).toHaveLength(1);
  });

  it('has a reply written in Hindi letters rewritten in English letters', async () => {
    const model = new ScriptedModel([
      { text: 'OTP ka masla yahan हल nahi ho sakta.' },
      { text: 'OTP ka masla yahan hal nahi ho sakta.' },
    ]);
    boot(model);

    const result = await say('OTP nahi aa raha');

    expect(result.text).toBe('OTP ka masla yahan hal nahi ho sakta.');
    // The rewrite is offered no tools: it can only change the words.
    expect(model.requests[1].tools).toEqual([]);
  });

  it('sends the reply as written if the rewrite still has Hindi letters', async () => {
    const model = new ScriptedModel([{ text: 'Ji, हल ho jayega.' }, { text: 'Ji, हल ho jayega.' }]);
    boot(model);

    expect((await say('OTP nahi aa raha')).text).toBe('Ji, हल ho jayega.');
  });

  it('turns **bold** into the single asterisks WhatsApp shows as bold', async () => {
    boot(new ScriptedModel([{ text: '## Account\n**Customer Account** tayyar hai.' }]));

    expect((await say('portal pe login nahi ho raha')).text).toBe('Account\n*Customer Account* tayyar hai.');
  });

  it('leaves a document by number to the rules, without asking the model', async () => {
    const model = new ScriptedModel([
      { toolCalls: [{ id: 'c1', name: 'RequestAccountingReport', input: { documentType: 'sale_invoice' } }] },
    ]);
    boot(model);

    await say('digital invoce 22');

    expect(model.requests).toHaveLength(0);
    expect(reports).toEqual([expect.objectContaining({ documentType: 'digital_invoice', documentNumber: '22' })]);
    const turn = await ds.getRepository(AgentTurn).findOne({ where: { senderPhone: `+${CLIENT}` } });
    expect(turn?.providerId).toBe('mock');
  });
});

describe('which messages the rules are sure of', () => {
  it.each([
    'digital invoce 22',
    'sale retrun 5',
    'purchse invoice 122',
    'payment vochar 12',
    'trial balnce',
    'recivable list',
    'daniyal ka ledgr jan se ab tak',
    'sale invoice',
  ])('%j goes to the rules', text => {
    expect(rulesAreSure(text)).toBe(true);
  });

  it.each([
    // A word the rules would drop: the item.
    'sugar ka stock kitna hai',
    'summer collection stock',
    // Conversation and questions the rules cannot read.
    'OTP nahi aa raha',
    'mujhe batao kis kis ne paise dene hain',
    'aaj cricket match kon jeeta',
    // Long messages say more than their keywords.
    'jo ledger aap ne kal bheja tha us mein Danyal ka balance ghalat hai please check kar ke dobara bhejo',
  ])('%j goes to the model', text => {
    expect(rulesAreSure(text)).toBe(false);
  });
});

describe('the pieces of a model turn', () => {
  it('reads a question out of a report tool result, and nothing else', () => {
    expect(reportQuestion(JSON.stringify({ queued: false, needsPeriod: true, reason: 'For which dates?' }))).toBe(
      'For which dates?',
    );
    expect(reportQuestion(JSON.stringify({ queued: false, reason: 'Did you mean one of these?\n1. A' }))).toContain(
      'Did you mean',
    );
    // A refusal the model can correct is not a question for the person.
    expect(
      reportQuestion(JSON.stringify({ queued: false, reason: '"x" is not a report that can be requested.' })),
    ).toBeNull();
    expect(reportQuestion(JSON.stringify({ queued: true, jobId: 'J1' }))).toBeNull();
    expect(reportQuestion('not json')).toBeNull();
  });

  it('writes model text the way WhatsApp formats it', () => {
    expect(whatsAppText('**Total:** Rs. 500')).toBe('*Total:* Rs. 500');
    expect(whatsAppText('# Heading\nline')).toBe('Heading\nline');
    expect(whatsAppText('*already bold*')).toBe('*already bold*');
  });
});
