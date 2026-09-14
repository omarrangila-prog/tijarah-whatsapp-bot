import { buildSystemPrompt } from './agent-prompt';

/**
 * A model has no clock. Asked for "this year's ledger" it resolved the year from its training
 * data and fetched 2024 — a real report, delivered, for the wrong year, with nothing to say it
 * was wrong. The prompt now states the date, and this pins how.
 */
describe('the prompt tells the model what day it is', () => {
  const base = { senderRole: 'admin' as const, senderName: 'Omar', nonce: 'abc123', restricted: false };

  it('states the date in Karachi, not UTC', () => {
    // 23:30 UTC on the 13th is already the 14th in Karachi (UTC+5). The books are kept there.
    const prompt = buildSystemPrompt({ ...base, now: new Date('2026-09-13T23:30:00Z') });
    expect(prompt).toContain("Today's date is 2026-09-14");
  });

  it('explains what relative periods mean against that date', () => {
    const prompt = buildSystemPrompt({ ...base, now: new Date('2026-09-14T10:00:00Z') });
    expect(prompt).toMatch(/"This year" means the calendar year of that date/);
  });

  it('honours an explicit time zone', () => {
    const prompt = buildSystemPrompt({ ...base, now: new Date('2026-09-13T23:30:00Z'), timeZone: 'UTC' });
    expect(prompt).toContain("Today's date is 2026-09-13");
  });
});
