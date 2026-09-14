import { request as undiciRequest } from 'undici';
import { GeminiReasoningProvider } from './gemini-reasoning.provider';
import type { ReasoningRequest } from './agent-reasoning.interface';

jest.mock('undici', () => ({ request: jest.fn() }));
const httpRequest = undiciRequest as unknown as jest.Mock;

/**
 * The Gemini provider, checked on the three places its REST shape differs from the one the
 * rest of this codebase was written against. Each of them fails as an opaque 400 if wrong.
 */
describe('GeminiReasoningProvider', () => {
  let provider: GeminiReasoningProvider;

  beforeEach(() => {
    httpRequest.mockReset();
    provider = new GeminiReasoningProvider();
    process.env.GEMINI_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
  });

  const asBody = (mock: jest.Mock): Record<string, unknown> => {
    const [, options] = mock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(options.body) as Record<string, unknown>;
  };

  const request = (over: Partial<ReasoningRequest> = {}): ReasoningRequest => ({
    system: 'You are an assistant.',
    messages: [{ role: 'user', content: 'who is overdue' }],
    tools: [],
    ...over,
  });

  it('is available only with a key', () => {
    expect(provider.isAvailable()).toBe(true);
    delete process.env.GEMINI_API_KEY;
    expect(provider.isAvailable()).toBe(false);
  });

  it('defaults to a model on the free tier, and honours an override', () => {
    expect(provider.model).toBe('gemini-3.6-flash');
    process.env.GEMINI_MODEL = 'gemini-3.6-pro';
    expect(provider.model).toBe('gemini-3.6-pro');
  });

  it('keeps only the schema keywords Gemini understands', () => {
    /*
     * An allowlist, because Gemini rejects the WHOLE request on the first keyword it does not
     * know — every tool, not just the offending one — with a 400 naming a numeric path. This
     * was found in production: `propertyNames`, emitted by z.record, took the agent down.
     */
    const cleaned = (
      provider as unknown as { toGeminiSchema(s: Record<string, unknown>): Record<string, unknown> }
    ).toGeminiSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      propertyNames: { type: 'string' },
      properties: {
        mode: { type: 'string', enum: ['Cash', 'Bank'], const: 'Cash' },
        note: { type: 'string', description: 'free text' },
      },
      required: ['mode'],
    });

    const serialised = JSON.stringify(cleaned);
    for (const banned of ['$schema', 'additionalProperties', 'propertyNames', 'const']) {
      expect(serialised).not.toContain(banned);
    }
    // What Gemini needs survives, including the property NAMES themselves.
    expect(cleaned.type).toBe('object');
    expect(cleaned.required).toEqual(['mode']);
    expect(Object.keys(cleaned.properties as Record<string, unknown>)).toEqual(['mode', 'note']);
    expect((cleaned.properties as Record<string, { enum?: string[] }>).mode.enum).toEqual(['Cash', 'Bank']);
  });

  it('turns a free-form object into something Gemini will accept', () => {
    // z.record produces an object with no declared properties, which Gemini rejects outright.
    const cleaned = (
      provider as unknown as { toGeminiSchema(s: Record<string, unknown>): Record<string, unknown> }
    ).toGeminiSchema({ type: 'object', description: 'Passed to the document API' });

    expect(cleaned.type).toBe('string');
    expect(cleaned.description).toBe('Passed to the document API');
  });

  it('strips the JSON Schema keywords Gemini refuses', () => {
    // $schema, additionalProperties and const make it reject the whole request with a flat
    // 400 that names no tool — and the registry's zod schemas emit all three.
    const cleaned = (
      provider as unknown as { toGeminiSchema(s: Record<string, unknown>): Record<string, unknown> }
    ).toGeminiSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { mode: { type: 'string', const: 'Cash', default: 'Cash' } },
    });

    const serialised = JSON.stringify(cleaned);
    expect(serialised).not.toContain('$schema');
    expect(serialised).not.toContain('additionalProperties');
    expect(serialised).not.toContain('const');
    // What Gemini does need survives.
    expect(cleaned.type).toBe('object');
    expect(serialised).toContain('mode');
  });

  it('sends the system prompt in its own field, not as a message', () => {
    const contents = (provider as unknown as { toContents(m: ReasoningRequest['messages']): unknown[] }).toContents([
      { role: 'user', content: 'hello' },
    ]);
    // Gemini has no system role; putting one in `contents` is a 400.
    expect(JSON.stringify(contents)).not.toContain('system');
  });

  it('presents a tool result as a functionResponse on a user turn', () => {
    const contents = (
      provider as unknown as { toContents(m: ReasoningRequest['messages']): Array<Record<string, unknown>> }
    ).toContents([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'LedgerListOverdue', name: 'LedgerListOverdue', input: {} }],
      },
      { role: 'tool', toolCallId: 'LedgerListOverdue', content: '{"rows":2}', isError: false },
    ]);

    expect(contents[0].role).toBe('model');
    // The documented shape: the answer comes back as the user replying.
    expect(contents[1].role).toBe('user');
    expect(JSON.stringify(contents[1])).toContain('functionResponse');
    expect(JSON.stringify(contents[1])).toContain('LedgerListOverdue');
  });

  it('tells the model when a tool call failed', () => {
    const contents = (
      provider as unknown as { toContents(m: ReasoningRequest['messages']): Array<Record<string, unknown>> }
    ).toContents([{ role: 'tool', toolCallId: 'X', content: 'refused', isError: true }]);
    // Hiding the failure would have it silently try something else instead of explaining.
    expect(JSON.stringify(contents[0])).toContain('"isError":true');
  });

  it('reads text and tool calls out of one response', async () => {
    httpRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        text: () =>
          Promise.resolve(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      { text: 'Checking that for you.' },
                      { functionCall: { name: 'RequestAccountingReport', args: { documentType: 'general_ledger' } } },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
            }),
          ),
      },
    });

    const result = await provider.reason(request());

    expect(result.text).toBe('Checking that for you.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('RequestAccountingReport');
    // Not finished: a tool was asked for, so the turn continues.
    expect(result.finished).toBe(false);
    expect(result.inputTokens).toBe(120);

    // The key travels in a header, never the URL, which ends up in logs and proxies.
    const [url, options] = httpRequest.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).not.toContain('test-key');
    expect(options.headers['x-goog-api-key']).toBe('test-key');
    expect(asBody(httpRequest).systemInstruction).toBeDefined();
  });

  it('surfaces an API failure without echoing anything sensitive', async () => {
    httpRequest.mockResolvedValueOnce({
      statusCode: 429,
      body: { text: () => Promise.resolve('{"error":{"message":"Quota exceeded"}}') },
    });

    // A free tier runs out; the runtime falls through to the next provider, so the error has
    // to say what happened rather than throwing something unreadable.
    await expect(provider.reason(request())).rejects.toThrow(/429/);
  });

  it('refuses to run without a key rather than calling out anonymously', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(provider.reason(request())).rejects.toThrow(/GEMINI_API_KEY/);
  });
});
