import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  ReasoningToolCall,
} from './agent-reasoning.interface';

/**
 * A deterministic stand-in for a reasoning model.
 *
 * This exists because the brief requires the whole flow to be demonstrable and testable
 * without a scanned WhatsApp account or a paid API key, and because the dangerous way to do
 * that is a stub that returns lorem ipsum while the UI says the agent replied.
 *
 * So it is not a stub. It genuinely reads the request, genuinely picks a tool, and
 * genuinely composes an answer from the tool's result — using an intent table instead of a
 * language model. Every turn it produces is stamped with the provider id `mock`, which the
 * runtime records on the turn row and the dashboard shows, so its output can never be
 * mistaken for a model's.
 *
 * It is also the safety floor. Its intent table cannot invent a recipient or a figure: it
 * can only ask for a tool the registry already exposes, with arguments taken from the
 * message. A rule engine that cannot hallucinate is a useful thing to fall back to when a
 * provider is unreachable.
 */
@Injectable()
export class MockReasoningProvider implements ReasoningProvider {
  readonly id = 'mock';
  readonly model = 'rules-v1';

  /** Always available. That is the point of it. */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Async by interface, synchronous in fact.
   *
   * A real provider awaits a network call here. This one decides from a table, so the work
   * is done in `decide` and wrapped — which keeps the shape identical to a model-backed
   * provider without pretending to await something.
   */
  reason(request: ReasoningRequest): Promise<ReasoningResponse> {
    return Promise.resolve(this.decide(request));
  }

  private decide(request: ReasoningRequest): ReasoningResponse {
    const lastUser = [...request.messages].reverse().find(m => m.role === 'user');
    const lastTool = [...request.messages].reverse().find(m => m.role === 'tool');

    // A tool has already run this turn: summarise it and stop. One hop is enough for every
    // intent this table understands, and looping would burn steps without adding anything.
    const role = request.context?.senderRole ?? 'admin';
    const isCustomer = role === 'customer' || role === 'unknown';
    const composing = request.context?.hasOpenDraft === true;

    if (lastTool && lastTool.role === 'tool') {
      /*
       * A customer never sees the operator summariser.
       *
       * That renderer names tools, ids and internal fields, which is the right thing for the
       * person running the system and the wrong thing to send a member of the public. The
       * customer tools each carry the sentence they want said, so rendering their result is
       * a matter of reading it rather than describing it.
       */
      return this.finish(
        isCustomer
          ? summariseForCustomer(lastTool.content, lastTool.isError === true)
          : summariseToolResult(lastTool.content, lastTool.isError === true),
      );
    }

    const text = lastUser && lastUser.role === 'user' ? stripFence(lastUser.content) : '';
    const available = new Set(request.tools.map(t => t.name));

    /*
     * A customer gets a different vocabulary entirely.
     *
     * Falling through to the operator table sent a member of the public the internal command
     * list — "send <name> <message>", "APPROVE APR-1001" — which is both confusing and an
     * invitation to try them. The rule engine is the documented fallback when a model is
     * unreachable, so it has to be safe on its own, not merely safe when the model is up.
     */
    if (isCustomer) {
      /*
       * A customer's request is serviced, not merely acknowledged.
       *
       * This used to answer entirely from a phrase table — "I have asked our team to send
       * your statement" when nothing had been asked of anyone. The replies were reassuring
       * and false, which is the exact failure mode the brief rules out. Each recognised
       * intent now maps to a customer tool that does the thing, and the reply is written
       * from what the tool actually returned.
       */
      const wanted = detectCustomerIntent(text);
      if (wanted.tool) return this.callIfAvailable(available, wanted.tool, wanted.input, wanted.narration);
      return this.finish(wanted.reply);
    }

    const intent = detectIntent(text);

    /*
     * While a document is being composed, anything that is not a recognised command is the
     * answer to the question just asked. Without this the rule-based provider cannot tell
     * "Ali Traders" from an unrecognised instruction and replies with the help text, which
     * makes the conversation impossible to complete.
     *
     * Recognised commands still win, so "cancel" and "submit" work mid-draft.
     */
    if (composing && intent.kind === 'help') {
      const line = parseLineItem(text);
      if (line) {
        return this.callIfAvailable(available, 'AddDraftLineItem', line, 'Adding that line.');
      }
      /*
       * A line that names a quantity and an item but no price.
       *
       * "4pcs led bulb" and "led bulb 300pcs" were both answered with "Nothing is waiting on
       * an answer", which tells a person nothing about what was wrong. The missing piece is
       * the rate, so that is what gets asked for.
       */
      const partial = parsePartialLine(text);
      if (partial) {
        return this.finish(
          `How much per ${partial.unit ?? 'piece'} for *${partial.description}*?\n\n` +
            `Send it like this: _${partial.quantity} ${partial.description} at 600_`,
        );
      }
      return this.callIfAvailable(available, 'AnswerDraftPrompt', { value: text }, 'Noted.');
    }

    switch (intent.kind) {
      case 'status':
        return this.callIfAvailable(available, 'SessionFindOne', {}, 'Checking the connection.');

      case 'find_contact':
        return this.callIfAvailable(
          available,
          'AgentSearchContacts',
          { query: intent.query },
          `Looking for contacts matching "${intent.query}".`,
        );

      case 'recent_chats':
        return this.callIfAvailable(available, 'SessionGetChats', { limit: 10 }, 'Fetching recent chats.');

      case 'send':
        /*
         * A send is proposed, never performed here.
         *
         * The tool call goes back to the runtime, which puts it through the permission
         * layer. In every mode except `automatic` with an explicit policy, that produces an
         * approval request rather than a message — which is the behaviour the demo shows.
         */
        return this.callIfAvailable(
          available,
          'MessageSendText',
          { chatId: intent.recipient ?? '', text: intent.body ?? '' },
          'Preparing that message.',
        );

      case 'report':
        /*
         * Phase Two. The tool is senderScoped, so the report goes back to whoever asked — the
         * reasoner never chooses a recipient and cannot be talked into naming one.
         */
        return this.callIfAvailable(
          available,
          'RequestAccountingReport',
          {
            documentType: intent.documentType,
            ...(intent.from ? { from: intent.from, to: intent.to } : {}),
            ...(intent.partyCode ? { partyCode: intent.partyCode } : {}),
            // Named, not coded: the report tool resolves it or refuses. Never widened to all.
            ...(intent.partyName ? { partyName: intent.partyName } : {}),
            ...(intent.itemName ? { itemName: intent.itemName } : {}),
          },
          /*
           * No narration: the PDF is the reply.
           *
           * It also could not be truthful here — a named party moves the request to the
           * ledger that answers for them, so "Fetching the general ledger" was announced for
           * what turned out to be the vendor ledger. One message per document, and it is
           * the document.
           */
          '',
        );

      case 'create_start':
        return this.callIfAvailable(
          available,
          'StartDocumentDraft',
          { documentType: intent.documentType },
          `Starting a ${intent.documentType.replace(/^create_/, '').replace(/_/g, ' ')}.`,
        );

      case 'create_review':
        return this.callIfAvailable(available, 'ReviewDraft', {}, 'Reading back what we have so far.');

      case 'create_submit':
        return this.callIfAvailable(available, 'SubmitDraftForApproval', {}, 'Sending it for approval.');

      case 'create_cancel':
        return this.callIfAvailable(available, 'CancelDraft', {}, 'Cancelling that.');

      case 'list_reports':
        return this.callIfAvailable(available, 'ListAccountingReports', {}, 'Checking which reports I can send.');

      case 'overdue':
        return this.callIfAvailable(
          available,
          'LedgerListOverdue',
          { bucket: 'overdue', limit: 20 },
          'Checking who is overdue.',
        );

      case 'balance':
        return this.callIfAvailable(
          available,
          'LedgerGetCustomer',
          { partyId: intent.partyId },
          `Looking up ${intent.partyId}.`,
        );

      case 'record_payment':
        return this.callIfAvailable(
          available,
          'LedgerRecordPayment',
          {
            partyId: intent.partyId,
            invoiceId: intent.invoiceId,
            amount: intent.amount,
            paidOn: new Date().toISOString().slice(0, 10),
            reference: intent.reference,
          },
          'Preparing that payment for approval.',
        );

      case 'which_voucher':
        return this.finish(
          'Which voucher?\n\n' +
            '1.  Payment voucher — money you paid out\n' +
            '2.  Receive voucher — money you took in\n\n' +
            'Send the number, or say _create payment voucher_.',
        );

      case 'document':
        return this.callIfAvailable(
          available,
          'RequestAccountingReport',
          { documentType: intent.documentType, documentNumber: intent.documentNumber },
          '',
        );

      case 'need_document_number':
        /*
         * An invoice is NOT fetchable from a conversation, and saying so is the honest reply.
         *
         * Asking "which number?" offered something that cannot be delivered: a document by
         * number is excluded from chat on purpose, because invoice 179 belongs to one
         * customer and any client quoting the number would receive it. The bot used to ask
         * for the number and then answer the number with its help list, which reads as
         * broken. It now says what it can do instead.
         */
        return this.finish(
          `A ${intent.displayName === 'invoice' ? 'particular invoice' : intent.displayName.toLowerCase()} is sent to you from Tijarah Books, so I cannot fetch one here.\n\n` +
            'I can send you a *report* instead — for example the sales book, or your ledger for a period. ' +
            'Reply *menu* to see the list.',
        );

      case 'pending':
        return this.callIfAvailable(available, 'AgentListPendingApprovals', {}, 'Checking what is waiting.');

      case 'help':
      default:
        // A Tijarah client is not shown the operator's command list — none of it is theirs.
        if (role === 'client') {
          return this.finish(
            [
              'Sorry, I did not understand that. Here is what I can do:',
              '',
              '1.  Who owes me money',
              '2.  Send me a report',
              '3.  Make a new invoice or voucher',
              '',
              'Just send 1, 2 or 3.',
              '',
              'Or type it in your own words, like:',
              '• _Danyal ka ledger_',
              '• _trial balance_',
              '• _last 30 days ka ledger_',
            ].join('\n'),
          );
        }
        return this.finish(
          [
            'I can help with:',
            '• "status" — whether WhatsApp is connected',
            '• "find <name>" — look up a contact',
            '• "recent chats" — what has come in',
            '• "send <name> <message>" — prepare a message for approval',
            '• "pending" — actions waiting on approval',
            '',
            'Replies of the form APPROVE APR-1001, EDIT APR-1001 <new text> or CANCEL APR-1001 decide a prepared action.',
          ].join('\n'),
        );
    }
  }

  /**
   * Asks for a tool, or explains why it cannot.
   *
   * The runtime filters the tool list by the sender's role before calling, so a tool being
   * absent here means this sender is not permitted it. Saying so plainly beats asking for
   * it and being denied, which would read to the sender as the agent malfunctioning.
   */
  private callIfAvailable(
    available: Set<string>,
    name: string,
    input: Record<string, unknown>,
    narration: string,
  ): ReasoningResponse {
    if (!available.has(name)) {
      return this.finish('That is not something this number is allowed to ask for.');
    }
    const call: ReasoningToolCall = { id: `mock_${randomUUID().slice(0, 8)}`, name, input };
    return { text: narration, toolCalls: [call], finished: false, inputTokens: 0, outputTokens: 0, model: this.model };
  }

  private finish(text: string): ReasoningResponse {
    // Zero tokens, honestly. A fabricated count would put imaginary spend on a real chart.
    return { text, toolCalls: [], finished: true, inputTokens: 0, outputTokens: 0, model: this.model };
  }
}

/* ------------------------------------------------------------------ intents */

type Intent =
  | { kind: 'status' }
  | { kind: 'overdue' }
  | { kind: 'balance'; partyId: string }
  | { kind: 'record_payment'; partyId: string; invoiceId: string; amount: string; reference: string }
  | { kind: 'recent_chats' }
  | { kind: 'pending' }
  | { kind: 'find_contact'; query: string }
  | { kind: 'send'; recipient: string | null; body: string | null }
  | {
      kind: 'report';
      documentType: string;
      from: string | null;
      to: string | null;
      partyCode: string | null;
      /** A party named rather than coded. Resolved to a code downstream, or refused. */
      partyName: string | null;
      /** For the item ledger: the product named, resolved against the stock list or refused. */
      itemName: string | null;
    }
  | { kind: 'list_reports' }
  | { kind: 'create_start'; documentType: string }
  | { kind: 'create_review' }
  | { kind: 'create_submit' }
  | { kind: 'create_cancel' }
  /** A document named without its number: ask for the number rather than offering the menu. */
  | { kind: 'need_document_number'; displayName: string }
  /** One document, by its number, from the asking client's own company. */
  | { kind: 'document'; documentType: string; displayName: string; documentNumber: string }
  /** "voucher", with no kind said: payment or receive? */
  | { kind: 'which_voucher' }
  | { kind: 'help' };

/**
 * Phase Three vocabulary: what a person says when they want to create something.
 *
 * Matched before the report words, because "create a sale invoice" contains "sale" and
 * "invoice" and would otherwise be answered with a sales report — a near-miss that sends a
 * document instead of starting one.
 */
const CREATE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdigital\s+invoice\b/, 'create_digital_invoice'],
  [/\bsale\s+return\b/, 'create_sale_return'],
  [/\bpurchase\s+return\b/, 'create_purchase_return'],
  [/\bsales?\s+invoice\b/, 'create_sale_invoice'],
  [/\bpurchase\s+invoice\b/, 'create_purchase_invoice'],
  [/\bpayment\s+voucher\b/, 'create_payment_voucher'],
  [/\breceive\s+voucher\b|\breceipt\s+voucher\b/, 'create_receive_voucher'],
  [/\bcustomer\s+account\b|\bnew\s+customer\b/, 'create_customer_account'],
  [/\bvendor\s+account\b|\bsupplier\s+account\b|\bnew\s+(vendor|supplier)\b/, 'create_vendor_account'],
  [/\bexpense\s+account\b/, 'create_expense_account'],
  [/\bchart\s+of\s+account\b/, 'create_chart_of_account'],
  [/\bitem\s+account\b|\bnew\s+item\b/, 'create_item_account'],
];

/**
 * The report a person names in conversation, mapped to a registry document type.
 *
 * Order matters: the more specific name must win. "customer ledger" and "item ledger" both
 * contain "ledger", and a bare `/ledger/` rule placed first would answer every one of them
 * with the general ledger — the sort of near-miss that is worse than not understanding at all,
 * because the person receives a real document and assumes it is the one they asked for.
 */
import { parsePartyCode, parsePeriod } from './period-parse';
import { fuzzyReport, REPORT_WORD_SETS } from './fuzzy-report';

/**
 * A party named in a ledger request, e.g. "Anas Boltan ka ledger bhejo" → "Anas Boltan".
 *
 * This exists because of a real delivery: that message matched the bare `ledger` rule, carried
 * no party, and the client was sent the WHOLE general ledger — a real PDF, silently the wrong
 * one, with nothing in the reply to say so. Sending every account to someone who asked for one
 * is a disclosure, so a name found here is resolved to a code downstream or refused.
 *
 * Both word orders, because clients write in English and Roman Urdu in the same conversation:
 * "ledger of Anas" and "Anas ka ledger". Words that are part of the request rather than a name
 * are excluded, so "send me the ledger" is not read as a customer called "send me the".
 */
const LEDGER_NOISE =
  /^(send|me|my|the|a|an|please|plz|bhej|bhejo|do|de|dedo|chahiye|mujhe|ka|ki|ke|k|is|this|that|for|of|full|all|total|complete|new|old|last|latest|report|statement|account|accounts|pls|kindly|need|want|get|give|show|aaj|tak|ab|today|till|date|upto|up|to|from|se|days?|day|month|months|year|years|saal|mahina|mahine|current|previous|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

function partyNameIn(body: string): string | null {
  const patterns = [
    // "ledger of Anas Boltan" / "ledger for Anas"
    /\b(?:ledger|statement|khata)\s+(?:of|for|ka|ki|ke)\s+([A-Za-z][A-Za-z .'&-]{1,60})/i,
    // "Anas Boltan ka ledger" — Roman Urdu word order
    /([A-Za-z][A-Za-z .'&-]{1,60}?)\s+(?:ka|ki|ke)\s+(?:ledger|statement|khata)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) continue;
    const words = match[1]
      .trim()
      .split(/\s+/)
      .filter(word => !LEDGER_NOISE.test(word));
    if (words.length) return words.join(' ');
  }
  return null;
}

/** Documents a person asks for by number, for the "which number?" reply when they omit it. */
const DOCUMENT_BY_NUMBER: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\bdigital\s+invoice\b/, 'Digital Invoice', 'digital_invoice'],
  [/\bsales?\s+return\b/, 'Sale Return', 'sale_return'],
  [/\bpurchase\s+return\b/, 'Purchase Return', 'purchase_return'],
  [/\bsales?\s+invoice\b|\bsale\s+bill\b/, 'Sale Invoice', 'sale_invoice'],
  [/\bpurchase\s+invoice\b|\bpurchase\s+bill\b/, 'Purchase Invoice', 'purchase_invoice'],
  [/\bpayment\s+voucher\b/, 'Payment Voucher', 'payment_voucher'],
  [/\breceive\s+voucher\b|\breceipt\s+voucher\b/, 'Receive Voucher', 'receive_voucher'],
  // Bare "invoice"/"bill": a sale invoice is what a business means by it nine times in ten.
  [/\binvoice\b|\bbill\b/, 'Sale Invoice', 'sale_invoice'],
];

const REPORT_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcustomer\s+ledger\b/, 'customer_ledger'],
  [/\bvendor\s+ledger\b|\bsupplier\s+ledger\b/, 'vendor_ledger'],
  [/\bexpense\s+ledger\b/, 'expense_ledger'],
  [/\bitem\s+ledger\b/, 'item_ledger'],
  [/\btrial\s+balance\b/, 'trial_balance'],
  [/\bstock\s+summary\b|\bstock\s+report\b/, 'stock_summary'],
  [/\bincome\s+statement\b|\bprofit\s*(and|&|n)?\s*loss\b|\bp\s*&\s*l\b/, 'income_statement'],
  [/\bbalance\s+sheet\b/, 'balance_sheet'],
  [/\bcash\s*(and|&|n)?\s*bank\b/, 'cash_bank_book'],
  // The four reports behind the host's SP code. Returns are matched before their book, because
  // "sale return report" contains "sale" and would otherwise answer with the sales book.
  // The RETURNS need the word "report", because "sale return 3" is return document 3 and
  // "sale return report" is the period summary — two different documents, one phrase apart.
  [/\bsales?\s+returns?\s+(report|book|summary)\b/, 'sale_return_report'],
  [/\bpurchase\s+returns?\s+(report|book|summary)\b/, 'purchase_return_report'],
  [/\bsales?\s+book\b|\bsales?\s+report\b/, 'sales_book_report'],
  [/\bpurchase\s+book\b|\bpurchase\s+report\b/, 'purchase_book_report'],
  [/\bgeneral\s+ledger\b|\bgl\b/, 'general_ledger'],
];

/**
 * The bare word "ledger", which means the general ledger only once nothing else has claimed it.
 *
 * Kept out of the table above so the fuzzy pass runs first: with it in the table, "custmer
 * ledger" matched `\bledger\b` and returned the GENERAL ledger — a real PDF of every
 * account, to someone who asked for one customer. A near-miss on a specific ledger has to
 * win over the catch-all, so the catch-all is tried last of all.
 */
const BARE_LEDGER = /\bledger\b/;

/**
 * The product named in an item-ledger request: "Vaseline gluta glow ka item ledger bhejo".
 *
 * Same two word orders as a party name, but the words "item" and "ledger" are stripped from
 * the result — without that, "Blue Shirt ka item ledger" yields "Blue Shirt ka item" and
 * matches nothing in the stock list.
 */
function itemNameIn(body: string): string | null {
  const patterns = [
    // "item ledger of X" / "item ledger for X". The leading phrase must include "ledger", so
    // "item ledger for Item 2" keeps the product's own word "Item" rather than eating it.
    /\bitem\s+ledger\s+(?:of|for|ka|ki|ke)\s+([A-Za-z0-9][A-Za-z0-9 .'&-]{1,60})/i,
    /\bitem\s+(?:of|for)\s+([A-Za-z0-9][A-Za-z0-9 .'&-]{1,60})/i,
    /([A-Za-z0-9][A-Za-z0-9 .'&-]{1,60}?)\s+(?:ka|ki|ke)\s+(?:item\s+ledger|ledger)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) continue;
    const words = match[1]
      .trim()
      .split(/\s+/)
      /*
       * Request words are dropped, but only at the FRONT.
       *
       * A product name legitimately ends in a bare letter or digit — "Product A", "Item 2" —
       * and filtering every word turned "Product A" into "Product", which matches nothing in
       * the stock list. Only the leading filler is noise; once a real word has been seen,
       * everything after it is part of the name.
       */
      .filter((word, i, all) => {
        const noise = LEDGER_NOISE.test(word) || /^ledger$/i.test(word);
        if (!noise) return true;
        // Noise is dropped only while nothing real has appeared yet.
        return all.slice(0, i).some(w => !LEDGER_NOISE.test(w) && !/^(item|ledger)$/i.test(w));
      });
    if (words.length) return words.join(' ');
  }
  return null;
}

export function detectIntent(text: string): Intent {
  const body = text.trim();
  const lower = body.toLowerCase();

  /*
   * Accounting intents are matched before the WhatsApp ones.
   *
   * "who is overdue" contains no WhatsApp vocabulary, but "show me the balance for CUST-ALI"
   * would otherwise be read as a contact search — and answering an accounting question with
   * a contact list is the kind of near-miss that makes an assistant feel unreliable.
   */
  /*
   * "record payment 150000 for INV-1001 ref TRX-88213"
   *
   * The reference is part of the pattern, not optional: the tool schema requires one, and a
   * payment posted with nothing to check it against is an entry nobody can verify later.
   */
  const payment = body.match(
    /\brecord\s+payment\s+([\d.]+)\s+for\s+([A-Za-z0-9-]+)\s+invoice\s+([A-Za-z0-9-]+)\s+ref(?:erence)?\s+([A-Za-z0-9-]{2,40})/i,
  );
  if (payment) {
    return {
      kind: 'record_payment',
      partyId: payment[2].toUpperCase(),
      invoiceId: payment[3].toUpperCase(),
      amount: payment[1],
      reference: payment[4],
    };
  }

  /*
   * Reports are matched before the receivables words, because "send me the customer ledger"
   * contains "customer" and would otherwise be read as a question about who owes money.
   * Specific ledger names are matched before the generic one, so "customer ledger" does not
   * fall through to the general ledger.
   */
  /* --- Phase Three: creating something, matched before the report words --- */
  if (/\b(cancel|discard|abandon)\b.*\b(draft|document|invoice|voucher)\b|^\s*cancel\s*$/.test(lower)) {
    return { kind: 'create_cancel' };
  }
  if (/\b(review|show|check)\b.*\b(draft|document|so far)\b|^\s*review\s*$/.test(lower)) {
    return { kind: 'create_review' };
  }
  if (/\b(submit|send for approval|approve it|finalis|finaliz)\b/.test(lower)) {
    return { kind: 'create_submit' };
  }
  if (/\b(create|make|new|raise|add)\b/.test(lower)) {
    for (const [pattern, documentType] of CREATE_WORDS) {
      if (pattern.test(lower)) return { kind: 'create_start', documentType };
    }
  }

  if (/\b(which|what|list)\b.*\breports?\b/.test(lower)) return { kind: 'list_reports' };
  for (const [pattern, documentType] of REPORT_WORDS) {
    if (pattern.test(lower)) {
      /*
       * The period and the party, both of which used to be dropped unless written exactly as
       * `2026-07-01` and `C-1005`. Clients write "January ledger de" and "for this 0107170",
       * and every one of those silently returned the whole book instead.
       */
      const period = parsePeriod(body);
      const partyCode = parsePartyCode(body);
      return {
        kind: 'report',
        documentType,
        from: period?.from ?? null,
        to: period?.to ?? null,
        partyCode,
        partyName: documentType === 'item_ledger' ? null : partyCode ? null : partyNameIn(body),
        // For the item ledger the name in front of "ka item ledger" is a PRODUCT, so it goes
        // to the stock list rather than being looked up among the customers.
        itemName: documentType === 'item_ledger' ? itemNameIn(body) : null,
      };
    }
  }

  /*
   * A report name typed slightly wrong.
   *
   * After the exact table, so a correct spelling never goes near the fuzzy path, and before
   * everything else, so "trail balance" is answered rather than falling to the help list.
   */
  const near = fuzzyReport(lower, REPORT_WORD_SETS);
  if (near) {
    const period = parsePeriod(body);
    const partyCode = parsePartyCode(body);
    return {
      kind: 'report',
      documentType: near,
      from: period?.from ?? null,
      to: period?.to ?? null,
      partyCode,
      partyName: near === 'item_ledger' ? null : partyCode ? null : partyNameIn(body),
      itemName: near === 'item_ledger' ? itemNameIn(body) : null,
    };
  }

  if (BARE_LEDGER.test(lower)) {
    const period = parsePeriod(body);
    const partyCode = parsePartyCode(body);
    return {
      kind: 'report',
      documentType: 'general_ledger',
      from: period?.from ?? null,
      to: period?.to ?? null,
      partyCode,
      partyName: partyCode ? null : partyNameIn(body),
      itemName: null,
    };
  }

  /*
   * "Who owes me" is the customer ledger, for a Tijarah client.
   *
   * It used to fall to the receivables agent's own overdue tool, which a client is not allowed
   * to call — so a plain question got "That is not something this number is allowed to ask
   * for", which reads as an accusation rather than an answer. Receivables ARE the customer
   * ledger here, so the question is answered instead of refused. The overdue tool still
   * answers the operator roles it was built for, below.
   */
  if (/\b(receivables?|who\s+owes|owes?\s+me|lena\s+hai|outstanding)\b/i.test(lower)) {
    const period = parsePeriod(body);
    return {
      kind: 'report',
      documentType: 'customer_ledger',
      from: period?.from ?? null,
      to: period?.to ?? null,
      partyCode: parsePartyCode(body),
      partyName: null,
      itemName: null,
    };
  }

  if (/\b(overdue|owes?|owing|outstanding|receivable|who owes)\b/.test(lower)) return { kind: 'overdue' };

  const balance = body.match(/\b(?:balance|account|statement)\s+(?:for|of)\s+([A-Za-z0-9_-]{2,40})/i);
  if (balance) return { kind: 'balance', partyId: balance[1].trim() };

  if (/\b(status|connected|connection|online)\b/.test(lower)) return { kind: 'status' };
  if (/\b(recent|latest)\b.*\b(chat|conversation|message)/.test(lower)) return { kind: 'recent_chats' };
  if (/\b(pending|waiting|awaiting)\b.*\b(approval|action)/.test(lower) || /^pending$/.test(lower)) {
    return { kind: 'pending' };
  }

  const send = body.match(/^\s*(?:send|message|text)\s+(.+?)\s*[:,]\s*([\s\S]+)$/i);
  if (send) return { kind: 'send', recipient: send[1].trim(), body: send[2].trim() };

  const find = body.match(/^\s*(?:find|search|look ?up|who is)\s+(.{2,60})$/i);
  if (find) return { kind: 'find_contact', query: find[1].trim() };

  /*
   * A document named with no number — "Send me sales invoice", a real message twice over.
   *
   * It reached the help list, which answers a question the person did not ask and reads as the
   * bot not understanding. An invoice is identified by its number and there is no sensible
   * default (the latest is a guess, and the wrong guess is someone else's invoice), so the
   * only useful reply is to ask for it. Last, so anything with a number still routes normally.
   */
  /*
   * "voucher" on its own, with no kind and no number.
   *
   * Three real messages on 8 October — "voucher", "voucher create karo", "mujhe daniyal ka
   * voucher do" — all fell to the help list, because every rule wants to know WHICH voucher.
   * There are only two, so asking is one short question rather than a menu of everything.
   */
  if (/\bvoucher\b/.test(lower) && !/\b(payment|receive|receipt)\b/.test(lower)) {
    return { kind: 'which_voucher' };
  }

  /*
   * A bare "sale return" with no number and no "report": the period summary is what a person
   * means, since a specific return would have been named by its number.
   */
  if (/\bsales?\s+returns?\b/.test(lower) && !/\d/.test(body)) {
    const period = parsePeriod(body);
    return {
      kind: 'report',
      documentType: 'sale_return_report',
      from: period?.from ?? null,
      to: period?.to ?? null,
      partyCode: null,
      partyName: null,
      itemName: null,
    };
  }
  if (/\bpurchase\s+returns?\b/.test(lower) && !/\d/.test(body)) {
    const period = parsePeriod(body);
    return {
      kind: 'report',
      documentType: 'purchase_return_report',
      from: period?.from ?? null,
      to: period?.to ?? null,
      partyCode: null,
      partyName: null,
      itemName: null,
    };
  }

  const named = DOCUMENT_BY_NUMBER.find(([pattern]) => pattern.test(lower));
  // Only when no number was given. "sale invoice 179" carries one and belongs to the ordinary
  // path; asking "which number?" for a message that just stated it reads as not listening.
  /*
   * A document named, with or without its number.
   *
   * With a number it is fetched; without, the number is asked for. Both are safe because the
   * company comes from the ASKING number's own registration, never from the message: a
   * request from a 1042 client builds `/internal/pdf/SL/1042/...` and cannot address another
   * company's documents. An invoice number only means anything inside the company that
   * issued it.
   */
  if (named) {
    const documentNumber = /\b(\d{1,10})\b/.exec(body)?.[1];
    if (documentNumber) {
      return { kind: 'document', documentType: named[2], displayName: named[1], documentNumber };
    }
    return { kind: 'need_document_number', displayName: named[1] };
  }

  return { kind: 'help' };
}

/** Removes the untrusted fence so the rule table matches on what the person actually wrote. */
function stripFence(content: string): string {
  const fenced = content.match(/<UNTRUSTED_[a-z0-9]+>\n([\s\S]*?)\n<\/UNTRUSTED_[a-z0-9]+>/i);
  return fenced ? fenced[1] : content;
}

/**
 * Renders a tool result for a person.
 *
 * Deliberately conservative: it reports shape and counts rather than trying to narrate
 * arbitrary JSON, because a rule engine narrating a structure it does not understand is how
 * a wrong summary gets sent to a customer under the business's name.
 */
function summariseToolResult(raw: string, isError: boolean): string {
  if (isError) return `That did not work: ${raw.slice(0, 300)}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.slice(0, 1200);
  }

  if (parsed && typeof parsed === 'object' && 'summary' in parsed && typeof parsed.summary === 'string') {
    return parsed.summary;
  }

  /*
   * The shapes the document tools return, rendered as sentences.
   *
   * This provider is what answers when the model is unavailable — and a free tier runs out
   * mid-afternoon. Without these a person asking for a ledger got back the raw
   * `{"queued":true,"jobId":…}` the tool produced, which is a debugging line, not a reply.
   * The fallback has to read like the bot on a bad day, not like a stack trace.
   */
  const row = parsed as Record<string, unknown>;
  if (row && typeof row === 'object') {
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    if ('queued' in row) {
      if (row.queued === true) {
        // Said as "preparing", not "arriving": the fetch and the send can both still fail, and
        // the PDF landing in the chat is the only honest confirmation. A failure now reports
        // itself, so silence after this line no longer means a document that never came.
        // Nothing: the PDF follows with its own caption, and the worker reports a failure.
        return '';
      }
      return str(row.reason) ?? str(row.message) ?? 'That could not be queued.';
    }
    /*
     * A customer looked up by name. Three answers, and the ambiguous one must read as a
     * question: offering a list and then picking from it silently is how one customer's
     * ledger reaches another.
     */
    if ('found' in row) {
      if (row.found === 'one') {
        const name = str(row.name) ?? 'That customer';
        const code = str(row.partyCode);
        return code
          ? `${name} — account ${code}. Shall I send their ledger?`
          : `${name} is in your books, but I could not confirm their account code. Please tell me the code.`;
      }
      if (row.found === 'several') {
        const list = Array.isArray(row.customers) ? (row.customers as Array<Record<string, unknown>>) : [];
        const lines = list
          .slice(0, 8)
          .map((c, i) => `${i + 1}. ${str(c.name) ?? '-'}${str(c.partyCode) ? ` (${str(c.partyCode)})` : ''}`)
          .join('\n');
        return `More than one customer matches. Which one?\n${lines}`;
      }
      return str(row.reason) ?? 'No customer of that name was found.';
    }
    if ('composed' in row) {
      if (row.composed !== true) return str(row.message) ?? 'That could not be drafted.';
      const missing = str(row.missing);
      const total = str(row.total);
      const head = `*${str(row.document) ?? 'Draft'} ${str(row.reference) ?? ''}*`.trim();
      if (missing) return `${head} started.${total ? ` Total so far: ${total}.` : ''}\n\nStill needed: ${missing}.`;
      return `${head} is ready.${total ? ` Total: ${total}.` : ''}\n\nReply *submit* to send it for approval, or *cancel* to drop it.`;
    }
    if ('submitted' in row) {
      if (row.submitted !== true) return str(row.message) ?? 'It could not be submitted.';
      return `*${str(row.reference) ?? 'The draft'}* has been submitted. It is now on the approval screen in Tijarah Books — no entry has been made.`;
    }
    if ('accepted' in row || 'added' in row) {
      const done = str(row.message) ?? 'Noted.';
      return row.readyToSubmit === true ? `${done}\n\nReady. Reply *submit* to send it for approval.` : done;
    }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return 'Nothing matched.';
    return `Found ${parsed.length}:\n${parsed
      .slice(0, 8)
      .map((item, index) => `${index + 1}. ${describe(item)}`)
      .join('\n')}`;
  }
  return describe(parsed);
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return '—';
  // Primitives only: an object reaching String() renders as [object Object], which is worse
  // than useless in a message a person reads.
  if (typeof value !== 'object') return primitiveToString(value).slice(0, 200);
  const row = value as Record<string, unknown>;
  const label = row.displayName ?? row.name ?? row.company ?? row.reference ?? row.id;
  const detail = row.phoneE164 ?? row.phone ?? row.state ?? row.summary;
  const rendered = [label, detail]
    .filter(part => part !== null && part !== undefined && part !== '')
    .map(primitiveToString)
    .join(' — ');
  return rendered.slice(0, 200) || JSON.stringify(row).slice(0, 200);
}

/** Renders a value that is known not to be an object. */
function primitiveToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}

/* ------------------------------------------------------------- customers */

/**
 * What a customer hears.
 *
 * Warm, short, and carefully bounded. It acknowledges, it never confirms, and it never
 * quotes a figure — a balance stated to a customer must come from a tool result for THAT
 * customer, and this table has no tool results at all.
 *
 * The `already_paid` case is the one that matters: it thanks them and says it will be
 * checked. It cannot say "settled", because nothing here has seen a bank statement.
 */
/**
 * What a customer asked for, as a tool call or a plain answer.
 *
 * `tool` null means the request is answered without touching anything — a decline, or a
 * question that needs no lookup. Anything else is serviced by a customer tool.
 */
export interface CustomerIntent {
  tool: string | null;
  input: Record<string, unknown>;
  narration: string;
  reply: string;
}

const NO_TOOL = (reply: string): CustomerIntent => ({ tool: null, input: {}, narration: '', reply });
const USE = (tool: string, input: Record<string, unknown>, narration: string): CustomerIntent => ({
  tool,
  input,
  narration,
  reply: '',
});

/** `INV-1001`, `INV 1001`, `inv1001` — the reference a customer will actually type. */
function invoiceNumberIn(text: string): string | null {
  const match = /\b(INV)[\s-]?(\d{2,})\b/i.exec(text);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

/** A payment reference, quoted after ref/reference/trx/txn or standing alone as TRX-88213. */
function paymentReferenceIn(text: string): string | null {
  const tagged = /\b(?:ref|reference|trx|txn|transaction)\b[:\s#-]*([A-Za-z0-9][A-Za-z0-9-]{3,})/i.exec(text);
  if (tagged) return tagged[1].toUpperCase();
  const bare = /\b(TRX[-\s]?[A-Za-z0-9]{3,})\b/i.exec(text);
  return bare ? bare[1].toUpperCase().replace(/\s/g, '-') : null;
}

/**
 * Maps a customer's message to one of their own tools.
 *
 * Order is load-bearing in two places, both learned the hard way:
 *
 *  - An opt-out is matched before everything, because "stop sending me invoices" contains
 *    "invoices" and must not be answered with a statement.
 *  - Action verbs are matched before document nouns: "create an invoice for 500000"
 *    contains "invoice", and matching the noun first replied "I have asked our team to send
 *    you a copy", which reads as though the request had been accepted.
 */
export function detectCustomerIntent(text: string): CustomerIntent {
  const body = String(text ?? '').trim();
  const lower = body.toLowerCase();

  if (
    /\b(stop|unsubscribe|opt.?out|do not contact|don'?t contact)\b/.test(lower) ||
    /\bband\s*kar/.test(lower) ||
    /میسج\s*بند/.test(body)
  ) {
    return USE('AgentOptOut', { optedOut: true }, 'Recording that request.');
  }

  if (/\b(resume|start again|contact me again|opt.?in)\b/.test(lower)) {
    return USE('AgentOptOut', { optedOut: false }, 'Recording that request.');
  }

  if (/\b(already |have )?paid\b/.test(lower) || /\bbhej\s*(di|diye|dia)\b/.test(lower) || /ادائیگی/.test(body)) {
    const reference = paymentReferenceIn(body);
    if (!reference) {
      /*
       * No reference, no record.
       *
       * Filing "the customer says they paid" with nothing to check it against gives the
       * accounts team a row they cannot action, and gives the customer the impression
       * something is in motion. Asking for the reference is the useful answer.
       */
      return NO_TOOL(
        'Thank you — to check that against our bank records I need the payment reference. ' +
          'Please send it and I will pass it straight to our accounts team.',
      );
    }
    return USE(
      'AgentSubmitPaymentReference',
      { reference, invoiceNumber: invoiceNumberIn(body) ?? undefined },
      'Passing that reference on.',
    );
  }

  /*
   * `on`/`by` are consumed, not captured — "I will pay on Friday" was recorded as a promise
   * to pay by "on Friday", which then got read back to the customer verbatim.
   */
  const promise =
    /\b(?:will pay|i'?ll pay|pay(?:ing)?)\s+(?:on|by)?\s*([a-z0-9 ]{2,20})/i.exec(body) ??
    /\b(?:by|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(body);
  if (promise) {
    const promisedDate = promise[1].trim().replace(/[^a-z0-9]+$/i, '');
    if (promisedDate) return USE('AgentRecordPromiseToPay', { promisedDate }, 'Noting that date.');
  }

  if (
    /\b(dispute|wrong amount|incorrect|overcharged|short|damaged)\b/.test(lower) ||
    /\b(hisab|raqam)\s*(ghalat|galat)\b/.test(lower)
  ) {
    return USE(
      'AgentRaiseDispute',
      { reason: body.slice(0, 600), invoiceNumber: invoiceNumberIn(body) ?? undefined },
      'Recording that dispute.',
    );
  }

  if (
    /\b(human|person|someone|call me|speak to|agent)\b/.test(lower) ||
    /\b(wrong|not (my|our))\b.*\b(number|account|company)\b/.test(lower) ||
    /\bghalat\s*(number|nambar)\b/.test(lower)
  ) {
    return USE('AgentRequestHuman', { reason: body.slice(0, 400) }, 'Asking a colleague to get in touch.');
  }

  // Before the document nouns: a customer asking to change the accounting system is declined.
  if (/\b(create|raise|issue|make|generate|cancel|delete|change|update|write off)\b/.test(lower)) {
    return NO_TOOL(
      'I am not able to make changes to your account from here. I can share your invoices or ' +
        'statement, or pass a request to our team — just let me know which.',
    );
  }

  const invoice = invoiceNumberIn(body);
  if (invoice) return USE('AgentSelfInvoice', { number: invoice }, `Looking up ${invoice}.`);

  if (/\b(statement|ledger|khata|hisab|invoices|bills)\b/.test(lower)) {
    return USE('AgentSelfStatement', {}, 'Fetching your account.');
  }

  if (/\b(balance|owe|outstanding|due|how much|kitna|kitne)\b/.test(lower) || /\b(invoice|bill|copy)\b/.test(lower)) {
    return USE('AgentSelfBalance', {}, 'Checking your account.');
  }

  /*
   * Anything else, including anything shaped like an instruction to the system.
   *
   * It promises nothing. The previous wording said the message had been passed to the team,
   * which was not true for an unrecognised message and set an expectation nobody would meet.
   */
  return NO_TOOL(
    'Thanks for your message. I can tell you your balance, send your statement, look up one of ' +
      'your invoices, or pass a payment reference to our accounts team — just say which. Reply ' +
      'HUMAN and a colleague will get in touch.',
  );
}

/**
 * Renders a customer tool's result as the sentence the customer reads.
 *
 * The tools each return a `reply` written next to the data that produced it, so this reads
 * that rather than describing the object. The fallbacks never leak field names: a customer
 * who hits an error gets an apology, not a stack of internals.
 */
export function summariseForCustomer(content: string, isError: boolean): string {
  if (isError) {
    return 'Sorry — I could not look that up just now. I have let our team know and someone will follow up.';
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      const reply = (parsed as { reply?: unknown }).reply;
      if (typeof reply === 'string' && reply.trim()) return reply;
    }
  } catch {
    // Not JSON: fall through to the neutral answer rather than echoing the raw content back.
  }
  return 'Thanks — that is done. If you need anything else about your account, just ask.';
}

/**
 * A line item as a person types it.
 *
 * "250 cotton fabric at 600" and "cotton fabric 250 x 600" are both how someone dictates a
 * line, so both are read. Anything that does not carry a quantity AND a rate is left alone —
 * a description on its own is far more likely to be the answer to a field question, and
 * guessing wrong puts the customer's name on an invoice line.
 */
/**
 * A line that names a quantity and an item but no price: "4pcs led bulb", "led bulb 300pcs".
 *
 * Returned separately from a complete line so the caller can ask for the one missing piece
 * rather than refusing the whole line. Never guesses a price — a wrong rate on an invoice is
 * worse than a question.
 */
export function parsePartialLine(text: string): { description: string; quantity: string; unit: string | null } | null {
  const body = String(text ?? '')
    .trim()
    .replace(/^\s*\(?\d{1,2}\s*[.)\]]\s+/, '');
  if (!body || /\b(at|@)\b/i.test(body)) return null;

  const unit = '(pcs|pc|piece|pieces|kg|g|box|boxes|dozen|meter|metre|m|ltr|litre|liter)';
  // "4pcs led bulb" / "250 cotton fabric"
  const leading = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${unit}?\\s+(.{2,60})$`, 'i').exec(body);
  if (leading) return { quantity: leading[1], unit: leading[2] ?? null, description: leading[3].trim() };
  // "led bulb 300pcs"
  const trailing = new RegExp(`^(.{2,60}?)\\s+(\\d+(?:\\.\\d+)?)\\s*${unit}?$`, 'i').exec(body);
  if (trailing) return { description: trailing[1].trim(), quantity: trailing[2], unit: trailing[3] ?? null };
  return null;
}

export function parseLineItem(text: string): { description: string; quantity: string; rate: string } | null {
  /*
   * A leading list number is stripped.
   *
   * A client wrote "1. 250 cotton fabric at 600" on 8 October and it parsed as nothing,
   * because the "1." was read as the quantity and the rest no longer matched. People number
   * their lines; the numbering is not part of the item.
   */
  const body = String(text ?? '')
    .trim()
    .replace(/^\s*\(?\d{1,2}\s*[.)\]]\s+/, '');
  if (!body) return null;

  const leading = /^(\d+(?:\.\d+)?)\s+(.+?)\s+(?:at|@|x|\*)\s*(\d+(?:\.\d+)?)$/i.exec(body);
  if (leading) return { quantity: leading[1], description: leading[2].trim(), rate: leading[3] };

  const trailing = /^(.+?)\s+(\d+(?:\.\d+)?)\s*(?:x|\*|at|@)\s*(\d+(?:\.\d+)?)$/i.exec(body);
  if (trailing) return { description: trailing[1].trim(), quantity: trailing[2], rate: trailing[3] };

  return null;
}
