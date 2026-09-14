import { Injectable } from '@nestjs/common';
import type { AiCompletionRequest, AiProvider } from './ai-provider.interface';

/**
 * The offline provider: deterministic text analysis with no model behind it.
 *
 * It exists so the copilot panel is never dead. A hackathon demo, an air-gapped install, or a
 * deployment that has simply not set a key still gets a usable summary, a sentiment read and a
 * draft — and the UI labels the result as `heuristic` rather than passing it off as model output,
 * because claiming otherwise would be a lie about where the answer came from.
 *
 * Everything here is rule-based and explainable: keyword intent matching, a small sentiment
 * lexicon, script/stop-word language detection, and pattern extraction for the details that
 * actually matter in a business chat (order numbers, amounts, emails, dates).
 */
@Injectable()
export class HeuristicAiProvider implements AiProvider {
  readonly id = 'heuristic';
  readonly model = null;

  /** Always available — that is the entire point of it. */
  isAvailable(): boolean {
    return true;
  }

  complete(request: AiCompletionRequest): Promise<string> {
    switch (request.task) {
      case 'analyze':
        return Promise.resolve(JSON.stringify(this.analyze(request.user)));
      case 'handoff':
        return Promise.resolve(JSON.stringify(this.handoff(request.user)));
      case 'suggest_reply':
        return Promise.resolve(this.suggestReply(request.user));
      case 'rewrite':
        return Promise.resolve(rewriteProfessionally(request.user));
      case 'shorten':
        return Promise.resolve(shorten(request.user));
      case 'translate':
        // Honest refusal: pretending to translate by echoing the input would silently send the
        // customer the wrong language. The caller surfaces this as "unavailable", not as a result.
        return Promise.reject(new Error('Translation needs a language model. Configure AI_API_KEY to enable it.'));
      default:
        return Promise.resolve('');
    }
  }

  private analyze(transcript: string): Record<string, unknown> {
    const lines = transcript.split('\n').filter(line => line.trim());
    const customerLines = lines.filter(line => line.startsWith('Customer:')).map(stripSpeaker);
    const corpus = (customerLines.length ? customerLines : lines.map(stripSpeaker)).join(' ');

    const intent = detectIntent(corpus);
    const sentiment = detectSentiment(corpus);
    return {
      summary: buildSummary(customerLines, intent),
      intent,
      sentiment,
      language: detectLanguage(corpus),
      keyPoints: extractKeyPoints(customerLines.length ? customerLines : lines.map(stripSpeaker)),
      extracted: extractDetails(corpus),
      suggestedReply: replyForIntent(intent, sentiment),
      nextBestAction: nextActionForIntent(intent, sentiment),
    };
  }

  /**
   * Brief an agent taking the conversation over.
   *
   * The one field that must never be guessed is `promised`: inventing a commitment the previous
   * agent did not make is worse than offering none, because the incoming agent would honour it. So
   * it is drawn only from OUR OWN turns, and only from sentences that actually contain a
   * commitment word plus something concrete — a number, a date, or a currency amount.
   */
  private handoff(transcript: string): Record<string, unknown> {
    const lines = transcript.split('\n').filter(line => line.trim());
    const customerLines = lines.filter(line => line.startsWith('Customer:')).map(stripSpeaker);
    const agentLines = lines.filter(line => line.startsWith('Agent:')).map(stripSpeaker);
    const corpus = customerLines.join(' ');
    const intent = detectIntent(corpus);
    const sentiment = detectSentiment(corpus);

    const promised = agentLines
      .flatMap(line => line.split(/(?<=[.!?])\s+/))
      .filter(
        sentence =>
          /\b(will|we'll|i'll|shall|promise|guarantee|confirm|send|refund|dispatch|deliver|arrange)\b/i.test(
            sentence,
          ) &&
          /\d|\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)\b/i.test(sentence),
      )
      .map(sentence => sentence.trim())
      .slice(-4);

    // Unanswered = the customer's questions after our last reply. Anything before it, we responded to.
    const lastAgentIndex = lines.map(l => l.startsWith('Agent:')).lastIndexOf(true);
    const sinceOurReply = lines
      .slice(lastAgentIndex + 1)
      .filter(l => l.startsWith('Customer:'))
      .map(stripSpeaker);
    const openQuestions = sinceOurReply.filter(line => !isPlaceholder(line) && line.includes('?')).slice(0, 4);

    return {
      situation: buildSummary(customerLines, intent),
      promised,
      tone:
        sentiment === 'negative'
          ? 'apologetic and careful'
          : agentLines.length > 0
            ? 'warm and helpful'
            : 'not yet established',
      openQuestions,
      watchOut:
        sentiment === 'negative'
          ? 'The customer is already unhappy — acknowledge the problem before asking them for anything.'
          : promised.length > 0
            ? 'A commitment has already been made above; do not contradict it.'
            : '',
      nextMessage: replyForIntent(intent, sentiment),
    };
  }

  private suggestReply(transcript: string): string {
    const customerLines = transcript
      .split('\n')
      .filter(line => line.startsWith('Customer:'))
      .map(stripSpeaker);
    const corpus = customerLines.join(' ');
    return replyForIntent(detectIntent(corpus), detectSentiment(corpus));
  }
}

function stripSpeaker(line: string): string {
  return line.replace(/^(Customer|Agent):\s*/, '').trim();
}

/** Intent vocabulary, ordered so the more specific label wins when two families both match. */
const INTENT_RULES: Array<{ intent: string; patterns: RegExp[] }> = [
  {
    intent: 'complaint',
    patterns: [/\b(complain|refund|broken|damaged|wrong|late|delay|not work|terrible|worst|angry)\b/i],
  },
  { intent: 'order_status', patterns: [/\b(order|tracking|shipment|delivered|dispatch|courier|parcel)\b/i] },
  { intent: 'pricing', patterns: [/\b(price|cost|quote|how much|rate|discount|charges|fee)\b/i] },
  { intent: 'payment', patterns: [/\b(payment|pay|invoice|bank|transfer|receipt|paid|billing)\b/i] },
  { intent: 'booking', patterns: [/\b(book|appointment|schedule|reserve|slot|availability)\b/i] },
  { intent: 'support', patterns: [/\b(help|issue|problem|error|not working|support|fix)\b/i] },
  { intent: 'greeting', patterns: [/^\s*(hi|hello|hey|salam|assalam|good (morning|afternoon|evening))\b/i] },
];

export function detectIntent(text: string): string {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some(pattern => pattern.test(text))) return rule.intent;
  }
  return text.trim() ? 'general_enquiry' : 'unknown';
}

const POSITIVE = /\b(thanks|thank you|great|perfect|excellent|good|happy|love|appreciate|awesome|nice)\b/gi;
const NEGATIVE =
  /\b(angry|bad|worst|terrible|awful|disappointed|frustrated|useless|broken|late|never|refund|complain|poor)\b/gi;

export function detectSentiment(text: string): 'positive' | 'neutral' | 'negative' {
  const positives = (text.match(POSITIVE) ?? []).length;
  const negatives = (text.match(NEGATIVE) ?? []).length;
  if (negatives > positives) return 'negative';
  if (positives > negatives) return 'positive';
  return 'neutral';
}

/**
 * Language detection by script first, then by stop words.
 *
 * Script is decisive where it exists (Arabic, Chinese, Cyrillic, Devanagari), which covers the
 * cases a Latin-alphabet word list cannot. Latin text falls back to a short stop-word check, and
 * anything unrecognised is reported as English rather than guessed at.
 */
export function detectLanguage(text: string): string {
  if (/[؀-ۿ]/.test(text)) return 'Arabic';
  if (/[一-鿿]/.test(text)) return 'Chinese';
  if (/[Ѐ-ӿ]/.test(text)) return 'Russian';
  if (/[ऀ-ॿ]/.test(text)) return 'Hindi';
  if (/[฀-๿]/.test(text)) return 'Thai';
  // Latin script: match on words that are distinctive to ONE language. Short function words are
  // deliberately excluded — a single " o " or " la " occurs in plenty of English sentences (and in
  // transliterated Urdu/Arabic greetings), and matching on them reported English chats as Portuguese.
  const lower = ` ${text.toLowerCase()} `;
  if (/ (gracias|hola|precio|cuánto|buenos días|por favor|necesito|pedido) /.test(lower)) return 'Spanish';
  if (/ (merci|bonjour|s'il vous plaît|combien|commande|livraison) /.test(lower)) return 'French';
  if (/ (danke|hallo|preis|bestellung|guten tag|lieferung) /.test(lower)) return 'German';
  if (/ (obrigado|olá|preço|você|encomenda|bom dia) /.test(lower)) return 'Portuguese';
  return 'English';
}

/**
 * A media turn is rendered as a bracketed marker (`[voice]`, `[unknown]`) so the model can see that
 * something arrived rather than reading silence. Those markers must never be QUOTED back as if the
 * customer had said them — "the customer opened with [unknown]" is a summary of our own placeholder,
 * not of the conversation.
 */
function isPlaceholder(line: string): boolean {
  return /^\[[a-z_ ]+\]$/i.test(line.trim());
}

function buildSummary(customerLines: string[], intent: string): string {
  if (customerLines.length === 0) return 'No customer messages in this conversation yet.';

  const quotable = customerLines.filter(line => !isPlaceholder(line));
  const label = intent.replace(/_/g, ' ');
  const attachments = customerLines.length - quotable.length;
  const attachmentNote =
    attachments > 0 ? ` They also sent ${attachments} attachment${attachments === 1 ? '' : 's'}.` : '';

  // Every turn was media: describe that honestly rather than quoting a marker.
  if (quotable.length === 0) {
    return `The customer has sent ${customerLines.length} message${customerLines.length === 1 ? '' : 's'}, all attachments or voice notes with no text to read.`;
  }

  const first = quotable[0].slice(0, 160);
  const last = quotable[quotable.length - 1].slice(0, 160);
  if (quotable.length === 1) {
    return `The customer opened a ${label} conversation: "${first}".${attachmentNote}`;
  }
  return `The customer has sent ${customerLines.length} messages about ${label}. They opened with "${first}" and most recently said "${last}".${attachmentNote}`;
}

/** Lines that carry a number, a date, a price or an address are the ones worth keeping. */
function extractKeyPoints(lines: string[]): string[] {
  const interesting = lines.filter(
    line => /\d/.test(line) || /\b(address|deadline|urgent|tomorrow|today|asap|before)\b/i.test(line),
  );
  return interesting.slice(-5).map(line => (line.length > 180 ? `${line.slice(0, 179)}…` : line));
}

/** Structured details a business actually needs off a chat, matched by shape rather than by model. */
function extractDetails(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/)?.[0];
  if (email) out.email = email;
  // Order/invoice reference. Two rules make this trustworthy:
  //
  //  - the reference must contain a DIGIT, so ordinary prose after the keyword ("Tracking says
  //    delivered") is rejected rather than reported as an order number — a plausible-looking
  //    fabrication is worse than no answer, because an agent would act on it;
  //  - EVERY candidate is scanned, not just the first. A single leftmost false positive earlier in
  //    the transcript would otherwise suppress a real reference further down.
  const orderCandidates = text.matchAll(
    /(?:order|invoice|ref|tracking)(?:\s+(?:number|no\.?|id|is|was))*[\s#:-]*([A-Za-z0-9][A-Za-z0-9-]{2,19})\b/gi,
  );
  for (const candidate of orderCandidates) {
    if (/\d/.test(candidate[1])) {
      out.orderNumber = candidate[1];
      break;
    }
  }
  const amount = text.match(/(?:[$€£₹]|\b(?:usd|eur|pkr|inr|aed)\b)\s?([\d,]+(?:\.\d{1,2})?)/i)?.[0];
  if (amount) out.amount = amount.trim();
  const phone = text.match(/\+\d[\d\s-]{7,16}\d/)?.[0];
  if (phone) out.phone = phone.trim();
  return out;
}

const REPLIES: Record<string, string> = {
  complaint:
    'I am really sorry about this — thank you for flagging it. Let me look into what went wrong and come back to you with a fix. Could you confirm the order or reference number so I can pull up the details?',
  order_status:
    'Thanks for checking in. Let me pull up the latest status on your order — could you confirm the order number so I get you the right one?',
  pricing:
    'Happy to help with pricing. Could you let me know the product and quantity you have in mind? I will send exact numbers straight away.',
  payment:
    'Thanks for getting in touch about payment. I can share the payment details and send you a receipt once it is through — would you like me to send the invoice to this number?',
  booking: 'Glad to help you book. What day and time suits you best? I will check availability and confirm.',
  support:
    'Sorry you are running into this. So I can fix it quickly — what exactly happens when you try, and when did it start?',
  greeting: 'Hi there 👋 Thanks for reaching out — how can we help you today?',
  general_enquiry:
    'Thanks for your message. Could you share a little more detail so I can point you to the right answer?',
  unknown: 'Thanks for reaching out — how can we help today?',
};

function replyForIntent(intent: string, sentiment: 'positive' | 'neutral' | 'negative'): string {
  const base = REPLIES[intent] ?? REPLIES.unknown;
  // An unhappy customer needs the acknowledgement before the question, and the complaint reply
  // already leads with one — so only the other intents get the prefix.
  if (sentiment === 'negative' && intent !== 'complaint') {
    return `I am sorry for the trouble here. ${base}`;
  }
  return base;
}

function nextActionForIntent(intent: string, sentiment: 'positive' | 'neutral' | 'negative'): string {
  if (sentiment === 'negative') return 'Escalate: set priority to High and reply within the hour.';
  switch (intent) {
    case 'pricing':
      return 'Send the price list and tag the conversation as Sales.';
    case 'order_status':
      return 'Look up the order and share tracking, then set the status to Waiting.';
    case 'payment':
      return 'Send the invoice and create a follow-up for payment confirmation.';
    case 'booking':
      return 'Offer two concrete time slots and create a follow-up for the booking.';
    case 'support':
      return 'Gather reproduction details, then assign to the Support team.';
    default:
      return 'Reply to acknowledge, then assign an owner so nothing stalls.';
  }
}

/** Light professional pass: fix casing and spacing, expand chat shorthand, ensure end punctuation. */
export function rewriteProfessionally(text: string): string {
  const expansions: Array<[RegExp, string]> = [
    [/\bu\b/gi, 'you'],
    [/\bur\b/gi, 'your'],
    [/\bpls\b/gi, 'please'],
    [/\bplz\b/gi, 'please'],
    [/\bthx\b/gi, 'thank you'],
    [/\btnx\b/gi, 'thank you'],
    [/\basap\b/gi, 'as soon as possible'],
    [/\bidk\b/gi, 'I am not sure'],
    [/\bwanna\b/gi, 'would like to'],
    [/\bgonna\b/gi, 'going to'],
    [/\bcant\b/gi, 'cannot'],
    [/\bdont\b/gi, 'do not'],
  ];
  let out = text.trim().replace(/\s+/g, ' ');
  for (const [pattern, replacement] of expansions) out = out.replace(pattern, replacement);
  // Sentence-case each sentence, and always capitalise a standalone "i".
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, letter: string) => lead + letter.toUpperCase());
  out = out.replace(/\bi\b/g, 'I');
  if (out && !/[.!?]$/.test(out)) out += '.';
  return out;
}

/** Keep the first two sentences, or hard-trim at a word boundary when it is one long sentence. */
export function shorten(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const sentences = trimmed.match(/[^.!?]+[.!?]+/g);
  // Each captured sentence keeps the whitespace that preceded it, so trim before rejoining or the
  // result carries a double space at every seam.
  if (sentences && sentences.length > 2) {
    return sentences
      .slice(0, 2)
      .map(sentence => sentence.trim())
      .join(' ');
  }
  if (trimmed.length <= 160) return trimmed;
  const cut = trimmed.slice(0, 157);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}
