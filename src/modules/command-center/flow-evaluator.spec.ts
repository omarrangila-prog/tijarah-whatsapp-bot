import type { FlowCondition } from './entities/automation-flow.entity';
import {
  DEFAULT_BUSINESS_HOURS,
  evaluateCondition,
  evaluateConditions,
  isWithinBusinessHours,
  parseClock,
  type FlowContext,
} from './flow-evaluator';

const context = (overrides: Partial<FlowContext> = {}): FlowContext => ({
  body: 'What is the price for 500 shirts?',
  sessionId: 'sales-line',
  chatKind: 'individual',
  contactTags: ['VIP'],
  conversationStatus: 'open',
  conversationPriority: 'normal',
  // A Wednesday at 11:00 local time — inside the default business window.
  now: new Date(2026, 0, 7, 11, 0, 0),
  businessHours: DEFAULT_BUSINESS_HOURS,
  ...overrides,
});

const condition = (overrides: Partial<FlowCondition>): FlowCondition => ({
  field: 'body',
  operator: 'contains',
  value: 'price',
  ...overrides,
});

describe('evaluateCondition', () => {
  it('matches body text case-insensitively by default', () => {
    expect(evaluateCondition(condition({ value: 'PRICE' }), context())).toBe(true);
  });

  it('honours an explicit case-sensitive flag', () => {
    expect(evaluateCondition(condition({ value: 'PRICE', caseSensitive: true }), context())).toBe(false);
  });

  it('supports notContains as the negation of contains', () => {
    expect(evaluateCondition(condition({ operator: 'notContains', value: 'refund' }), context())).toBe(true);
    expect(evaluateCondition(condition({ operator: 'notContains', value: 'price' }), context())).toBe(false);
  });

  it('supports startsWith', () => {
    expect(evaluateCondition(condition({ operator: 'startsWith', value: 'what is' }), context())).toBe(true);
  });

  it('matches equals and is identically', () => {
    const ctx = context();
    expect(evaluateCondition(condition({ field: 'sessionId', operator: 'equals', value: 'sales-line' }), ctx)).toBe(
      true,
    );
    expect(evaluateCondition(condition({ field: 'sessionId', operator: 'is', value: 'sales-line' }), ctx)).toBe(true);
    expect(evaluateCondition(condition({ field: 'sessionId', operator: 'isNot', value: 'sales-line' }), ctx)).toBe(
      false,
    );
  });

  it('matches a contact tag regardless of casing', () => {
    expect(evaluateCondition(condition({ field: 'contactTag', operator: 'is', value: 'vip' }), context())).toBe(true);
    expect(evaluateCondition(condition({ field: 'contactTag', operator: 'is', value: 'lead' }), context())).toBe(false);
  });

  it('inverts a contact-tag check with isNot', () => {
    expect(evaluateCondition(condition({ field: 'contactTag', operator: 'isNot', value: 'lead' }), context())).toBe(
      true,
    );
  });

  it('reads business hours from the evaluation time, not the wall clock', () => {
    const inside = condition({ field: 'businessHours', operator: 'is', value: 'true' });
    expect(evaluateCondition(inside, context())).toBe(true);
    // Same Wednesday, 22:00 — outside the window.
    expect(evaluateCondition(inside, context({ now: new Date(2026, 0, 7, 22, 0, 0) }))).toBe(false);
  });

  it('refuses to match on an operator it does not understand', () => {
    // A rule an operator cannot read is a rule that must not fire.
    const bogus = { field: 'body', operator: 'regex', value: '.*' } as unknown as FlowCondition;
    expect(evaluateCondition(bogus, context())).toBe(false);
  });
});

describe('evaluateConditions', () => {
  it('matches everything when the list is empty or absent', () => {
    expect(evaluateConditions([], context())).toBe(true);
    expect(evaluateConditions(null, context())).toBe(true);
  });

  it('requires every condition to hold', () => {
    const all = [condition({}), condition({ field: 'chatKind', operator: 'is', value: 'individual' })];
    expect(evaluateConditions(all, context())).toBe(true);

    const withMiss = [...all, condition({ field: 'conversationPriority', operator: 'is', value: 'urgent' })];
    expect(evaluateConditions(withMiss, context())).toBe(false);
  });
});

describe('isWithinBusinessHours', () => {
  it('is closed on a day outside the configured week', () => {
    // 2026-01-04 is a Sunday.
    expect(isWithinBusinessHours(new Date(2026, 0, 4, 11, 0), DEFAULT_BUSINESS_HOURS)).toBe(false);
  });

  it('treats the end time as exclusive', () => {
    expect(isWithinBusinessHours(new Date(2026, 0, 7, 17, 59), DEFAULT_BUSINESS_HOURS)).toBe(true);
    expect(isWithinBusinessHours(new Date(2026, 0, 7, 18, 0), DEFAULT_BUSINESS_HOURS)).toBe(false);
  });

  it('handles an overnight window', () => {
    const overnight = { startMinutes: 22 * 60, endMinutes: 6 * 60, days: [1, 2, 3, 4, 5] };
    expect(isWithinBusinessHours(new Date(2026, 0, 7, 23, 30), overnight)).toBe(true);
    expect(isWithinBusinessHours(new Date(2026, 0, 7, 3, 0), overnight)).toBe(true);
    expect(isWithinBusinessHours(new Date(2026, 0, 7, 12, 0), overnight)).toBe(false);
  });
});

describe('parseClock', () => {
  it('parses HH:MM into minutes from midnight', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('9:05')).toBe(545);
  });

  it('rejects nonsense rather than guessing', () => {
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('09:60')).toBeNull();
    expect(parseClock('half nine')).toBeNull();
    expect(parseClock(undefined)).toBeNull();
  });
});
