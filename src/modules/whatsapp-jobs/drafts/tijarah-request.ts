/**
 * The shape Tijarah Books expects at `TijarahWhatsappBotRequest/UpsertRequest`.
 *
 * Everything a person composes over WhatsApp is submitted through this one endpoint, wrapped
 * in a common envelope. `requestStatus` is always `PENDING`: the specification repeats for all
 * twelve types that the result must "appear in Approval Screen on Tijarah Books (Do not make
 * final entry)", and PENDING is how that is expressed on the wire.
 *
 * There are four `requestData` shapes behind twelve types, which is why the code groups by
 * shape rather than by type — a sale and a purchase return differ only in a string.
 */

export type RequestFamily = 'document' | 'voucher' | 'party' | 'item';

export interface TijarahRequestSpec {
  /** Our internal id, e.g. `create_sale_invoice`. */
  documentType: string;
  displayName: string;
  /** What the host calls it: SALE, PURCHASE RETURN, PARTY, ITEM… */
  requestType: string;
  family: RequestFamily;
  /** Fixed extras the host wants inside requestData for this type. */
  fixedData?: Record<string, string>;
  /**
   * Present when the host has not built this one yet.
   *
   * Derived from {@link HOST_REQUEST_TYPES} by {@link isHostSupported} rather than set per
   * entry — a hand-kept flag went stale twice elsewhere in this work, and a stale one here
   * means a person fills in a whole document before the host refuses it.
   */
  pending?: boolean;
}

/**
 * `currentStep` is `<requestType>_DETAILS` for every type in the specification, including the
 * ones whose requestType contains a space ("SALE RETURN_DETAILS"). Derived rather than listed,
 * so the two can never drift apart.
 */
export function currentStepFor(requestType: string): string {
  return `${requestType}_DETAILS`;
}

/**
 * The request types `UpsertRequest` actually accepts today.
 *
 * Not a guess and not from the specification, which lists all twelve: the host answers
 * anything else with *"RequestType must be 'SALE', 'PURCHASE', 'PARTY', or 'ITEM'."* — so this
 * is its own words. The other eight are declared below because the specification asks for them
 * and the collection side is built; they become submittable the day Tijarah adds them here.
 */
export const HOST_REQUEST_TYPES: ReadonlySet<string> = new Set(['SALE', 'PURCHASE', 'PARTY', 'ITEM']);

/** Whether the host will accept this type at all. */
export function isHostSupported(spec: TijarahRequestSpec): boolean {
  return HOST_REQUEST_TYPES.has(spec.requestType);
}

export const TIJARAH_REQUESTS: readonly TijarahRequestSpec[] = [
  // Digital Invoice is listed in the specification as "is ki api baad me banegi" — the API for
  // it will be built later.
  {
    documentType: 'create_digital_invoice',
    displayName: 'Digital Invoice',
    requestType: 'DIGITAL',
    family: 'document',
  },
  { documentType: 'create_sale_invoice', displayName: 'Sale Invoice', requestType: 'SALE', family: 'document' },
  {
    documentType: 'create_purchase_invoice',
    displayName: 'Purchase Invoice',
    requestType: 'PURCHASE',
    family: 'document',
  },
  { documentType: 'create_sale_return', displayName: 'Sale Return', requestType: 'SALE RETURN', family: 'document' },
  {
    documentType: 'create_purchase_return',
    displayName: 'Purchase Return',
    requestType: 'PURCHASE RETURN',
    family: 'document',
  },
  { documentType: 'create_payment_voucher', displayName: 'Payment Voucher', requestType: 'PAYMENT', family: 'voucher' },
  { documentType: 'create_receive_voucher', displayName: 'Receive Voucher', requestType: 'RECEIVE', family: 'voucher' },
  {
    documentType: 'create_customer_account',
    displayName: 'Customer Account',
    requestType: 'PARTY',
    family: 'party',
    fixedData: { partyType: 'CUSTOMER' },
  },
  {
    documentType: 'create_vendor_account',
    displayName: 'Vendor Account',
    requestType: 'VENDOR',
    family: 'party',
    fixedData: { partyType: 'VENDOR' },
  },
  {
    documentType: 'create_expense_account',
    displayName: 'Expense Account',
    requestType: 'EXPENSE',
    family: 'party',
    fixedData: { partyType: 'EXPENSE' },
  },
  {
    documentType: 'create_chart_of_account',
    displayName: 'Chart of Account',
    requestType: 'ACCOUNT NAME',
    family: 'party',
    fixedData: { partyType: 'ACCOUNT' },
  },
  { documentType: 'create_item_account', displayName: 'Item Account', requestType: 'ITEM', family: 'item' },
];

export function findRequestSpec(documentType: string): TijarahRequestSpec | undefined {
  const spec = TIJARAH_REQUESTS.find(r => r.documentType === documentType);
  return spec ? { ...spec, pending: !isHostSupported(spec) } : undefined;
}

/** What a person may actually be told to create today, in the order the specification lists. */
export function submittableRequests(): readonly TijarahRequestSpec[] {
  return TIJARAH_REQUESTS.filter(isHostSupported);
}

/** A line on a document, exactly as the host names the fields. */
export interface TijarahItem {
  name: string;
  code: string;
  qty: number;
  rate: number;
  uom: string;
}

/** What a person fills in. Flat, so it survives being collected out of a text message. */
export interface CollectedFields {
  date?: string;
  referenceNo?: string;
  partyName?: string;
  partyCode?: string;
  discount?: string;
  // Vouchers
  fromName?: string;
  fromCode?: string;
  toName?: string;
  toCode?: string;
  amount?: string;
  remarks?: string;
  // Party and item
  name?: string;
  code?: string;
  phone?: string;
  address?: string;
  uom?: string;
  rate?: string;
}

const num = (value: string | undefined, fallback = 0): number => {
  const parsed = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Builds `requestData` for one type.
 *
 * A code the person did not supply becomes `NEW`, which is how the specification's own
 * examples express "this does not exist yet, create it" — a customer typing an unfamiliar
 * party name should not have their document rejected for want of a code they never had.
 */
export function buildRequestData(
  spec: TijarahRequestSpec,
  fields: CollectedFields,
  items: TijarahItem[],
): Record<string, unknown> {
  switch (spec.family) {
    case 'document':
      return {
        type: spec.requestType,
        date: fields.date ?? '',
        referenceNo: fields.referenceNo ?? '',
        party: { name: fields.partyName ?? '', code: fields.partyCode?.trim() || 'NEW' },
        items: items.map(i => ({ name: i.name, code: i.code || 'NEW', qty: i.qty, rate: i.rate, uom: i.uom || 'PCS' })),
        discount: num(fields.discount),
      };

    case 'voucher':
      return {
        type: spec.requestType,
        date: fields.date ?? '',
        referenceNo: fields.referenceNo ?? '',
        from: { name: fields.fromName ?? '', code: fields.fromCode?.trim() || 'NEW' },
        amount: num(fields.amount),
        to: { name: fields.toName ?? '', code: fields.toCode?.trim() || 'NEW' },
        remarks: fields.remarks ?? '',
      };

    case 'party':
      return {
        type: spec.requestType,
        ...(spec.fixedData ?? {}),
        name: fields.name ?? '',
        code: fields.code?.trim() || 'NEW',
        phone: fields.phone ?? '',
        address: fields.address ?? '',
      };

    case 'item':
      return {
        type: spec.requestType,
        name: fields.name ?? '',
        code: fields.code?.trim() || 'NEW',
        uom: fields.uom || 'PCS',
        rate: num(fields.rate),
      };
  }
}

export interface EnvelopeContext {
  whatsAppNo: string;
  sid: number;
  grp: string;
  aYear: string;
}

/** The full request body. `requestStatus` is PENDING and nothing may change that. */
export function buildEnvelope(
  spec: TijarahRequestSpec,
  context: EnvelopeContext,
  fields: CollectedFields,
  items: TijarahItem[],
): Record<string, unknown> {
  return {
    whatsAppNo: context.whatsAppNo,
    sid: context.sid,
    grp: context.grp,
    aYear: context.aYear,
    requestType: spec.requestType,
    currentStep: currentStepFor(spec.requestType),
    /*
     * Always PENDING, and deliberately not a parameter.
     *
     * This single field is what keeps a WhatsApp message from becoming an accounting entry.
     * Making it configurable would put the whole safety property of Phase Three one
     * environment variable away from being switched off.
     */
    requestStatus: 'PENDING',
    requestData: buildRequestData(spec, fields, items),
  };
}
