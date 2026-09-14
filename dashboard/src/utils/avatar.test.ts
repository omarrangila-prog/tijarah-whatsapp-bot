import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarColor, initials } from './avatar.ts';

describe('avatarColor', () => {
  test('is stable for a given seed', () => {
    assert.equal(avatarColor('923001234567@c.us'), avatarColor('923001234567@c.us'));
  });

  test('distinguishes different seeds', () => {
    const colors = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(avatarColor));
    assert.ok(colors.size > 1);
  });

  test('always returns a hex colour, including for an empty seed', () => {
    assert.match(avatarColor(''), /^#[0-9a-f]{6}$/i);
  });
});

describe('initials', () => {
  test('takes the first and last word of a full name', () => {
    assert.equal(initials('Ayesha Noor Khan'), 'AK');
  });

  test('takes two letters from a single word', () => {
    assert.equal(initials('Bilal'), 'BI');
  });

  test('falls back rather than rendering an empty circle', () => {
    assert.equal(initials(null), '?');
    assert.equal(initials('   '), '?');
    assert.equal(initials(undefined, '#'), '#');
  });
});
