import { DataSource } from 'typeorm';
import { DocumentDraft } from './document-draft.entity';
import { DraftService, coerceDate } from './draft.service';
import { findRequestSpec, hostRequestTypes, submittableRequests } from './tijarah-request';
import { MockApprovalSubmissionAdapter, toSubmissionPayload } from './approval-submission.port';
import { CREATABLE_TYPES } from './draft-schema';

/**
 * Phase Three: composing a document in chat and sending it for approval.
 *
 * The specification repeats one constraint for all twelve types — "Appear in Approval Screen
 * on Tijarah Books (Do not make final entry)". Most of what is tested here is that constraint
 * and the ownership rules that protect it.
 */
describe('document drafts', () => {
  let ds: DataSource;
  let service: DraftService;
  let submission: MockApprovalSubmissionAdapter;

  const OWNER = '923001234567';
  const OTHER = '923009998877';

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [DocumentDraft], synchronize: true });
    await ds.initialize();
    submission = new MockApprovalSubmissionAdapter();
    service = new DraftService(ds.getRepository(DocumentDraft), submission);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** Fills an invoice to the point where it can be submitted. */
  const completeInvoice = async () => {
    await service.start(OWNER, 'create_sale_invoice');
    await service.setField(OWNER, 'partyName', 'Ali Traders');
    await service.setField(OWNER, 'date', '2026-09-10');
    await service.addLineItem(OWNER, { description: 'Cotton fabric', quantity: '250', rate: '600' });
  };

  it('offers all twelve creatable types from the specification', () => {
    expect(service.listCreatableTypes()).toHaveLength(12);
    expect(CREATABLE_TYPES.map(t => t.displayName)).toEqual(
      expect.arrayContaining([
        'Sale Invoice',
        'Payment Voucher',
        'Customer Account',
        'Chart of Account',
        'Item Account',
      ]),
    );
  });

  it('walks through the fields it needs, one at a time', async () => {
    const started = await service.start(OWNER, 'create_sale_invoice');
    expect(started.ok).toBe(true);
    // "Who is it for?" comes before "what date?" — how a person raises an invoice, not how
    // the form happens to be laid out.
    expect(started.nextField?.name).toBe('partyName');

    const named = await service.setField(OWNER, 'partyName', 'Ali Traders');
    expect(named.ok).toBe(true);
    expect(named.nextField?.name).toBe('date');

    const dated = await service.setField(OWNER, 'date', 'today');
    // "today" is a thing people type; it becomes a real date rather than being refused.
    expect(dated.draft?.fields?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dated.nextField).toBeNull();
  });

  it('will not call an invoice complete with no lines on it', async () => {
    await service.start(OWNER, 'create_sale_invoice');
    await service.setField(OWNER, 'partyName', 'Ali Traders');
    await service.setField(OWNER, 'date', '2026-09-10');

    const draft = (await service.openDraftFor(OWNER)) as DocumentDraft;
    // A customer, a date and nothing on it is not a document anyone can approve.
    expect(service.isComplete(draft)).toBe(false);

    const submitted = await service.submit(OWNER);
    expect(submitted.ok).toBe(false);
    expect(submitted.message).toMatch(/line item/i);
  });

  it('adds up the lines for review', async () => {
    await completeInvoice();
    const draft = (await service.openDraftFor(OWNER)) as DocumentDraft;
    const review = service.review(draft);

    expect(review.readyToSubmit).toBe(true);
    expect(review.total).toBe('150000.00');
    expect(review.missing).toBeNull();
  });

  it('submits for approval and never as an entry', async () => {
    await completeInvoice();
    const result = await service.submit(OWNER);

    expect(result.ok).toBe(true);
    expect(result.draft?.status).toBe('SUBMITTED');
    expect(result.draft?.submittedRef).toBeTruthy();

    /*
     * The payload says what it is asking for, in the two places the host might look. The
     * specification is explicit for all twelve types: this must reach an approval screen and
     * must not post an entry.
     */
    const [sent] = submission.submitted;
    expect(sent.payload.status).toBe('PENDING_APPROVAL');
    expect(sent.payload.finalise).toBe(false);
    expect(sent.payload.documentType).toBe('sale_invoice');
  });

  it('refuses to submit the same document twice', async () => {
    await completeInvoice();
    await service.submit(OWNER);

    // The draft is closed, so there is nothing open to submit again — the same document on the
    // approval screen twice gets approved by somebody who assumes it is a second order.
    const again = await service.submit(OWNER);
    expect(again.ok).toBe(false);
    expect(submission.submitted).toHaveLength(1);
  });

  it('keeps a draft usable when the accounting system refuses it', async () => {
    await completeInvoice();
    const failing = new DraftService(ds.getRepository(DocumentDraft), {
      name: 'failing',
      submitForApproval: () =>
        Promise.resolve({ ok: false, approvalRef: null, message: 'The accounting system refused it (503).' }),
    });

    const result = await failing.submit(OWNER);
    expect(result.ok).toBe(false);
    // Nothing reached the approval screen, so it stays ready and can be tried again.
    expect((await failing.openDraftFor(OWNER))?.status).toBe('READY');
  });

  it('allows one draft at a time per person', async () => {
    await service.start(OWNER, 'create_sale_invoice');
    const second = await service.start(OWNER, 'create_purchase_invoice');

    // Two half-built documents in one conversation means an answer landing on the wrong one.
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already have/i);
  });

  it("keeps one person out of another person's draft", async () => {
    await service.start(OWNER, 'create_sale_invoice');

    expect(await service.openDraftFor(OTHER)).toBeNull();
    const intruder = await service.setField(OTHER, 'partyName', 'Someone Else');
    expect(intruder.ok).toBe(false);
    expect(intruder.message).toMatch(/no document in progress/i);
  });

  it('refuses a value that is not what the field is for', async () => {
    // An item's rate, because the voucher this used to test cannot be started any more: the
    // host accepts four request types and PAYMENT is not one of them.
    await service.start(OWNER, 'create_item_account');
    await service.setField(OWNER, 'name', 'Cotton Shirt');

    expect((await service.setField(OWNER, 'rate', 'about fifty thousand')).ok).toBe(false);
    // Commas are how people write money; they are stripped rather than rejected.
    expect((await service.setField(OWNER, 'rate', '50,000')).draft?.fields?.rate).toBe('50000');
  });

  it('declines a type the host has not built, at the moment it is asked for', async () => {
    const result = await service.start(OWNER, 'create_receive_voucher');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot be created over WhatsApp yet/i);
    // And says what can be, rather than leaving the person guessing.
    expect(result.message).toMatch(/Sale Invoice/);
    expect(await service.openDraftFor(OWNER)).toBeNull();
  });

  it('refuses a field the document does not have', async () => {
    await service.start(OWNER, 'create_customer_account');
    const result = await service.setField(OWNER, 'quantity', '5');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no field called/i);
  });

  it('refuses line items on a document that has none', async () => {
    await service.start(OWNER, 'create_customer_account');
    const result = await service.addLineItem(OWNER, { description: 'x', quantity: '1', rate: '1' });
    expect(result.ok).toBe(false);
  });

  it('creates an account with only its name, and nothing else required', async () => {
    await service.start(OWNER, 'create_customer_account');
    await service.setField(OWNER, 'name', 'New Customer Ltd');

    const draft = (await service.openDraftFor(OWNER)) as DocumentDraft;
    expect(service.isComplete(draft)).toBe(true);
    expect((await service.submit(OWNER)).ok).toBe(true);
  });

  it('cancels cleanly, leaving the person free to start another', async () => {
    await service.start(OWNER, 'create_sale_invoice');
    expect((await service.cancel(OWNER)).ok).toBe(true);
    expect(await service.openDraftFor(OWNER)).toBeNull();
    expect((await service.start(OWNER, 'create_purchase_invoice')).ok).toBe(true);
  });

  it('puts nothing internal in what it sends the host', () => {
    const draft = {
      reference: 'DRAFT-1001',
      documentType: 'create_sale_invoice',
      displayName: 'Sale Invoice',
      createdByPhone: OWNER,
      fields: { partyName: 'Ali Traders' },
      lineItems: [],
    } as unknown as DocumentDraft;

    const payload = toSubmissionPayload(draft);
    // The `create_` prefix is ours; the host knows it as a sale invoice.
    expect(payload.documentType).toBe('sale_invoice');
    expect(JSON.stringify(payload)).not.toContain('create_');
  });
});

describe('dates as people write them', () => {
  it('accepts a restated label, because a person answering "Date?" repeats the word', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(coerceDate('date is today')).toBe(today);
    expect(coerceDate('Date: today')).toBe(today);
    expect(coerceDate('dated 2026-09-12')).toBe('2026-09-12');
  });

  it('reads a slash date day-first, the way it is written here', () => {
    // 9 December by American convention, and wrong by three months on an invoice.
    expect(coerceDate('12/09/2026')).toBe('2026-09-12');
    expect(coerceDate('01-02-2026')).toBe('2026-02-01');
  });

  it('refuses a day that does not exist instead of rolling it forward', () => {
    expect(coerceDate('31/02/2026')).toBeNull();
  });

  it('still refuses what is not a date at all', () => {
    expect(coerceDate('sometime next week')).toBeNull();
    expect(coerceDate('')).toBeNull();
  });
});

describe('types the host has not built yet', () => {
  it('names only what Tijarah actually accepts', () => {
    expect(
      submittableRequests()
        .map(r => r.requestType)
        .sort(),
    ).toEqual(['ITEM', 'PARTY', 'PURCHASE', 'SALE']);
  });

  it('marks the other eight pending rather than letting someone fill one in', () => {
    // The host answers these with a validation error; the specification still lists all twelve.
    expect(findRequestSpec('create_receive_voucher')?.pending).toBe(true);
    expect(findRequestSpec('create_sale_return')?.pending).toBe(true);
    expect(findRequestSpec('create_sale_invoice')?.pending).toBe(false);
    expect(findRequestSpec('create_item_account')?.pending).toBe(false);
  });
});

describe('a draft that can never be submitted', () => {
  const OWNER = '923001234567';
  let ds: DataSource;
  let service: DraftService;

  /** A draft of a type the host does not accept — the way one started before its answer was known. */
  const strand = async (): Promise<void> => {
    const open = await service.start(OWNER, 'create_sale_invoice');
    await ds
      .getRepository(DocumentDraft)
      .update({ id: open.draft?.id }, { documentType: 'create_receive_voucher', displayName: 'Receive Voucher' });
  };

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [DocumentDraft], synchronize: true });
    await ds.initialize();
    service = new DraftService(ds.getRepository(DocumentDraft), new MockApprovalSubmissionAdapter());
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('does not trap the person behind it', async () => {
    await strand();

    const result = await service.start(OWNER, 'create_sale_invoice');

    // Cleared instead of refusing every new document forever with "finish or cancel it first".
    expect(result.ok).toBe(true);
    expect(result.draft?.documentType).toBe('create_sale_invoice');
  });

  it('is refused on submission in words, not as an HTTP error', async () => {
    await strand();

    const result = await service.submit(OWNER);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/has not enabled it yet/i);
    expect(result.message).toMatch(/Sale Invoice/);
  });
});

describe('widening what the host accepts without a code change', () => {
  afterEach(() => {
    delete process.env.TIJARAH_REQUEST_TYPES;
  });

  it('is the four known types by default', () => {
    expect([...hostRequestTypes({})].sort()).toEqual(['ITEM', 'PARTY', 'PURCHASE', 'SALE']);
  });

  it('honours TIJARAH_REQUEST_TYPES the day Tijarah admits more', () => {
    const env = { TIJARAH_REQUEST_TYPES: 'SALE, PURCHASE, PARTY, ITEM, payment, receive' };
    expect([...hostRequestTypes(env)].sort()).toEqual(['ITEM', 'PARTY', 'PAYMENT', 'PURCHASE', 'RECEIVE', 'SALE']);
    expect(findRequestSpec('create_receive_voucher', env)?.pending).toBe(false);
  });

  it('ignores a name the specification has never heard of', () => {
    // A typo must not advertise a type the host would refuse.
    expect([...hostRequestTypes({ TIJARAH_REQUEST_TYPES: 'SALE,VOUCHER,RECIEVE' })]).toEqual(['SALE']);
  });

  it('lets a voucher be started once the setting says so', async () => {
    process.env.TIJARAH_REQUEST_TYPES = 'SALE,PURCHASE,PARTY,ITEM,PAYMENT,RECEIVE';
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [DocumentDraft],
      synchronize: true,
    });
    await ds.initialize();
    const service = new DraftService(ds.getRepository(DocumentDraft), new MockApprovalSubmissionAdapter());

    const result = await service.start('923001234567', 'create_receive_voucher');

    expect(result.ok).toBe(true);
    await ds.destroy();
  });
});
