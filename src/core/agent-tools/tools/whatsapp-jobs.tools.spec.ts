import { whatsappJobTools } from './whatsapp-jobs.tools';
import type { WhatsAppJobsService } from '../../../modules/whatsapp-jobs/whatsapp-jobs.service';
import type { ContactMapper, ContactMatch } from '../../../integrations/whatsapp/contact-mapper';
import type { ApiKey } from '../../../modules/auth/entities/api-key.entity';

/**
 * §6's rules, as tests.
 *
 * The tool exists to create a row, and the interesting behaviour is all in what it refuses to
 * do first: it must not guess which contact was meant, and it must not create a second job for
 * a delivery that is already queued.
 */
describe('create_whatsapp_document_job', () => {
  const match = (name: string, phone: string): ContactMatch => ({
    contactId: `c-${phone}`,
    waId: `${phone}@c.us`,
    phoneE164: phone,
    displayName: name,
    company: name,
    customerType: null,
    city: null,
    matchedOn: 'name',
  });

  const build = (overrides: { create?: unknown; searchContacts?: unknown } = {}) => {
    const created: unknown[] = [];
    const jobs = {
      create:
        overrides.create ??
        ((input: Record<string, unknown>) => {
          created.push(input);
          return Promise.resolve({ reference: 'JOB-1001', status: 'PENDING' });
        }),
    } as unknown as WhatsAppJobsService;
    const contacts = {
      searchContacts: overrides.searchContacts ?? (() => Promise.resolve([] as ContactMatch[])),
    } as unknown as ContactMapper;
    const [tool] = whatsappJobTools({ jobs: () => jobs, contacts: () => contacts });
    return { tool, created };
  };

  const input = (overrides: Record<string, unknown> = {}) => ({
    document_type: 'invoice',
    document_reference: 'INV-1001',
    recipient_whatsapp_number: '+923001234567',
    ...overrides,
  });

  /*
   * The registry's descriptors are a union, so `inputSchema.parse` widens to `unknown` and
   * TypeScript will not hand that to `handler`. The cast is confined to this one helper
   * rather than sprinkled through the tests, and the schema still does the real validation.
   */
  const run = async (tool: ReturnType<typeof build>['tool'], args: Record<string, unknown>) => {
    const parsed = tool.inputSchema.parse(args) as never;
    return (await tool.handler(parsed, {} as ApiKey)) as Record<string, unknown>;
  };

  it('queues a delivery once the document and recipient are known', async () => {
    const { tool, created } = build();
    const result = await run(tool, input({ recipient_name: 'Ali Accounts', parameters: { invoiceId: 'INV-1001' } }));

    expect(result.created).toBe(true);
    expect(result.jobId).toBe('JOB-1001');
    // The number is normalised before it is stored — one comparison form everywhere.
    expect((created[0] as Record<string, unknown>).recipientWhatsAppNumber).toBe('923001234567');
    // The agent creates a row. It does not fetch the document and does not send anything.
    expect((created[0] as Record<string, unknown>).source).toBe('agent');
  });

  it('asks rather than guessing when several contacts share the name', async () => {
    const { tool, created } = build({
      searchContacts: () =>
        Promise.resolve([match('Ali Traders', '923001111111'), match('Ali Textiles', '923002222222')]),
    });
    const result = await run(tool, input({ recipient_name: 'Ali' }));

    expect(result.created).toBe(false);
    expect(String(result.reason)).toMatch(/more than one/i);
    expect(result.candidates).toHaveLength(2);
    // Nothing was queued: sending one customer another's invoice is the failure being avoided.
    expect(created).toHaveLength(0);
  });

  it('proceeds when the number given is one of the matching contacts', async () => {
    const { tool, created } = build({
      searchContacts: () =>
        Promise.resolve([match('Ali Traders', '923001234567'), match('Ali Textiles', '923002222222')]),
    });
    const result = await run(tool, input({ recipient_name: 'Ali' }));

    // The ambiguity is resolved by the number, so there is nothing to ask about.
    expect(result.created).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('refuses a number that cannot be a WhatsApp number', async () => {
    const { tool, created } = build();
    // Twenty digits: long enough to satisfy the schema's 8–24 length rule, but past the 15
    // digits E.164 allows, so normalisation rejects it. This is the gap the guard covers —
    // a string that looks plausible to the schema and is undialable in practice.
    const result = await run(tool, input({ recipient_whatsapp_number: '+12345678901234567890' }));

    expect(result.created).toBe(false);
    expect(String(result.reason)).toMatch(/usable WhatsApp number/i);
    // Nothing queued, so the worker never fetches a document for a delivery that cannot land.
    expect(created).toHaveLength(0);
  });

  it('reports a duplicate as an outcome, not an error to route around', async () => {
    const conflict = Object.assign(new Error('Conflict'), {
      response: {
        message: 'A job with this idempotencyKey already exists; no duplicate was created.',
        jobId: 'JOB-1001',
      },
    });
    const { tool } = build({ create: () => Promise.reject(conflict) });
    const result = await run(tool, input());

    expect(result.created).toBe(false);
    expect(result.duplicateOf).toBe('JOB-1001');
  });

  it('is on the write tier and out of reach of a customer', () => {
    const { tool } = build();
    expect(tool.tier).toBe('write');
    // Not on the customer allowlist in permission-guard.ts, so no customer message reaches it.
    expect(tool.name).toBe('create_whatsapp_document_job');
  });
});
