import { anthropicBaseUrl, openAiBaseUrl } from './ai-base-url';

describe('the AI_BASE_URL setting, as each client needs it', () => {
  it('adds /v1 to a bare host for OpenAI-style clients', () => {
    expect(openAiBaseUrl('https://api.openai.fans')).toBe('https://api.openai.fans/v1');
    expect(openAiBaseUrl('https://api.openai.fans/')).toBe('https://api.openai.fans/v1');
  });

  it('keeps a path the operator already gave', () => {
    expect(openAiBaseUrl('https://api.openai.fans/v1')).toBe('https://api.openai.fans/v1');
    expect(openAiBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai',
    );
    expect(openAiBaseUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1');
  });

  it('takes a full endpoint pasted in place of the base', () => {
    expect(openAiBaseUrl('https://api.openai.fans/v1/chat/completions')).toBe('https://api.openai.fans/v1');
  });

  it('is null when unset or blank, so no address is ever invented', () => {
    expect(openAiBaseUrl(undefined)).toBeNull();
    expect(openAiBaseUrl('  ')).toBeNull();
    expect(anthropicBaseUrl('')).toBeNull();
  });

  it('drops /v1 for the Anthropic SDK, which adds its own', () => {
    expect(anthropicBaseUrl('https://api.openai.fans/v1')).toBe('https://api.openai.fans');
    expect(anthropicBaseUrl('https://api.openai.fans/v1/messages')).toBe('https://api.openai.fans');
    expect(anthropicBaseUrl('https://api.openai.fans')).toBe('https://api.openai.fans');
  });
});
