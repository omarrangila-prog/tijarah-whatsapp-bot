import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerName, summariseReasoning, type ReasoningProviderStatus } from './reasoningHealth.ts';

function provider(overrides: Partial<ReasoningProviderStatus> & { id: string }): ReasoningProviderStatus {
  return { model: null, available: false, lastOkAt: null, lastError: null, lastErrorAt: null, ...overrides };
}

const mock = provider({ id: 'mock', available: true });

test('an AI that is answering is reported as answering, with its model', () => {
  const health = summariseReasoning([
    provider({ id: 'openAiCompatible', available: true, model: 'kimi-k2', lastOkAt: '2026-10-07T10:00:00Z' }),
    mock,
  ]);
  assert.equal(health.level, 'ok');
  assert.equal(health.headline, 'your AI provider is answering (kimi-k2)');
  assert.equal(health.advice, null);
  assert.equal(health.activeId, 'openAiCompatible');
});

test('no AI configured falls back to fixed phrasings, and says which settings to fill in', () => {
  const health = summariseReasoning([mock]);
  assert.equal(health.level, 'fallback');
  assert.match(health.headline, /No AI is set up/);
  assert.match(health.advice ?? '', /AI_API_KEY/);
  assert.equal(health.activeId, 'mock');
});

test('a configured AI whose last call failed is the one to fix, and its error is the advice', () => {
  const health = summariseReasoning([
    provider({
      id: 'gemini',
      available: true,
      lastError: '429 … exceeded your current quota',
      lastErrorAt: '2026-10-07T10:05:00Z',
    }),
    mock,
  ]);
  assert.equal(health.level, 'degraded');
  assert.equal(health.headline, 'Gemini is not answering, so only fixed phrasings are understood');
  assert.match(health.advice ?? '', /quota/);
  assert.equal(health.activeId, 'gemini');
});

test('an error followed by a success is history, not a fault', () => {
  const health = summariseReasoning([
    provider({
      id: 'openAiCompatible',
      available: true,
      lastError: 'socket hang up',
      lastErrorAt: '2026-10-07T10:00:00Z',
      lastOkAt: '2026-10-07T10:04:00Z',
    }),
    mock,
  ]);
  assert.equal(health.level, 'ok');
});

test('a provider that has never succeeded and never failed is still the one being asked', () => {
  const health = summariseReasoning([provider({ id: 'openAiCompatible', available: true }), mock]);
  assert.equal(health.level, 'ok');
  assert.equal(health.headline, 'your AI provider is answering');
});

test('the first configured provider is the active one — the order is the order it tries them', () => {
  const health = summariseReasoning([
    provider({ id: 'openAiCompatible', available: true, model: 'kimi-k2' }),
    provider({ id: 'gemini', available: true }),
    mock,
  ]);
  assert.equal(health.activeId, 'openAiCompatible');
});

test('an unconfigured provider is not the active one even when listed first', () => {
  const health = summariseReasoning([
    provider({ id: 'openAiCompatible', available: false, lastError: 'no key' }),
    provider({ id: 'gemini', available: true }),
    mock,
  ]);
  assert.equal(health.level, 'ok');
  assert.equal(health.activeId, 'gemini');
});

test('a server too old to report reasoning is not called a fault', () => {
  const health = summariseReasoning(undefined);
  assert.equal(health.level, 'fallback');
  assert.equal(health.activeId, null);
});

test('provider ids are given office-readable names, and an unknown id is passed through', () => {
  assert.equal(providerName('gemini'), 'Gemini');
  assert.equal(providerName('mock'), 'the built-in rules');
  assert.equal(providerName('somethingNew'), 'somethingNew');
});
