import type { Browser, Page } from 'puppeteer-core';
import { createLogger } from '../../../common/services/logger.service';

/**
 * How the document providers reach a browser.
 *
 * A seam, so the provider's logic — logging in, waiting for the render, deciding what counts
 * as a finished page — is testable without launching Chromium. The real implementation is
 * below; tests substitute their own.
 */
export interface BrowserSession {
  withPage<T>(work: (page: Page) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface BrowserSessionConfig {
  /** A remote Chrome (browserless, or a sidecar container). Preferred: this app needs no browser. */
  wsEndpoint?: string;
  /** A local Chromium binary, when running the browser in-process. */
  executablePath?: string;
  headless: boolean;
  args: string[];
  navigationTimeoutMs: number;
}

export function readBrowserConfig(env: NodeJS.ProcessEnv = process.env): BrowserSessionConfig {
  const timeout = Number.parseInt(env.DOCUMENT_BROWSER_TIMEOUT_MS ?? '', 10);
  return {
    wsEndpoint: env.DOCUMENT_BROWSER_WS_ENDPOINT?.trim() || undefined,
    executablePath: env.DOCUMENT_BROWSER_EXECUTABLE?.trim() || undefined,
    headless: env.PUPPETEER_HEADLESS !== 'false',
    /*
     * `--no-sandbox` is required inside a container, where the kernel sandbox cannot be set up.
     * It is the standard flag for headless Chrome in Docker and is why this belongs in an
     * isolated browser service rather than alongside anything that handles untrusted input.
     */
    args: (env.PUPPETEER_ARGS ?? '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage')
      .split(/\s+/)
      .filter(Boolean),
    navigationTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
  };
}

/**
 * A long-lived browser, shared by every document fetch.
 *
 * Deliberately not one browser per document: launching Chrome takes seconds and a login round
 * trip more, so a per-document browser would make a five-second job a twenty-second one and
 * log in to the host system once per invoice. The browser is opened on first use and reused;
 * each fetch gets its own page and closes it.
 */
export class PuppeteerBrowserSession implements BrowserSession {
  private readonly logger = createLogger('BrowserSession');
  private browser: Browser | null = null;
  private opening: Promise<Browser> | null = null;

  constructor(private readonly config: BrowserSessionConfig) {}

  private async open(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    // One opening at a time: five jobs starting together must not launch five browsers.
    this.opening ??= this.launch().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async launch(): Promise<Browser> {
    const puppeteer = (await import('puppeteer-core')).default;
    if (this.config.wsEndpoint) {
      this.logger.log(`connecting to remote browser at ${this.config.wsEndpoint}`);
      this.browser = await puppeteer.connect({ browserWSEndpoint: this.config.wsEndpoint });
    } else if (this.config.executablePath) {
      this.logger.log(`launching ${this.config.executablePath}`);
      this.browser = await puppeteer.launch({
        executablePath: this.config.executablePath,
        headless: this.config.headless,
        args: this.config.args,
      });
    } else {
      throw new Error(
        'No browser configured. Set DOCUMENT_BROWSER_WS_ENDPOINT (a remote Chrome) or DOCUMENT_BROWSER_EXECUTABLE.',
      );
    }
    return this.browser;
  }

  async withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.open();
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    try {
      return await work(page);
    } finally {
      // Always closed, even when the work threw: a leaked page is a leaked tab, and enough of
      // them exhaust the browser's memory long before anyone notices the pattern.
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    // Disconnect from a shared remote browser; only close one we launched ourselves.
    await (this.config.wsEndpoint ? browser.disconnect() : browser.close()).catch(() => undefined);
  }
}
