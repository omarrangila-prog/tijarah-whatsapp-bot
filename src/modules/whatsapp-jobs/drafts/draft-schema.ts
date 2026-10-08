import {
  findRequestSpec,
  TIJARAH_REQUESTS,
  type CollectedFields,
  type TijarahRequestSpec,
  isHostSupported,
} from './tijarah-request';
import { labelsFor } from './request-template';

/**
 * What each creatable document needs, derived from the host's own contract.
 *
 * This used to hold its own list of field names — `partyName`, `documentDate`, `mode` — written
 * before the real API was known. When the contract arrived with `date`, `referenceNo`,
 * `party.name` and the rest, there were two definitions of the same thing and they had already
 * drifted: a draft collected fields the submission could not use.
 *
 * There is now one definition. The families in `tijarah-request.ts` say what the host wants,
 * `request-template.ts` says what each field is called to a person, and this derives the
 * collection rules from both.
 */

export type DraftFieldKind = 'text' | 'number' | 'money' | 'date' | 'phone' | 'choice';

export interface DraftFieldSpec {
  name: keyof CollectedFields;
  label: string;
  kind: DraftFieldKind;
  required: boolean;
  hint?: string;
}

export interface CreatableTypeSpec {
  documentType: string;
  displayName: string;
  /** False where the host has no request type for it yet — see `HOST_REQUEST_TYPES`. */
  submittable: boolean;
  /** True when the document carries line items rather than a single amount. */
  hasLineItems: boolean;
  fields: DraftFieldSpec[];
}

/** How a field should be validated, by the name the host uses for it. */
const KINDS: Readonly<Partial<Record<keyof CollectedFields, DraftFieldKind>>> = {
  date: 'date',
  amount: 'money',
  rate: 'money',
  discount: 'money',
  phone: 'phone',
};

/**
 * The fields the host will reject a request without.
 *
 * Deliberately short. Everything else the host accepts empty, and asking a person for a
 * reference number they do not have is how a bot becomes something people avoid using.
 */
const REQUIRED: Readonly<Record<string, ReadonlyArray<keyof CollectedFields>>> = {
  document: ['date', 'partyName'],
  voucher: ['date', 'fromName', 'amount'],
  party: ['name'],
  item: ['name'],
};

const HINTS: Readonly<Partial<Record<keyof CollectedFields, string>>> = {
  // Day-first, the way dates are written here; the ISO form is still accepted.
  date: 'like 01-10-2026, or "today"',
  partyCode: 'Leave as NEW if the account does not exist yet',
  code: 'Leave as NEW if it does not exist yet',
  uom: 'e.g. PCS, KG, METER',
};

function toSpec(request: TijarahRequestSpec): CreatableTypeSpec {
  const required = REQUIRED[request.family] ?? [];
  return {
    documentType: request.documentType,
    displayName: request.displayName,
    submittable: isHostSupported(request),
    hasLineItems: request.family === 'document',
    fields: labelsFor(request).map(([label, name]) => ({
      name,
      label,
      kind: KINDS[name] ?? 'text',
      required: required.includes(name),
      hint: HINTS[name],
    })),
  };
}

/**
 * Every creatable type, with `submittable` read from the environment at call time.
 *
 * A function rather than a constant so that `TIJARAH_REQUEST_TYPES` is honoured by the process
 * that reads it, not frozen by whichever module happened to load first.
 */
export function creatableTypes(): readonly CreatableTypeSpec[] {
  return TIJARAH_REQUESTS.map(toSpec);
}

/** The list as it stood at load time. Prefer {@link creatableTypes} where `submittable` matters. */
export const CREATABLE_TYPES: readonly CreatableTypeSpec[] = creatableTypes();

/** A line on a document, named as the host names them. */
export interface DraftLineItem {
  description: string;
  quantity: string;
  rate: string;
}

export function findCreatableType(documentType: string): CreatableTypeSpec | undefined {
  const request = findRequestSpec(documentType);
  return request ? toSpec(request) : undefined;
}
