import { createServer, type Server } from 'node:http';
import { VoiceTranscriber } from './voice-transcriber';
import { WhatsAppGateway } from './whatsapp.gateway';
import { MediaHandler } from './media-handler';
import type { AgentRuntime } from '../../modules/agent/agent-runtime.service';
import type { ContactMapper } from './contact-mapper';
import type { WhatsAppProvider } from './whatsapp-provider.interface';
import type { NormalizedAgentMessage } from './agent-message.types';

/**
 * Voice notes, over a real socket: a stand-in for an OpenAI-compatible `/audio/transcriptions`
 * endpoint receives the multipart upload exactly as a provider would.
 */
function startTranscriptionApi(answer: (body: string) => { status: number; body: string }) {
  const received: Array<{ auth: string | undefined; body: string; contentType: string | undefined }> = [];
  return new Promise<{ server: Server; base: string; received: typeof received }>(resolve => {
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('latin1');
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body, contentType: req.headers['content-type'] });
        const reply = req.url === '/v1/audio/transcriptions' ? answer(body) : { status: 404, body: '{}' };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, received });
    });
  });
}

const OGG = Buffer.from('OggS fake opus voice note').toString('base64');
const ENV_KEYS = [
  'AI_BASE_URL',
  'AI_API_KEY',
  'TRANSCRIBE_BASE_URL',
  'TRANSCRIBE_API_KEY',
  'TRANSCRIBE_MODEL',
  'TRANSCRIBE_ENABLED',
  'TRANSCRIBE_LANGUAGE',
];

describe('VoiceTranscriber', () => {
  const saved: Record<string, string | undefined> = {};
  let api: Awaited<ReturnType<typeof startTranscriptionApi>>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (api) await new Promise(resolve => api.server.close(resolve));
  });

  it('is off without a provider, and returns nothing', async () => {
    const transcriber = new VoiceTranscriber();
    expect(transcriber.isConfigured()).toBe(false);
    expect(await transcriber.transcribe(OGG, 'audio/ogg')).toBeNull();
  });

  it('uploads the note with the AI key and model, and returns the words', async () => {
    api = await startTranscriptionApi(() => ({
      status: 200,
      body: JSON.stringify({ text: ' Danyal ka   ledger bhej do ' }),
    }));
    process.env.AI_BASE_URL = api.base;
    process.env.AI_API_KEY = 'sk-test';
    const transcriber = new VoiceTranscriber();
    expect(await transcriber.transcribe(OGG, 'audio/ogg; codecs=opus')).toBe('Danyal ka ledger bhej do');
    const [call] = api.received;
    expect(call.auth).toBe('Bearer sk-test');
    expect(call.contentType).toContain('multipart/form-data');
    expect(call.body).toContain('name="model"\r\n\r\nwhisper-1');
    expect(call.body).toContain('filename="voice-note.ogg"');
    expect(call.body).toContain('OggS fake opus voice note');
  });

  it('can use its own provider and model', async () => {
    api = await startTranscriptionApi(() => ({ status: 200, body: '{"text":"trial balance"}' }));
    process.env.AI_BASE_URL = 'http://127.0.0.1:1/never';
    process.env.AI_API_KEY = 'sk-reasoning';
    process.env.TRANSCRIBE_BASE_URL = api.base;
    process.env.TRANSCRIBE_API_KEY = 'sk-voice';
    process.env.TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
    expect(await new VoiceTranscriber().transcribe(OGG, 'audio/ogg')).toBe('trial balance');
    expect(api.received[0].auth).toBe('Bearer sk-voice');
    expect(api.received[0].body).toContain('gpt-4o-mini-transcribe');
  });

  it('a refusal or an empty result is "could not hear", never an exception', async () => {
    api = await startTranscriptionApi(() => ({ status: 400, body: '{"error":{"message":"model not found"}}' }));
    process.env.AI_BASE_URL = api.base;
    process.env.AI_API_KEY = 'sk-test';
    expect(await new VoiceTranscriber().transcribe(OGG, 'audio/ogg')).toBeNull();
  });
});

describe('a voice note through the gateway', () => {
  function build(transcriber?: Partial<VoiceTranscriber>) {
    const seen: NormalizedAgentMessage[] = [];
    const sent: string[] = [];
    const runtime = {
      handle: jest.fn((message: NormalizedAgentMessage) => {
        seen.push({ ...message });
        return Promise.resolve({
          text: 'Customer Ledger — for which dates?',
          attachments: [],
          actions: [],
          pendingApprovalId: null,
          shouldReply: true,
        });
      }),
    } as unknown as AgentRuntime;
    const contacts = {
      resolveSender: () => Promise.resolve({ role: 'customer', contactId: null }),
    } as unknown as ContactMapper;
    const provider = {
      sendText: jest.fn((input: { text: string }) => {
        sent.push(input.text);
        return Promise.resolve({ messageId: 'm1', mock: true });
      }),
    } as unknown as WhatsAppProvider;
    const gateway = new WhatsAppGateway(
      runtime,
      contacts,
      new MediaHandler(),
      provider,
      transcriber as VoiceTranscriber | undefined,
    );
    return { gateway, seen, sent };
  }

  const voiceNote = {
    id: 'wamid.voice.1',
    from: '923001234567@c.us',
    type: 'voice',
    body: '',
    mimetype: 'audio/ogg; codecs=opus',
    size: 2048,
    media: { mimetype: 'audio/ogg; codecs=opus', data: OGG },
  };

  it('is transcribed and answered like a typed message, quoting what was heard', async () => {
    const transcriber = {
      isConfigured: () => true,
      transcribe: jest.fn().mockResolvedValue('Danyal ka ledger bhej do'),
    };
    const { gateway, seen, sent } = build(transcriber);
    await gateway.handleInbound('s1', voiceNote);
    expect(transcriber.transcribe).toHaveBeenCalledWith(OGG, 'audio/ogg; codecs=opus');
    expect(seen[0]).toMatchObject({ messageType: 'audio', text: 'Danyal ka ledger bhej do' });
    expect(sent[0]).toBe('_"Danyal ka ledger bhej do"_\n\nCustomer Ledger — for which dates?');
  });

  it('without a transcriber it still reaches the runtime as a voice note (not an empty text)', async () => {
    const { gateway, seen } = build();
    await gateway.handleInbound('s1', voiceNote);
    expect(seen[0]).toMatchObject({ messageType: 'audio', text: '' });
  });
});
