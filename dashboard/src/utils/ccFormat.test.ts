import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  chatKindLabel,
  formatBucketLabel,
  formatCount,
  formatMinutes,
  formatWaId,
  quickReplyQueryAt,
  relativeTime,
  replaceQuickReplyToken,
} from './ccFormat.ts';

describe('relativeTime', () => {
  const now = new Date('2026-01-10T12:00:00Z');

  test('shows "now" for anything under a minute', () => {
    assert.equal(relativeTime('2026-01-10T11:59:30Z', now), 'now');
  });

  test('shows "now" rather than a future time when the clocks disagree slightly', () => {
    assert.equal(relativeTime('2026-01-10T12:00:05Z', now), 'now');
  });

  test('steps through minutes, hours and days', () => {
    assert.equal(relativeTime('2026-01-10T11:45:00Z', now), '15m');
    assert.equal(relativeTime('2026-01-10T09:00:00Z', now), '3h');
    assert.equal(relativeTime('2026-01-08T12:00:00Z', now), '2d');
  });

  test('falls back to a date beyond a week', () => {
    assert.notEqual(relativeTime('2025-12-01T12:00:00Z', now), '');
    assert.ok(!relativeTime('2025-12-01T12:00:00Z', now).endsWith('d'));
  });

  test('returns an empty string for missing or invalid input', () => {
    assert.equal(relativeTime(null), '');
    assert.equal(relativeTime('not a date'), '');
  });
});

describe('formatMinutes', () => {
  test('returns null for no measurement, so callers can show a dash', () => {
    assert.equal(formatMinutes(null), null);
    assert.equal(formatMinutes(undefined), null);
    assert.equal(formatMinutes(Number.NaN), null);
  });

  test('never renders a sub-minute duration as 0m', () => {
    assert.equal(formatMinutes(0.4), '<1m');
  });

  test('picks the largest sensible unit', () => {
    assert.equal(formatMinutes(45), '45m');
    assert.equal(formatMinutes(90), '1h 30m');
    assert.equal(formatMinutes(120), '2h');
    assert.equal(formatMinutes(60 * 26), '1d 2h');
    assert.equal(formatMinutes(60 * 48), '2d');
  });
});

describe('formatCount', () => {
  test('separates thousands and distinguishes zero from missing', () => {
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(12345), (12345).toLocaleString());
    assert.equal(formatCount(null), '—');
  });
});

describe('formatWaId', () => {
  test('groups a phone id', () => {
    assert.equal(formatWaId('923001234567@c.us'), '+92 300 1234567');
  });

  test('labels non-person identities instead of showing a fake number', () => {
    assert.equal(formatWaId('923001234567-160000@g.us'), 'Group chat');
  });

  test('keeps privacy identities tellable apart', () => {
    // Several @lid contacts in one inbox would otherwise render as identical rows.
    assert.equal(formatWaId('18092734@lid'), 'Private identity · 2734');
    assert.notEqual(formatWaId('18092734@lid'), formatWaId('99011111@lid'));
  });

  test('returns the raw id when it is not a phone', () => {
    assert.equal(formatWaId('someone@newsletter'), 'someone@newsletter');
    assert.equal(formatWaId(null), '');
  });
});

describe('chatKindLabel', () => {
  test('maps engine kinds to readable labels', () => {
    assert.equal(chatKindLabel('group'), 'Group');
    assert.equal(chatKindLabel('individual'), 'Direct');
    assert.equal(chatKindLabel(undefined), 'Direct');
  });
});

describe('formatBucketLabel', () => {
  test('reduces an hourly bucket to the hour', () => {
    assert.equal(formatBucketLabel('2026-01-07 14:00'), '14:00');
  });

  test('leaves an unrecognised label alone rather than mangling it', () => {
    assert.equal(formatBucketLabel('week 3'), 'week 3');
  });
});

describe('quickReplyQueryAt', () => {
  test('detects a shortcut at the start of the input', () => {
    assert.equal(quickReplyQueryAt('/pri', 4), 'pri');
  });

  test('detects a shortcut after whitespace', () => {
    assert.equal(quickReplyQueryAt('Hello /pay', 10), 'pay');
  });

  test('ignores a slash inside a word, so URLs and dates do not open the picker', () => {
    assert.equal(quickReplyQueryAt('https://example.com', 19), null);
    assert.equal(quickReplyQueryAt('due 12/05', 9), null);
  });

  test('closes once the agent types past the shortcut', () => {
    assert.equal(quickReplyQueryAt('/price now', 10), null);
  });

  test('returns an empty query for a bare slash, so the full list opens', () => {
    assert.equal(quickReplyQueryAt('/', 1), '');
  });
});

describe('replaceQuickReplyToken', () => {
  test('swaps the token for the resolved text and moves the caret to the end', () => {
    const result = replaceQuickReplyToken('Hi /price', 9, 'our price is 1450');
    assert.equal(result.text, 'Hi our price is 1450');
    assert.equal(result.caret, 'Hi our price is 1450'.length);
  });

  test('preserves whatever follows the caret', () => {
    const result = replaceQuickReplyToken('/hello and more', 6, 'Hi there');
    assert.equal(result.text, 'Hi there and more');
  });

  test('leaves the text alone when there is no token', () => {
    assert.deepEqual(replaceQuickReplyToken('no token', 8, 'x'), { text: 'no token', caret: 8 });
  });
});
