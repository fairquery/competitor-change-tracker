import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { log } from 'apify';
import type { Browser } from 'playwright';

import { isPrivateAddress } from './ssrf.js';
import { USER_AGENT } from './types.js';

/**
 * Optional headless-browser fallback for JavaScript-rendered pages. The caller has already checked robots.txt
 * for the page URL. One fresh context per page (no cookies or storage carried over), images/media/fonts
 * blocked, requests to private/internal addresses refused, same honest User-Agent, no CAPTCHA handling.
 */
export class Renderer {
    private browser: Browser | null = null;
    private hostOk = new Map<string, Promise<boolean>>();
    renders = 0;

    private async publicHost(host: string): Promise<boolean> {
        if (!this.hostOk.has(host))
            this.hostOk.set(
                host,
                (async () => {
                    if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return false;
                    if (isIP(host)) return !isPrivateAddress(host);
                    try {
                        const a = await lookup(host, { all: true });
                        return a.length > 0 && !a.some((x) => isPrivateAddress(x.address));
                    } catch {
                        return false;
                    }
                })(),
            );
        return this.hostOk.get(host)!;
    }

    async render(url: string, timeoutMs = 30_000): Promise<{ html: string; finalUrl: string; status: number }> {
        if (!this.browser) {
            const { chromium } = await import('playwright');
            this.browser = await chromium.launch({
                headless: true,
                executablePath: process.env.FQ_CHROME_PATH || undefined,
                args: ['--disable-dev-shm-usage', '--no-sandbox'],
            });
        }
        const ctx = await this.browser.newContext({ userAgent: USER_AGENT, javaScriptEnabled: true, serviceWorkers: 'block' });
        try {
            await ctx.route('**/*', async (route) => {
                const req = route.request();
                const type = req.resourceType();
                if (type === 'image' || type === 'media' || type === 'font') return route.abort();
                let host: string;
                try {
                    const u = new URL(req.url());
                    if (u.protocol !== 'https:' && u.protocol !== 'http:') return route.abort();
                    host = u.hostname;
                } catch {
                    return route.abort();
                }
                if (!(await this.publicHost(host))) return route.abort();
                return route.continue();
            });
            const page = await ctx.newPage();
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            await page.waitForLoadState('networkidle', { timeout: Math.min(15_000, timeoutMs) }).catch(() => undefined);
            const html = await page.content();
            this.renders += 1;
            return { html, finalUrl: page.url(), status: resp?.status() ?? 0 };
        } finally {
            await ctx.close().catch(() => undefined);
        }
    }

    async close(): Promise<void> {
        if (this.browser) await this.browser.close().catch((e) => log.debug(`browser close: ${String(e)}`));
        this.browser = null;
    }
}
