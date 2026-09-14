/**
 * Field mapping.
 *
 * A host's API returns `{"cust_id": 42, "party_name": "Ali Textiles", "bal_due": "150000"}`
 * and the port wants `{externalId, name, outstanding}`. This file is the translation, and
 * it is configuration rather than code so a new client is onboarded by writing JSON instead
 * of by shipping a release.
 *
 * The path syntax is deliberately small: dotted keys, `[0]` for array indices, and nothing
 * else. No expressions, no functions, no arithmetic. Two reasons, and the second is the
 * important one:
 *
 *   * A mapping language that can compute can compute a balance — and the entire premise of
 *     this agent is that it never does. `"outstanding": "total - paid"` looks harmless and
 *     is exactly the thing that must live in the host's accounting, where it can be
 *     audited, rather than in a config file nobody reviews.
 *   * A config file that can evaluate expressions is a config file that can run code, and
 *     these are edited by whoever sets up a client.
 *
 * A host whose data genuinely needs transforming should expose an endpoint that does it.
 */

import { BadRequestException } from '@nestjs/common';

/** A dotted path into a JSON document: `data.items[0].balance`. */
export type FieldPath = string;

const PATH_SEGMENT = /^[A-Za-z0-9_$-]+$/;

/**
 * Reads a value out of a JSON document by path.
 *
 * Returns `undefined` for anything missing rather than throwing, because "the host did not
 * send this field" is the caller's decision to make: a missing `email` is fine, a missing
 * `outstanding` is not, and only the port validator knows which is which.
 */
export function readPath(source: unknown, path: FieldPath): unknown {
  if (!path) return undefined;
  let cursor: unknown = source;

  for (const rawSegment of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;

    // `items[0]` — a key followed by any number of indices.
    const match = rawSegment.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!match) return undefined;
    const [, key, indices] = match;

    if (key) {
      if (typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (indices) {
      for (const index of indices.match(/\d+/g) ?? []) {
        if (!Array.isArray(cursor)) return undefined;
        cursor = cursor[Number(index)];
      }
    }
  }
  return cursor;
}

/**
 * One entity's mapping: our field name to the host's path.
 *
 * A value may also be a literal, written as `="PKR"`. That covers the common case of a host
 * that simply does not have a field — a single-currency ERP has no currency column, and the
 * alternative to a literal is a special case in the adapter for every such gap.
 */
export type EntityMapping = Record<string, string>;

export function applyMapping(source: unknown, mapping: EntityMapping): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(mapping)) {
    if (spec.startsWith('=')) {
      output[field] = spec.slice(1);
      continue;
    }
    const value = readPath(source, spec);
    if (value !== undefined) output[field] = value;
  }
  return output;
}

/**
 * Substitutes `{{name}}` placeholders in a URL path or query value.
 *
 * Every substituted value is URL-encoded, without exception. A customer id is host-supplied
 * data going into a URL this process constructs, and an id containing `../` or `?` would
 * otherwise redirect the request somewhere else in the host's API.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new BadRequestException(`The endpoint template refers to {{${key}}}, which was not supplied.`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Checks a mapping at save time rather than at send time.
 *
 * A typo in a path is otherwise discovered when a reminder fails to go out, which may be
 * days later and will look like an outage. Required fields are named per entity so the
 * setup screen can say "your invoice mapping has no dueDate" while someone is still looking
 * at it.
 */
export const REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  party: ['externalId', 'name'],
  invoice: ['externalId', 'number', 'issueDate', 'dueDate', 'total', 'outstanding'],
  facts: ['balance'],
  contact: ['name'],
  entry: ['date'],
  business: ['name'],
  receivable: ['outstanding'],
};

export function validateMapping(entity: string, mapping: EntityMapping): { field: string; problem: string }[] {
  const problems: { field: string; problem: string }[] = [];
  const required = REQUIRED_FIELDS[entity] ?? [];

  for (const field of required) {
    if (!mapping[field])
      problems.push({ field, problem: `${entity} mapping is missing "${field}", which is required.` });
  }
  for (const [field, spec] of Object.entries(mapping)) {
    if (spec.startsWith('=')) continue;
    if (spec.trim().length === 0) {
      problems.push({ field, problem: 'The path is empty.' });
      continue;
    }
    for (const segment of spec.split('.')) {
      const key = segment.replace(/\[\d+\]/g, '');
      if (key && !PATH_SEGMENT.test(key)) {
        problems.push({
          field,
          problem: `"${spec}" is not a plain dotted path. Only keys, dots and [n] indices are supported — no expressions.`,
        });
        break;
      }
    }
  }
  return problems;
}
