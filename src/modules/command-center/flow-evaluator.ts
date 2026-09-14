import type { FlowCondition } from './entities/automation-flow.entity';

/** Everything a condition can be evaluated against, assembled by the caller before evaluation. */
export interface FlowContext {
  body: string;
  sessionId: string;
  chatKind: string;
  /** Tag NAMES currently on the conversation, lowercased by the evaluator. */
  contactTags: string[];
  conversationStatus: string;
  conversationPriority: string;
  /** Evaluation time — passed in rather than read from the clock so the logic stays testable. */
  now: Date;
  businessHours: BusinessHours;
}

export interface BusinessHours {
  /** Minutes from midnight, local server time. */
  startMinutes: number;
  endMinutes: number;
  /** Days the business is open, 0 = Sunday. */
  days: number[];
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  startMinutes: 9 * 60,
  endMinutes: 18 * 60,
  days: [1, 2, 3, 4, 5],
};

/**
 * Evaluate one WHEN→IF→THEN condition.
 *
 * String comparisons are case-insensitive unless the condition opts in, because an operator writing
 * `contains "price"` means the word, not the casing. `is`/`isNot` are exact-match aliases so the
 * builder can offer natural verbs per field type without a second operator vocabulary.
 */
export function evaluateCondition(condition: FlowCondition, context: FlowContext): boolean {
  if (condition.field === 'businessHours') {
    const open = isWithinBusinessHours(context.now, context.businessHours);
    const wants = condition.value === 'true' || condition.value === 'open' || condition.value === 'inside';
    // `isNot` inverts, so "business hours is not open" reads the way an operator would say it.
    const matches = open === wants;
    return condition.operator === 'isNot' || condition.operator === 'notContains' ? !matches : matches;
  }

  if (condition.field === 'contactTag') {
    const wanted = condition.value.trim().toLowerCase();
    const has = context.contactTags.some(tag => tag.toLowerCase() === wanted);
    return condition.operator === 'isNot' || condition.operator === 'notContains' ? !has : has;
  }

  const actual = String(fieldValue(condition.field, context) ?? '');
  const expected = condition.value ?? '';
  const [left, right] = condition.caseSensitive ? [actual, expected] : [actual.toLowerCase(), expected.toLowerCase()];

  switch (condition.operator) {
    case 'contains':
      return left.includes(right);
    case 'notContains':
      return !left.includes(right);
    case 'startsWith':
      return left.startsWith(right);
    case 'equals':
    case 'is':
      return left === right;
    case 'isNot':
      return left !== right;
    default:
      // An unknown operator must not silently match everything — a rule an operator cannot read is
      // a rule that should not fire.
      return false;
  }
}

function fieldValue(field: FlowCondition['field'], context: FlowContext): string {
  switch (field) {
    case 'body':
      return context.body;
    case 'sessionId':
      return context.sessionId;
    case 'chatKind':
      return context.chatKind;
    case 'conversationStatus':
      return context.conversationStatus;
    case 'conversationPriority':
      return context.conversationPriority;
    default:
      return '';
  }
}

/** ALL conditions must hold. An empty or absent list matches everything, like the webhook filters. */
export function evaluateConditions(conditions: FlowCondition[] | null | undefined, context: FlowContext): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(condition => evaluateCondition(condition, context));
}

/** Local-time business-hours check. An end before the start denotes an overnight window. */
export function isWithinBusinessHours(now: Date, hours: BusinessHours): boolean {
  if (!hours.days.includes(now.getDay())) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (hours.endMinutes >= hours.startMinutes) {
    return minutes >= hours.startMinutes && minutes < hours.endMinutes;
  }
  return minutes >= hours.startMinutes || minutes < hours.endMinutes;
}

/** Parse `HH:MM` into minutes from midnight, or null when it is not a time. */
export function parseClock(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
