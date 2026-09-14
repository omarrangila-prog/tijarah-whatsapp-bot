import {
  buildEnvelope,
  type CollectedFields,
  type EnvelopeContext,
  type TijarahItem,
  type TijarahRequestSpec,
} from './tijarah-request';

/**
 * The fill-in form a person receives, and the reader that turns it back into a request.
 *
 * Asking for a sale invoice field by field is eleven round trips on WhatsApp. A form is one
 * message out and one back, it can be edited before sending, and it shows the whole document
 * at once — which is how anyone actually checks an invoice before submitting it.
 *
 * The field labels are the client's own, from the specification, and are not changed: the
 * template and the JSON body have to stay recognisably the same thing to whoever reads both.
 */

/** Labels shown to a person, paired with the field they fill. */
const DOCUMENT_LABELS: ReadonlyArray<readonly [string, keyof CollectedFields]> = [
  ['Date', 'date'],
  ['Invoice/Reference No', 'referenceNo'],
  ['Customer/Supplier', 'partyName'],
  ['Code', 'partyCode'],
];

const VOUCHER_LABELS: ReadonlyArray<readonly [string, keyof CollectedFields]> = [
  ['Date', 'date'],
  ['Reference No', 'referenceNo'],
  ['From', 'fromName'],
  ['From Code', 'fromCode'],
  ['To', 'toName'],
  ['To Code', 'toCode'],
  ['Amount', 'amount'],
  ['Remarks', 'remarks'],
];

const PARTY_LABELS: ReadonlyArray<readonly [string, keyof CollectedFields]> = [
  ['Name', 'name'],
  ['Code', 'code'],
  ['Phone', 'phone'],
  ['Address', 'address'],
];

const ITEM_LABELS: ReadonlyArray<readonly [string, keyof CollectedFields]> = [
  ['Item Name', 'name'],
  ['Code', 'code'],
  ['UOM', 'uom'],
  ['Rate', 'rate'],
];

export function labelsFor(spec: TijarahRequestSpec): ReadonlyArray<readonly [string, keyof CollectedFields]> {
  switch (spec.family) {
    case 'document':
      return DOCUMENT_LABELS;
    case 'voucher':
      return VOUCHER_LABELS;
    case 'party':
      return PARTY_LABELS;
    case 'item':
      return ITEM_LABELS;
  }
}

/**
 * The blank form for one request type.
 *
 * `Code` is left saying NEW rather than blank, because that is what the host expects for
 * something it has not seen before and a person should not have to know that.
 */
export function buildTemplate(spec: TijarahRequestSpec, context: EnvelopeContext): string {
  const lines: string[] = [
    `Type: ${spec.requestType}`,
    '',
    `T-ID: ${context.sid}`,
    `Company ID: ${context.grp}`,
    `Year: ${context.aYear}`,
    '',
  ];

  for (const [label, field] of labelsFor(spec)) {
    const suggested =
      field === 'partyCode' || field === 'code' || field === 'fromCode' || field === 'toCode' ? 'NEW' : '';
    lines.push(`${label}: ${suggested}`);
  }

  if (spec.family === 'document') {
    lines.push(
      '',
      'Items:',
      '',
      '1. Item Name: ',
      '   Code: NEW',
      '   Qty: ',
      '   Rate: ',
      '   UOM: PCS',
      '',
      'Discount: 0',
    );
  }

  return lines.join('\n');
}

/** Whether a message looks like one of these forms coming back, rather than ordinary chat. */
export function looksLikeFilledTemplate(text: string): boolean {
  return /^\s*type\s*:/im.test(text) && /^\s*(t-id|company id|year)\s*:/im.test(text);
}

export interface ParsedTemplate {
  requestType: string | null;
  context: Partial<EnvelopeContext>;
  fields: CollectedFields;
  items: TijarahItem[];
  /** Labels the person left empty that the host needs. */
  missing: string[];
}

const num = (value: string | undefined): number => {
  const parsed = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Reads a filled-in form.
 *
 * Tolerant on purpose: people reply on a phone, so labels arrive in any case, with stray
 * spaces, and sometimes with the numbering renumbered or lines reordered. What it will not do
 * is infer a value that was left blank — a missing quantity becomes a reported omission
 * rather than a 1, because guessing a number on an invoice is how the wrong amount gets
 * submitted for approval.
 */
export function parseTemplate(text: string, spec: TijarahRequestSpec): ParsedTemplate {
  const lines = text.split('\n');

  /*
   * The header is read only from above "Items:".
   *
   * Both the party and every line carry a label called "Code", and flattening the whole
   * message keeps whichever came last — so a sale invoice submitted the final item's code as
   * the customer's, quietly attaching the document to the wrong account. Splitting at the
   * items heading is what keeps the two apart.
   */
  const itemsAt = lines.findIndex(line => /^\s*items\s*:/i.test(line));
  const headerLines = itemsAt === -1 ? lines : lines.slice(0, itemsAt);
  const flat = new Map<string, string>();

  for (const line of headerLines) {
    const match = /^\s*(?:\d+\.\s*)?([A-Za-z][A-Za-z /_-]*?)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    flat.set(match[1].trim().toLowerCase(), match[2].trim());
  }

  // Discount sits below the items, so it is read from the whole message rather than the header.
  const discountLine = lines.find(line => /^\s*discount\s*:/i.test(line));
  const discountValue = discountLine ? discountLine.split(':').slice(1).join(':').trim() : undefined;

  const context: Partial<EnvelopeContext> = {};
  const sid = flat.get('t-id') ?? flat.get('sid');
  if (sid) context.sid = num(sid);
  const grp = flat.get('company id') ?? flat.get('grp');
  if (grp) context.grp = grp;
  const year = flat.get('year') ?? flat.get('ayear');
  if (year) context.aYear = year;

  const fields: CollectedFields = {};
  const missing: string[] = [];
  for (const [label, field] of labelsFor(spec)) {
    const value = flat.get(label.toLowerCase());
    if (value) fields[field] = value;
  }

  /*
   * Items are read as blocks rather than from the flat map: a form carries several lines all
   * labelled "Qty", and flattening keeps only the last one.
   */
  const items: TijarahItem[] = [];
  if (spec.family === 'document') {
    let current: Partial<TijarahItem> | null = null;
    const push = (): void => {
      if (current?.name) {
        items.push({
          name: current.name,
          code: current.code || 'NEW',
          qty: current.qty ?? 0,
          rate: current.rate ?? 0,
          uom: current.uom || 'PCS',
        });
      }
      current = null;
    };

    for (const line of itemsAt === -1 ? lines : lines.slice(itemsAt + 1)) {
      const match = /^\s*(?:\d+\.\s*)?([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1].trim().toLowerCase();
      const value = match[2].trim();

      if (key === 'item name') {
        push();
        current = value ? { name: value } : null;
        continue;
      }
      if (!current) continue;
      if (key === 'code') current.code = value;
      if (key === 'qty') current.qty = num(value);
      if (key === 'rate') current.rate = num(value);
      if (key === 'uom') current.uom = value;
    }
    push();

    if (!items.length) missing.push('At least one item');
    for (const [index, item] of items.entries()) {
      if (!item.qty) missing.push(`Qty for item ${index + 1}`);
      if (!item.rate) missing.push(`Rate for item ${index + 1}`);
    }
    fields.discount = discountValue ?? '0';
  }

  /* Required labels, by family. Anything else on the form is optional. */
  const required: Array<[string, keyof CollectedFields]> =
    spec.family === 'document'
      ? [
          ['Date', 'date'],
          ['Customer/Supplier', 'partyName'],
        ]
      : spec.family === 'voucher'
        ? [
            ['Date', 'date'],
            ['From', 'fromName'],
            ['Amount', 'amount'],
          ]
        : [[spec.family === 'item' ? 'Item Name' : 'Name', 'name']];

  for (const [label, field] of required) {
    if (!fields[field]?.trim()) missing.push(label);
  }

  return { requestType: flat.get('type') ?? null, context, fields, items, missing };
}

/** A filled form, as the request body the host will receive. */
export function templateToEnvelope(
  parsed: ParsedTemplate,
  spec: TijarahRequestSpec,
  fallback: EnvelopeContext,
): Record<string, unknown> {
  return buildEnvelope(
    spec,
    {
      whatsAppNo: fallback.whatsAppNo,
      // The form's own values win: a person filling a different company or year means it.
      sid: parsed.context.sid ?? fallback.sid,
      grp: parsed.context.grp ?? fallback.grp,
      aYear: parsed.context.aYear ?? fallback.aYear,
    },
    parsed.fields,
    parsed.items,
  );
}
