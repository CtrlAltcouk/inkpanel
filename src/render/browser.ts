import { chromium, type Browser } from 'playwright';
import type { PanelProfile } from '../panel/profile.ts';

/**
 * One long-lived Chromium instance. Launching per render wastes several
 * hundred milliseconds and churns memory; the panel refreshes often enough
 * for that to matter.
 */
export class Renderer {
  private browser: Browser | null = null;

  private async ensure(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      // Required in most container configurations.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
    return this.browser;
  }

  /**
   * Launch Chromium ahead of the first request.
   *
   * A cold launch costs several seconds, and on a modest LXC enough of them
   * that a device's HTTP read times out before the first frame ever arrives.
   * Paying that at service startup instead moves the cost somewhere nobody is
   * waiting on it.
   */
  async warmUp(): Promise<void> {
    await this.ensure();
  }

  async screenshot(html: string, profile: PanelProfile): Promise<Buffer> {
    const browser = await this.ensure();
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: 1,
      // Deterministic output: no animations.
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({ type: 'png', animations: 'disabled' });
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
