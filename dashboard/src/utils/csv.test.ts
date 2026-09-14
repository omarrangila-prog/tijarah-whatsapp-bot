import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvCell, toCsv } from './csv.ts';

test('a cell starting with = is apostrophe-prefixed (formula neutralized)', () => {
  // The value contains double quotes, so structural quoting wraps it too — prefix stays inside.
  assert.equal(escapeCsvCell('=HYPERLINK("https://evil.example")'), `"'=HYPERLINK(""https://evil.example"")"`);
});

test('cells starting with +, -, @ are apostrophe-prefixed', () => {
  assert.equal(escapeCsvCell('+cmd'), `'+cmd`);
  assert.equal(escapeCsvCell('-2+3'), `'-2+3`);
  assert.equal(escapeCsvCell('@SUM(A1)'), `'@SUM(A1)`);
});

test('safe cells pass through unchanged', () => {
  assert.equal(escapeCsvCell('session.start'), 'session.start');
  assert.equal(escapeCsvCell('200'), '200');
  assert.equal(escapeCsvCell('a=b'), 'a=b'); // risky char not in leading position
  assert.equal(escapeCsvCell('info@example.com'), 'info@example.com');
  assert.equal(escapeCsvCell(''), '');
});

test('null/undefined become empty cells', () => {
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
});

test('a risky value that also needs quoting keeps the prefix inside the quotes', () => {
  assert.equal(escapeCsvCell('=1,2'), `"'=1,2"`);
});

test('structural quoting is unchanged for commas, quotes and newlines', () => {
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
});

describe('toCsv', () => {
  test('renders the header and rows in the requested column order', () => {
    const csv = toCsv([{ b: 2, a: 1 }], ['a', 'b']);
    assert.equal(csv, 'a,b\n1,2');
  });

  test('escapes every cell, so a formula in any export is neutralised', () => {
    const csv = toCsv([{ note: '=cmd()' }], ['note']);
    assert.equal(csv, "note\n'=cmd()");
  });

  test('quotes values containing separators', () => {
    const csv = toCsv([{ text: 'a,b' }], ['text']);
    assert.equal(csv, 'text\n"a,b"');
  });

  test('emits a header-only document for no rows', () => {
    assert.equal(toCsv([], ['a', 'b']), 'a,b');
  });
});
