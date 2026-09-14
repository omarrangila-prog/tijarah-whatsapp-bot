import {
  detectIntent,
  detectLanguage,
  detectSentiment,
  HeuristicAiProvider,
  rewriteProfessionally,
  shorten,
} from './heuristic.provider';

describe('detectIntent', () => {
  it.each([
    ['I want a refund, this arrived broken', 'complaint'],
    ['where is my order, any tracking?', 'order_status'],
    ['how much for 500 units', 'pricing'],
    ['I have made the bank transfer, here is the receipt', 'payment'],
    ['can I book an appointment on Tuesday', 'booking'],
    ['the app shows an error when I log in', 'support'],
    ['hello there', 'greeting'],
  ])('classifies %j as %s', (text, expected) => {
    expect(detectIntent(text)).toBe(expected);
  });

  it('prefers the more specific label when two families both match', () => {
    // "refund" and "order" both appear; a complaint is the actionable read.
    expect(detectIntent('I want a refund for my order')).toBe('complaint');
  });

  it('falls back to a general enquiry, and to unknown for nothing at all', () => {
    expect(detectIntent('is anyone there')).toBe('general_enquiry');
    expect(detectIntent('   ')).toBe('unknown');
  });
});

describe('detectSentiment', () => {
  it('reads a negative message', () => {
    expect(detectSentiment('this is terrible and I am frustrated')).toBe('negative');
  });

  it('reads a positive message', () => {
    expect(detectSentiment('thanks, this is perfect')).toBe('positive');
  });

  it('reads a neutral message', () => {
    expect(detectSentiment('what time do you close')).toBe('neutral');
  });
});

describe('detectLanguage', () => {
  it('is decisive on script', () => {
    expect(detectLanguage('مرحبا كيف حالك')).toBe('Arabic');
    expect(detectLanguage('你好，价格是多少')).toBe('Chinese');
  });

  it('recognises Latin languages by distinctive words', () => {
    expect(detectLanguage('hola, cuál es el precio')).toBe('Spanish');
    expect(detectLanguage('bonjour, combien coûte la livraison')).toBe('French');
  });

  it('does not misread English containing short foreign-looking words', () => {
    // A transliterated greeting contains " o " — matching on such short words used to report
    // English conversations as Portuguese.
    expect(detectLanguage('Assalam o alaikum, what is the price for 500 polo shirts?')).toBe('English');
  });
});

describe('rewriteProfessionally', () => {
  it('expands chat shorthand and fixes casing and punctuation', () => {
    expect(rewriteProfessionally('hey pls send ur order no asap thx')).toBe(
      'Hey please send your order no as soon as possible thank you.',
    );
  });

  it('capitalises a standalone i', () => {
    expect(rewriteProfessionally('i will check and get back to you.')).toBe('I will check and get back to you.');
  });

  it('leaves existing terminal punctuation alone', () => {
    expect(rewriteProfessionally('Can you confirm?')).toBe('Can you confirm?');
  });
});

describe('shorten', () => {
  it('keeps the first two sentences with single spacing', () => {
    const input = 'One sentence here. Two sentences here. Three sentences here. Four here.';
    expect(shorten(input)).toBe('One sentence here. Two sentences here.');
  });

  it('leaves a short message untouched', () => {
    expect(shorten('All set, thanks!')).toBe('All set, thanks!');
  });

  it('trims a single long sentence at a word boundary', () => {
    const result = shorten('word '.repeat(80));
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(160);
  });
});

describe('HeuristicAiProvider', () => {
  const provider = new HeuristicAiProvider();

  it('is always available — that is its purpose', () => {
    expect(provider.isAvailable()).toBe(true);
  });

  it('produces a complete analysis object from a transcript', async () => {
    const transcript = [
      'Customer: Hi, how much for 500 polo shirts?',
      'Agent: Happy to help.',
      'Customer: My order A-1183 was late and I want a refund. Email me at bilal@example.com',
    ].join('\n');

    const parsed = JSON.parse(await provider.complete({ task: 'analyze', system: '', user: transcript })) as Record<
      string,
      unknown
    >;

    expect(parsed.intent).toBe('complaint');
    expect(parsed.sentiment).toBe('negative');
    expect(parsed.extracted).toMatchObject({ orderNumber: 'A-1183', email: 'bilal@example.com' });
    expect(String(parsed.summary)).toContain('2 messages');
    expect(String(parsed.suggestedReply).length).toBeGreaterThan(20);
    expect(String(parsed.nextBestAction)).toContain('Escalate');
  });

  it('does not fabricate an order number from ordinary prose after the keyword', async () => {
    // "Tracking says delivered" must not yield orderNumber "says": a plausible-looking fabrication
    // is worse than reporting nothing, because an agent would act on it.
    const transcript = 'Customer: My parcel has not arrived. Tracking says delivered but I have nothing.';
    const parsed = JSON.parse(await provider.complete({ task: 'analyze', system: '', user: transcript })) as {
      extracted: Record<string, string>;
    };
    expect(parsed.extracted.orderNumber).toBeUndefined();
  });

  it('finds a real reference even when a false positive appears earlier in the transcript', async () => {
    // "Tracking says" is rejected for having no digit; the scan must continue to the real one
    // rather than stopping at the first candidate.
    const transcript = [
      'Customer: My parcel has not arrived. Tracking says delivered but I have nothing.',
      'Customer: Order number is A-2077. I need this resolved today.',
    ].join('\n');
    const parsed = JSON.parse(await provider.complete({ task: 'analyze', system: '', user: transcript })) as {
      extracted: Record<string, string>;
    };
    expect(parsed.extracted.orderNumber).toBe('A-2077');
  });

  it('still extracts a real order reference', async () => {
    const transcript = 'Customer: My order number is A-2077 and it never arrived.';
    const parsed = JSON.parse(await provider.complete({ task: 'analyze', system: '', user: transcript })) as {
      extracted: Record<string, string>;
    };
    expect(parsed.extracted.orderNumber).toBe('A-2077');
  });

  it('never quotes a media placeholder back as something the customer said', async () => {
    // Media turns are rendered as bracketed markers so the model can see that something arrived.
    // Quoting one reads as "the customer opened with [unknown]", which summarises our own
    // placeholder rather than the conversation.
    const transcript = ['Customer: [unknown]', 'Customer: My order A-2077 never arrived.'].join('\n');
    const parsed = JSON.parse(await provider.complete({ task: 'analyze', system: '', user: transcript })) as {
      summary: string;
    };
    expect(parsed.summary).not.toContain('[unknown]');
    expect(parsed.summary).toContain('A-2077');
  });

  it('says so plainly when every turn is an attachment', async () => {
    const transcript = ['Customer: [voice]', 'Customer: [voice]'].join('\n');
    const parsed = JSON.parse(await provider.complete({ task: 'analyze', system: '', user: transcript })) as {
      summary: string;
    };
    expect(parsed.summary).toContain('attachments or voice notes');
    expect(parsed.summary).not.toContain('[voice]');
  });

  it('only reads customer turns when deciding what to suggest', async () => {
    const transcript = ['Agent: Would you like to book a slot?', 'Customer: What is the price?'].join('\n');
    const reply = await provider.complete({ task: 'suggest_reply', system: '', user: transcript });
    expect(reply.toLowerCase()).toContain('pricing');
  });

  describe('handoff briefing', () => {
    const brief = async (transcript: string) =>
      JSON.parse(await provider.complete({ task: 'handoff', system: '', user: transcript })) as {
        situation: string;
        promised: string[];
        tone: string;
        openQuestions: string[];
        watchOut: string;
        nextMessage: string;
      };

    it('reports only commitments OUR side actually made', async () => {
      // Inventing a promise is the worst possible failure here: the incoming agent would honour it.
      const result = await brief(
        [
          'Customer: Can you ship by Friday?',
          'Agent: Yes, we will dispatch it on Thursday.',
          'Customer: Great, thanks.',
        ].join('\n'),
      );
      expect(result.promised.join(' ')).toContain('Thursday');
    });

    it('does not treat the customer’s own words as a commitment from us', async () => {
      const result = await brief('Customer: I will pay tomorrow, will you send it today?');
      expect(result.promised).toEqual([]);
    });

    it('reports nothing promised when we only asked questions', async () => {
      const result = await brief(['Customer: My order is late.', 'Agent: What is the order number?'].join('\n'));
      expect(result.promised).toEqual([]);
    });

    it('lists only questions asked AFTER our last reply as still open', async () => {
      // Anything before our last message, we answered — carrying it forward would send the incoming
      // agent to re-answer something the customer already has.
      const result = await brief(
        ['Customer: What is the price?', 'Agent: It is PKR 1,450 each.', 'Customer: Do you deliver to Lahore?'].join(
          '\n',
        ),
      );
      expect(result.openQuestions).toEqual(['Do you deliver to Lahore?']);
    });

    it('warns the incoming agent when the customer is already unhappy', async () => {
      const result = await brief('Customer: This is terrible, I want a refund.');
      expect(result.tone).toContain('apologetic');
      expect(result.watchOut).toContain('unhappy');
    });

    it('always offers a next message so the thread continues rather than restarting', async () => {
      const result = await brief('Customer: What is the price for 500 shirts?');
      expect(result.nextMessage.length).toBeGreaterThan(20);
    });
  });

  it('refuses translation instead of echoing the input back untranslated', async () => {
    // Silently returning the source text would send the customer the wrong language.
    await expect(provider.complete({ task: 'translate', system: '', user: 'hello' })).rejects.toThrow(
      /language model/i,
    );
  });
});
