import { parseAnalysisJson, renderTranscript } from './ai.service';

describe('renderTranscript', () => {
  it('labels each turn by speaker', () => {
    expect(
      renderTranscript([
        { direction: 'incoming', body: 'Hi' },
        { direction: 'outgoing', body: 'Hello!' },
      ]),
    ).toBe('Customer: Hi\nAgent: Hello!');
  });

  it('marks a media turn rather than dropping it', () => {
    // A silent gap would read as the customer saying nothing; the marker says something arrived.
    expect(renderTranscript([{ direction: 'incoming', body: '', type: 'image' }])).toBe('Customer: [image]');
  });

  it('drops an empty text turn entirely', () => {
    expect(renderTranscript([{ direction: 'incoming', body: '', type: 'text' }])).toBe('');
  });
});

describe('parseAnalysisJson', () => {
  const complete = JSON.stringify({
    summary: 'Customer asked about pricing.',
    intent: 'pricing',
    sentiment: 'positive',
    language: 'Spanish',
    keyPoints: ['500 units', 'needs it by Friday'],
    extracted: { orderNumber: 'A-1183', amount: 1450 },
    suggestedReply: 'Happy to help with pricing.',
    nextBestAction: 'Send the price list.',
  });

  it('parses a well-formed response', () => {
    const result = parseAnalysisJson(complete);
    expect(result).toMatchObject({
      intent: 'pricing',
      sentiment: 'positive',
      language: 'Spanish',
      keyPoints: ['500 units', 'needs it by Friday'],
    });
    // Non-string values in `extracted` are coerced rather than dropped.
    expect(result.extracted).toEqual({ orderNumber: 'A-1183', amount: '1450' });
  });

  it('extracts the object from a markdown fence a model added despite instructions', () => {
    const fenced = '```json\n' + complete + '\n```';
    expect(parseAnalysisJson(fenced).intent).toBe('pricing');
  });

  it('extracts the object from surrounding prose', () => {
    expect(parseAnalysisJson(`Sure! Here is the analysis:\n${complete}\nLet me know.`).intent).toBe('pricing');
  });

  it('degrades to a partial result instead of throwing on malformed JSON', () => {
    // A provider hiccup must surface as a weak answer in the panel, never as an exception.
    const result = parseAnalysisJson('{ this is not json');
    expect(result.intent).toBe('unknown');
    expect(result.sentiment).toBe('neutral');
    expect(result.keyPoints).toEqual([]);
  });

  it('keeps a non-JSON reply as the summary rather than discarding it', () => {
    const result = parseAnalysisJson('The customer is asking about delivery times.');
    expect(result.summary).toBe('The customer is asking about delivery times.');
  });

  it('coerces an out-of-vocabulary sentiment to neutral', () => {
    expect(parseAnalysisJson(JSON.stringify({ sentiment: 'furious' })).sentiment).toBe('neutral');
  });

  it('ignores a keyPoints value that is not an array of strings', () => {
    expect(parseAnalysisJson(JSON.stringify({ keyPoints: 'not an array' })).keyPoints).toEqual([]);
    expect(parseAnalysisJson(JSON.stringify({ keyPoints: [1, 'kept', null] })).keyPoints).toEqual(['kept']);
  });

  it('ignores an extracted value that is not an object', () => {
    expect(parseAnalysisJson(JSON.stringify({ extracted: ['a', 'b'] })).extracted).toEqual({});
  });

  it('bounds an oversized extracted map', () => {
    const huge = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, 'value']));
    expect(Object.keys(parseAnalysisJson(JSON.stringify({ extracted: huge })).extracted)).toHaveLength(20);
  });
});
