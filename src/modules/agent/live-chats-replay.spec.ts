import { detectIntent, composeDetails, parseLineItems, priceAnswer } from './mock-reasoning.provider';
import {
  awaitedChoice,
  awaitedDocument,
  awaitedParty,
  awaitedPartyPeriod,
  documentNumberPrompt,
  isChitChat,
  advance,
  MENU_TRIGGER,
  onlyAPeriod,
  periodMenu,
  readDocumentNumber,
  rootMenu,
  shortlistLine,
  stepFor,
  voucherPick,
} from './client-menu';
import { parsePartyCode, parsePeriod } from './period-parse';
import { coerceDate } from '../whatsapp-jobs/drafts/draft.service';
import { businessToday, wallClock } from '../../common/utils/wall-clock';

/**
 * Every message the five registered numbers sent up to 8 October, replayed against the code.
 *
 * Each case below is a message a client actually typed and the wrong thing that came back —
 * a stranger's invoice, the whole book, a question asked forever, a date a day early. They are
 * the regression net for the rule-based path, which is what answers while no AI key is set.
 */
const NOW = new Date('2026-10-08T12:00:00Z');

describe('a period is never read as a document number', () => {
  it('"Last 30 days ki invoice" is the sales book for 30 days, not invoice number 30', () => {
    // Sent on 8 Oct and answered with SL-30 — a real invoice, confidently, to the wrong person.
    const intent = detectIntent('Last 30 days ki invoice');
    expect(intent.kind).toBe('report');
    expect(intent.kind === 'report' && intent.documentType).toBe('sales_book_report');
    expect(intent.kind === 'report' && intent.from).not.toBeNull();
  });

  it('"January sales invoice" is January\'s sales book', () => {
    const intent = detectIntent('January sales invoice');
    expect(intent.kind === 'report' && intent.documentType).toBe('sales_book_report');
    expect(intent.kind === 'report' && intent.from?.slice(5)).toBe('01-01');
  });

  it('still reads the number written beside the document, either side of it', () => {
    for (const [text, number] of [
      ['Sale invoice 179', '179'],
      ['January sales invoice 112', '112'],
      ['send me receive voucher 54 no', '54'],
      ['send me 54 no receive voucher', '54'],
      ['*sale invoice 179*', '179'],
    ]) {
      const intent = detectIntent(text);
      expect(intent.kind === 'document' && intent.documentNumber).toBe(number);
    }
  });
});

describe('a document named without a number asks for it', () => {
  it.each(['Sale invoice dede', 'Purchase invoice', 'sale invoic', 'send mei.invoicw'])('%s', text => {
    // These used to say "I cannot fetch one here" — written before documents could be fetched.
    expect(detectIntent(text).kind).toBe('need_document_number');
  });

  it('reads a bare number answering its own question', () => {
    const asked = documentNumberPrompt('Sale Invoice');
    expect(awaitedDocument(asked)).toBe('Sale Invoice');
    expect(readDocumentNumber('179')).toBe('179');
    expect(readDocumentNumber('no 179')).toBe('179');
    expect(readDocumentNumber('179 invoices please')).toBeNull();
  });

  it('turns "1" after "Which voucher?" into the payment voucher, not the main menu', () => {
    expect(voucherPick('Which voucher?\n\n1.  Payment voucher\n2.  Receive voucher', '1')).toBe('Payment Voucher');
    expect(voucherPick('Which voucher?\n\n1.  Payment voucher\n2.  Receive voucher', '2')).toBe('Receive Voucher');
    expect(voucherPick('Something else', '1')).toBeNull();
  });
});

describe('names, as clients write them', () => {
  it('"Furniture ledger of 1 year" names something, and a year', () => {
    const intent = detectIntent('Furniture ledger of 1 year');
    expect(intent.kind === 'report' && intent.partyName).toBe('Furniture');
    expect(intent.kind === 'report' && intent.from).not.toBeNull();
  });

  it('"Ahmed bolten ka de" is a ledger for that name', () => {
    const intent = detectIntent('Ahmed bolten ka de');
    expect(intent.kind === 'report' && intent.partyName).toBe('Ahmed bolten');
  });

  it('drops the word "product" from a product name', () => {
    expect(detectIntent('Sheglam product ka ledger bhejo').kind === 'report').toBe(true);
    const stock = detectIntent('Sheglam product kitni qty hai ?');
    expect(stock.kind === 'report' && stock.documentType).toBe('item_ledger');
    expect(stock.kind === 'report' && stock.itemName).toBe('Sheglam');
  });

  it('"item ka ledger" is the item ledger, not a product called "...item"', () => {
    const intent = detectIntent('Pagal ha kia item ka ledger de');
    expect(intent.kind === 'report' && intent.documentType).toBe('item_ledger');
    expect(intent.kind === 'report' && intent.itemName).toBeNull();
  });

  it('does not read "customer" in "customer ledger" as somebody called Customer', () => {
    const intent = detectIntent('customer ledger last 30 days');
    expect(intent.kind === 'report' && intent.partyName).toBeNull();
    const named = detectIntent('Danyal ka customer ledger');
    expect(named.kind === 'report' && named.partyName).toBe('Danyal');
    // Inside a name the word belongs to it.
    const cash = detectIntent('CASH CUSTOMER ka ledger');
    expect(cash.kind === 'report' && cash.partyName).toBe('CASH CUSTOMER');
  });

  it('reads an account code written straight after "ledger"', () => {
    expect(parsePartyCode('Sent me general ledger 0101001')).toBe('0101001');
    const intent = detectIntent('Sent me general ledger 0101001');
    expect(intent.kind === 'report' && intent.partyName).toBeNull();
  });

  it('only looks for a name on reports about one account', () => {
    const intent = detectIntent('Sent me general ledger for cash bank book');
    expect(intent.kind === 'report' && intent.documentType).toBe('cash_bank_book');
    expect(intent.kind === 'report' && intent.partyName).toBeNull();
  });
});

describe('every ledger asks who or what first', () => {
  it('reads the answer to "Which item?" and "Which account?" back to its ledger', () => {
    expect(awaitedParty('Which item?\n\nJust send me the name — for example *Blue Shirt*.')).toBe('item_ledger');
    expect(awaitedParty('Which account?\n\nSend me a customer, supplier or item name.')).toBe('general_ledger');
    expect(awaitedParty('Which customer?\n\nJust send me the name.')).toBe('customer_ledger');
  });

  it('keeps the dates the question was asked with', () => {
    expect(awaitedPartyPeriod('Which item?\n\nOr send *all*.\n\nDates: 01-09-2026 to 30-09-2026')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('"Ledger" names nobody, so the account is asked for', () => {
    const intent = detectIntent('Ledger');
    expect(intent.kind === 'report' && intent.documentType).toBe('general_ledger');
    expect(intent.kind === 'report' && intent.partyName).toBeNull();
  });
});

describe('the dates are asked for too', () => {
  const REPORTS = [
    { documentType: 'customer_ledger', displayName: 'Customer Ledger', datedByDefault: true },
    { documentType: 'item_ledger', displayName: 'Item Ledger', datedByDefault: true },
  ];

  it('carries the customer through the dates question to the report', () => {
    const asked = periodMenu('Customer Ledger', { kind: 'party', name: 'DANIYAL', code: '0107059' });
    const step = stepFor(asked);
    expect(step).toEqual({
      kind: 'period',
      documentType: 'Customer Ledger',
      subject: { kind: 'party', name: 'DANIYAL', code: '0107059' },
    });
    expect(advance(step, '4', REPORTS, NOW)).toEqual({
      kind: 'report',
      documentType: 'customer_ledger',
      from: '2026-09-08',
      to: '2026-10-08',
      subject: { kind: 'party', name: 'DANIYAL', code: '0107059' },
    });
  });

  it('carries an item, and "everyone", the same way — through custom dates as well', () => {
    const item = stepFor(periodMenu('Item Ledger', { kind: 'item', name: 'PENASONIC ITEM #1', code: '001001001' }));
    const custom = advance(item, '8', REPORTS, NOW);
    const dates = stepFor(custom.kind === 'show' ? custom.text : '');
    expect(advance(dates, '01-07-2026 to 30-09-2026', REPORTS, NOW)).toMatchObject({
      documentType: 'item_ledger',
      from: '2026-07-01',
      subject: { kind: 'item', code: '001001001' },
    });
    expect(stepFor(periodMenu('Customer Ledger', { kind: 'all' }))).toMatchObject({ subject: { kind: 'all' } });
  });

  it('takes "all time" as an answer to the dates question', () => {
    expect(onlyAPeriod('all time')).toBe(true);
    expect(parsePeriod('all time', NOW)).toEqual({ from: '2026-01-01', to: '2026-10-08' });
    expect(parsePeriod('poora saal', NOW)).toEqual({ from: '2026-01-01', to: '2026-10-08' });
  });
});

describe('receivables ask which customer, like every ledger', () => {
  it.each(['send me list of receivables', 'Receivable report de', 'who owes me'])('%s', text => {
    // No name means the report tool asks "Which customer?" — *all* is offered there.
    const intent = detectIntent(text);
    expect(intent.kind === 'report' && intent.documentType).toBe('customer_ledger');
    expect(intent.kind === 'report' && intent.partyName).toBeNull();
  });
});

describe('shorthand and greetings', () => {
  it('reads "Trail bal bhej" as the trial balance', () => {
    expect(detectIntent('Trail bal bhej').kind === 'report').toBe(true);
  });

  it('reads "item list" as the stock summary', () => {
    const intent = detectIntent('item list');
    expect(intent.kind === 'report' && intent.documentType).toBe('stock_summary');
  });

  it.each(['Hey', 'Bhai menu', 'hii', 'Assalamualaikum', 'send'])('"%s" opens the menu', text => {
    expect(MENU_TRIGGER.test(text)).toBe(true);
  });

  it('still lets a real request through', () => {
    expect(MENU_TRIGGER.test('Send me trail balance')).toBe(false);
    expect(MENU_TRIGGER.test('bhai trial balance bhejo')).toBe(false);
  });

  it('knows conversation from a name', () => {
    for (const text of ['haan bhai', 'Why', 'Arey bhai', 'ok', 'Chalna']) expect(isChitChat(text)).toBe(true);
    for (const text of ['Danyal', 'Usman', 'Zahid Traders', 'Income statement bhejo'])
      expect(isChitChat(text)).toBe(false);
  });
});

describe('creating an invoice', () => {
  it('uses everything in a one-message invoice', () => {
    expect(composeDetails('create a sale invoice for Ahmed Traders, 10 shirts at 1500')).toEqual({
      partyName: 'Ahmed Traders',
      partyCode: null,
      items: [{ name: 'shirts', qty: '10', rate: '1500' }],
    });
    expect(composeDetails('I want to create sale bill for this customer 0107010')?.partyCode).toBe('0107010');
    expect(composeDetails('create sale invoice')).toBeNull();
  });

  it('starts an invoice for "create invoice", "create purchase", "make bill"', () => {
    const kind = (text: string) => {
      const intent = detectIntent(text);
      return intent.kind === 'create_start' ? intent.documentType : intent.kind;
    };
    expect(kind('create invoice')).toBe('create_sale_invoice');
    expect(kind('create purchase')).toBe('create_purchase_invoice');
    expect(kind('MAKE BILL OF 15K')).toBe('create_sale_invoice');
    expect(kind('I want to create sale bill for this customer 0107010')).toBe('create_sale_invoice');
    // A report named after the same verb is still the report.
    expect(kind('make purchase book report')).toBe('report');
  });

  it('adds every line of a list sent as one message, and names the unpriced ones', () => {
    expect(parseLineItems('1. 250 cotton fabric at 600\n2. led bulb 300pcs\n3. iphone 5box')).toEqual({
      complete: [{ quantity: '250', description: 'cotton fabric', rate: '600' }],
      unpriced: ['300 led bulb', '5 iphone'],
    });
    expect(parseLineItems('10 led bulb at 20000 30 normal bulb at 500').complete).toEqual([
      { quantity: '10', description: 'led bulb', rate: '20000' },
      { quantity: '30', description: 'normal bulb', rate: '500' },
    ]);
  });

  it('takes "AT 60 RS" as the price the bot just asked for', () => {
    const asked = 'How much per piece for *cotton*?\n\nSend it like this: _250 cotton at 600_';
    expect(priceAnswer(asked, 'AT 60 RS')).toEqual({ description: 'cotton', quantity: '250', rate: '60' });
    expect(priceAnswer(asked, '60')).toEqual({ description: 'cotton', quantity: '250', rate: '60' });
    expect(priceAnswer(asked, 'cotton is expensive')).toBeNull();
    expect(priceAnswer('Something else', '60')).toBeNull();
  });
});

describe('dates on an invoice', () => {
  it('refuses a code typed at the date question', () => {
    // "C-1005" became the year 1005 and went to the approval screen as 1004-12-31.
    expect(coerceDate('C-1005', NOW)).toBeNull();
    expect(coerceDate('Report', NOW)).toBeNull();
    expect(coerceDate('Easy paisa', NOW)).toBeNull();
  });

  it("reads the forms clients typed, in no time zone but the business's", () => {
    expect(coerceDate('01-Oct-2026', NOW)).toBe('2026-10-01');
    expect(coerceDate('2026 09 07', NOW)).toBe('2026-09-07');
    expect(coerceDate('1 oct', NOW)).toBe('2026-10-01');
    expect(coerceDate('October 1, 2026', NOW)).toBe('2026-10-01');
  });

  it("means Karachi's today, even at 1 a.m. when UTC is still on yesterday", () => {
    // 20:30 UTC on 8 Oct is 01:30 on 9 Oct in Karachi.
    const lateNight = new Date('2026-10-08T20:30:00Z');
    expect(coerceDate('today', lateNight)).toBe('2026-10-09');
    expect(businessToday(lateNight)).toBe('2026-10-09');
    expect(wallClock(lateNight).getUTCHours()).toBe(1);
  });
});

describe('periods', () => {
  it.each([
    ['Furniture ledger of 1 year', '2025-10-08'],
    ['last 2 months ka ledger', '2026-08-08'],
    ['2 hafte', '2026-09-24'],
    ['ek saal ka ledger', '2025-10-08'],
  ])('%s', (text, from) => {
    expect(parsePeriod(text, NOW)?.from).toBe(from);
  });

  it('does not read the "do" of "ledger do" as two', () => {
    expect(parsePeriod('ledger do', NOW)).toBeNull();
  });

  it('knows a reply that is only a period from one that is a new request', () => {
    expect(onlyAPeriod('last 20 days')).toBe(true);
    expect(onlyAPeriod('1 Jan se 31 March tak')).toBe(true);
    expect(onlyAPeriod('Furniture ledger of 1 year')).toBe(false);
  });
});

describe('the "which one?" shortlist', () => {
  const list =
    'I found a few accounts called "Usman". Which one?\n\n' +
    [
      shortlistLine(1, 'USMAN', '0104008', '0321 1111111'),
      shortlistLine(2, 'USMAN', '0107108'),
      shortlistLine(3, 'USMAN', '0107126'),
    ].join('\n') +
    '\n\nJust send the number.\n\nDates: 01-09-2026 to 30-09-2026';

  it('carries each account code, so three identical names are three different picks', () => {
    // Picking by NAME searched "USMAN" again, found the same three, and asked for ever.
    expect(awaitedChoice(list)?.options.map(o => o.code)).toEqual(['0104008', '0107108', '0107126']);
    expect(awaitedChoice(list)?.options[0].name).toBe('USMAN');
  });

  it('keeps the dates the question was asked with', () => {
    expect(awaitedPartyPeriod(list)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('marks products in a "did you mean" list, so a pick reaches the item ledger', () => {
    const near =
      'I could not find "sheglam brush". Did you mean one of these?\n\n' +
      '1.  KHUZEMA TRADEVIVE (0106015)\n2.  Sheglam It-Curl Thermal Blowout Brush - 32mm — item (001006101)';
    const options = awaitedChoice(near)?.options ?? [];
    expect(options.map(o => o.item)).toEqual([false, true]);
    expect(options[1].name).toBe('Sheglam It-Curl Thermal Blowout Brush - 32mm');
  });

  it('still reads the wording sent before this change', () => {
    expect(awaitedChoice('I found a few people called "Ali". Which one?\n\n1.  ALI TRADERS')).not.toBeNull();
  });
});

describe('menus carry no visible marker', () => {
  it('ends every menu without a stray digit', () => {
    // Every menu used to close on "…like trial balance.1" — a zero-width marker plus a real 1.
    const text = rootMenu();
    expect(text.replace(/[\u200b\u200c\u2060]/g, '')).toMatch(/_trial balance_\.$/);
    expect(stepFor(text)).toEqual({ kind: 'root' });
  });

  it('still recognises a menu sent with the old marker', () => {
    expect(stepFor('What do you need?\u200b\u200b1')).toEqual({ kind: 'root' });
  });
});
