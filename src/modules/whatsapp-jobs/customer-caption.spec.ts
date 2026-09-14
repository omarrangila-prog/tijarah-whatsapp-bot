import * as fs from 'fs';
import * as path from 'path';

/**
 * What a customer reads above a PDF is the business speaking to them.
 *
 * A caption that says "sent by the WhatsApp delivery bot" tells the recipient their supplier
 * automated them, and it is the one line of the message they actually read. Wording written
 * for an operator — "delivery system", "if this arrived, the connection works" — leaks into
 * customer captions easily, because the same field carries both.
 *
 * This scans every place a caption is composed and fails if system vocabulary appears in one.
 * It is a drift guard, not a style rule: the failure it prevents is a customer being told
 * they were messaged by a machine.
 */
const FORBIDDEN = [
  // An endpoint, a host or a path fragment. The client asked for this explicitly, and the
  // reason is sound: a customer's message should say what their document is, not reveal the
  // shape of the supplier's API.
  /https?:\/\//i,
  /\/internal\//i,
  /\/report\/pdf\//i,
  /api\.[a-z]+\./i,
  /\bbot\b/i,
  /\bdelivery system\b/i,
  /\bautomated\b/i,
  /\bWhatsApp delivery\b/i,
  /\bthis is a test\b/i,
  /\bconnection works\b/i,
];

/** Files that compose a caption sent to a recipient. */
const SOURCES = [
  'src/modules/whatsapp-jobs/tijarah-queue.service.ts',
  'src/modules/whatsapp-jobs/whatsapp-jobs.controller.ts',
  'src/core/agent-tools/tools/report-request.tools.ts',
];

describe('customer-facing captions', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');

  it.each(SOURCES)('%s composes no caption that mentions the system', file => {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');

    /*
     * Only the caption itself is inspected. Comments and log lines are free to say "bot" —
     * they are read by whoever maintains this, never by a customer.
     */
    const captions = [...source.matchAll(/messageText:\s*([^,\n]+(?:\n\s*[^,\n]+)*),/g)].map(m => m[1]);
    expect(captions.length).toBeGreaterThan(0);

    for (const caption of captions) {
      for (const pattern of FORBIDDEN) {
        expect(caption).not.toMatch(pattern);
      }
    }
  });

  it('has a caption on every path that sends a document to someone', () => {
    // A missing caption is not a safety problem, but a bare PDF with no word about what it is
    // reads as spam — which for a document about someone's money is its own failure.
    for (const file of SOURCES) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      expect(source).toContain('messageText:');
    }
  });
});
