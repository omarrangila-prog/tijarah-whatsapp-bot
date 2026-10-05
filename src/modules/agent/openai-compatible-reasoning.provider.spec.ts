import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleReasoningProvider } from './openai-compatible-reasoning.provider';
import type { ReasoningRequest } from './agent-reasoning.interface';

/**
 * A stand-in host, over a real socket.
 *
 * The provider's job is to survive what a real OpenAI-compatible host does — including the
 * ways they differ from the spec — so the bytes actually cross a connection. A stubbed HTTP
 * client would agree with whatever the provider believed it sent, which is the thing under
 * test.
 */
function startHost(
  reply: (body: Record<string, unknown>) => { status?: number; json: unknown },
): Promise<{ server: Server; base: string; received: Record<string, unknown>[]; auth: string[] }> {
  const received: Record<string, unknown>[] = [];
  const auth: string[] = [];
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      auth.push(req.headers.authorization ?? '');
      let raw = '';
      req.on('data', chunk => (raw += String(chunk)));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        received.push(body);
        const answer = reply(body);
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${port}/v1`, received, auth });
    });
  });
}

const ask = (over: Partial<ReasoningRequest> = {}): ReasoningRequest =>
  ({
    system: 'You are a careful assistant.',
    messages: [{ role: 'user', content: 'send me the customer ledger' }],
    tools: [],
    maxTokens: 512,
    ...over,
  }) as ReasoningRequest;

const said = (content: string | null, toolCalls?: unknown[]) => ({
  json: {
    choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  },
});

describe('an OpenAI-compatible host as the reasoner', () => {
  let host: Awaited<ReturnType<typeof startHost>>;

  const configure = (base: string, model = 'kimi-k2') => {
    process.env.AI_BASE_URL = base;
    process.env.AI_API_KEY = 'sk-test-key';
    process.env.AI_MODEL = model;
  };

  afterEach(() => {
    host?.server.close();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
  });

  /* ------------------------------------------------------ availability */

  it('is unavailable until a host, a key and a model are all named', () => {
    const provider = new OpenAiCompatibleReasoningProvider();
    expect(provider.isAvailable()).toBe(false);

    process.env.AI_BASE_URL = 'https://example.test/v1';
    expect(provider.isAvailable()).toBe(false);
    process.env.AI_API_KEY = 'sk-x';
    expect(provider.isAvailable()).toBe(false);
    process.env.AI_MODEL = 'kimi-k2';
    expect(provider.isAvailable()).toBe(true);
  });

  it('defaults no host, so a misconfigured deployment cannot send a ledger somewhere unintended', () => {
    const provider = new OpenAiCompatibleReasoningProvider();

    expect(provider.model).toBeNull();
    expect(provider.isAvailable()).toBe(false);
    // And it says what is missing rather than reaching for a baked-in address.
    return expect(provider.reason(ask())).rejects.toThrow(/AI_BASE_URL/);
  });

  /* ------------------------------------------------------------ sending */

  it('sends the system prompt as a message and the key as a bearer token', async () => {
    host = await startHost(() => said('Right away.'));
    configure(host.base);

    const result = await new OpenAiCompatibleReasoningProvider().reason(ask());

    expect(result.text).toBe('Right away.');
    expect(result.finished).toBe(true);
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(7);

    const sent = host.received[0];
    expect(sent.model).toBe('kimi-k2');
    expect(sent.stream).toBe(false);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'You are a careful assistant.' },
      { role: 'user', content: 'send me the customer ledger' },
    ]);
    // In a header, never the URL: a query string ends up in logs and proxies.
    expect(host.auth[0]).toBe('Bearer sk-test-key');
  });

  it('trims a trailing slash rather than requesting //chat/completions', async () => {
    host = await startHost(() => said('ok'));
    configure(`${host.base}/`);

    await expect(new OpenAiCompatibleReasoningProvider().reason(ask())).resolves.toBeDefined();
  });

  it('passes tool schemas through untouched, unlike the Gemini reduction', async () => {
    host = await startHost(() => said('ok'));
    configure(host.base);
    const schema = {
      type: 'object',
      properties: { partyCode: { type: 'string', description: 'Account code' } },
      required: ['partyCode'],
      additionalProperties: false,
    };

    await new OpenAiCompatibleReasoningProvider().reason(
      ask({ tools: [{ name: 'RequestAccountingReport', description: 'Send a report.', inputSchema: schema }] }),
    );

    const sent = host.received[0] as { tools?: Array<{ function?: { parameters?: unknown } }>; tool_choice?: string };
    // `additionalProperties` survives — this format accepts standard JSON Schema.
    expect(sent.tools?.[0]?.function?.parameters).toEqual(schema);
    expect(sent.tool_choice).toBe('auto');
  });

  /* ------------------------------------------------------- tool calling */

  it('reads a tool call and reports the turn unfinished', async () => {
    host = await startHost(() =>
      said(null, [
        { id: 'call_abc', function: { name: 'RequestAccountingReport', arguments: '{"partyCode":"C-1005"}' } },
      ]),
    );
    configure(host.base);

    const result = await new OpenAiCompatibleReasoningProvider().reason(ask());

    expect(result.toolCalls).toEqual([
      { id: 'call_abc', name: 'RequestAccountingReport', input: { partyCode: 'C-1005' } },
    ]);
    // A turn that asked for a tool is not done; the runtime runs it and comes back.
    expect(result.finished).toBe(false);
  });

  it('invents an id when the host omits one, so the result can be matched back', async () => {
    host = await startHost(() => said(null, [{ function: { name: 'ReviewDraft', arguments: '{}' } }]));
    configure(host.base);

    const result = await new OpenAiCompatibleReasoningProvider().reason(ask());

    expect(result.toolCalls[0].id).toMatch(/^call_/);
    expect(result.toolCalls[0].id.length).toBeGreaterThan(5);
  });

  it('treats malformed arguments as empty rather than aborting the turn', async () => {
    // A model forgetting a brace must not become "something went wrong" for the person. The
    // tool's own zod schema then refuses it by name, which the model can act on.
    host = await startHost(() =>
      said(null, [{ id: 'c1', function: { name: 'ComposeDocument', arguments: '{"partyName": "Ahmed' } }]),
    );
    configure(host.base);

    const result = await new OpenAiCompatibleReasoningProvider().reason(ask());

    expect(result.toolCalls[0].input).toEqual({});
    expect(result.toolCalls[0].name).toBe('ComposeDocument');
  });

  it('ignores a tool call with no name instead of proposing an empty one', async () => {
    host = await startHost(() => said('ok', [{ id: 'c1', function: { arguments: '{}' } }]));
    configure(host.base);

    expect((await new OpenAiCompatibleReasoningProvider().reason(ask())).toolCalls).toEqual([]);
  });

  /* ---------------------------------------------------- conversation shape */

  it('sends a tool result as its own role, carrying the id it answers', async () => {
    host = await startHost(() => said('Sent.'));
    configure(host.base);

    await new OpenAiCompatibleReasoningProvider().reason(
      ask({
        messages: [
          { role: 'user', content: 'the ledger please' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ReviewDraft', input: { a: 1 } }] },
          { role: 'tool', toolCallId: 'c1', content: '{"queued":true}' },
        ],
      }),
    );

    const messages = host.received[0].messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ReviewDraft', arguments: '{"a":1}' } }],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"queued":true}' });
  });

  it('marks a failed tool result as an error, so the model can explain the refusal', async () => {
    host = await startHost(() => said('I cannot do that.'));
    configure(host.base);

    await new OpenAiCompatibleReasoningProvider().reason(
      ask({
        messages: [
          { role: 'user', content: 'send Ali the statement' },
          { role: 'tool', toolCallId: 'c1', content: 'Not allowed for this number.', isError: true },
        ],
      }),
    );

    const messages = host.received[0].messages as Array<{ content?: string }>;
    // A model that does not know it was blocked tries something else, which is how a fence
    // gets probed. It is told.
    expect(messages[2].content).toBe('ERROR: Not allowed for this number.');
  });

  /* ------------------------------------------------------------- failure */

  it('names the host in an error, and never the key', async () => {
    host = await startHost(() => ({ status: 401, json: { error: { message: 'Invalid Authentication' } } }));
    configure(host.base);

    const failure = new OpenAiCompatibleReasoningProvider().reason(ask());

    await expect(failure).rejects.toThrow(/responded 401/);
    // Naming it matters when hosts are interchangeable: "responded 401" alone sends whoever
    // is on call to check the wrong key.
    await expect(failure).rejects.toThrow(new RegExp(host.base.replace(/[/.]/g, '\\$&')));
    await expect(failure).rejects.not.toThrow(/sk-test-key/);
  });

  it('reports no tokens rather than inventing a count when the host omits usage', async () => {
    host = await startHost(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
    configure(host.base);

    const result = await new OpenAiCompatibleReasoningProvider().reason(ask());

    // A fabricated count would put imaginary spend on a real chart.
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('survives a host that answers with no choices at all', async () => {
    host = await startHost(() => ({ json: {} }));
    configure(host.base);

    const result = await new OpenAiCompatibleReasoningProvider().reason(ask());

    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(result.finished).toBe(true);
  });
});
