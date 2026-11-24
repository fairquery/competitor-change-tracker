import { type Cheerio, type CheerioAPI, load } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

import { type Entry, LIMITS, type Section } from './types.js';

export const collapse = (s: string): string =>
    s.replace(/(?:\s|\u00a0|\u200b|\u200c|\u200d|\u2060|\ufeff)+/g, ' ').trim();

export const MAX_CSS_SELECTOR_LENGTH = 300;

/** A selector that cannot be applied to a fetched page. */
export class SelectorError extends Error {
    constructor(
        message: string,
        readonly code: 'SELECTOR_INVALID' | 'SELECTOR_NOT_FOUND',
    ) {
        super(message);
        this.name = 'SelectorError';
    }
}

/** Null when `selector` is a usable CSS selector; otherwise a short reason. */
export function cssSelectorIssue(selector: string): string | null {
    const s = selector.trim();
    if (!s) return 'empty';
    if (s.length > MAX_CSS_SELECTOR_LENGTH) return `longer than ${MAX_CSS_SELECTOR_LENGTH} characters`;
    if ([...s].some((ch) => ch.charCodeAt(0) < 32)) return 'contains control characters';
    try {
        const $ = load('<html><body><div id="fq-probe"></div></body></html>');
        $(s);
    } catch (e) {
        return (e instanceof Error ? e.message : String(e)).slice(0, 160);
    }
    return null;
}

const DROP_TAGS =
    'script,style,noscript,template,svg,iframe,canvas,video,audio,object,embed,link,meta,input,select,textarea,dialog[aria-modal="true"]';
const CHROME_TAGS = 'nav,aside,[role="navigation"],[role="contentinfo"],[role="banner"]';

/** Text of an element with a space at every element boundary ("Business<span>Recommended</span>" -> "Business Recommended"). */
export function spacedText(node: AnyNode): string {
    const parts: string[] = [];
    const walk = (n: AnyNode) => {
        if (n.type === 'text') parts.push((n as unknown as { data: string }).data);
        else if (n.type === 'tag' || n.type === 'root') {
            parts.push(' ');
            for (const c of (n as Element).children ?? []) walk(c);
            parts.push(' ');
        }
    };
    walk(node);
    return collapse(parts.join(''));
}

/** Page-level header/footer (not a card's own <header>/<footer>): shallow in the tree or full of links. */
function removePageChrome($: CheerioAPI, root: Cheerio<Element>): void {
    root.find(CHROME_TAGS).remove();
    root.find('header,footer').each((_, el) => {
        const depth = $(el).parents().length;
        if (depth <= 4 || $(el).find('a[href]').length >= 8) $(el).remove();
    });
}

/** Known consent-manager containers (OneTrust, Cookiebot, CookieYes, Osano, TrustArc, Didomi, Usercentrics, iubenda, Termly, Quantcast, Klaro). */
const CONSENT_SELECTORS = [
    '#onetrust-consent-sdk',
    '#onetrust-banner-sdk',
    '#CybotCookiebotDialog',
    '#cookiebanner',
    '.cky-consent-container',
    '.osano-cm-window',
    '#truste-consent-track',
    '#didomi-host',
    '#usercentrics-root',
    '#iubenda-cs-banner',
    '.termly-styles-root',
    '#qc-cmp2-container',
    '.klaro',
    '.cc-window',
    '.cookie-consent',
    '#cookie-consent',
    '#cookie-banner',
    '.cookie-banner',
];

const BLOCK_TAGS = new Set([
    'p',
    'li',
    'td',
    'th',
    'dt',
    'dd',
    'blockquote',
    'pre',
    'figcaption',
    'caption',
    'summary',
    'div',
    'section',
    'article',
    'main',
    'ul',
    'ol',
    'table',
    'tr',
    'tbody',
    'thead',
    'form',
    'fieldset',
    'details',
    'address',
    'button',
    'label',
    'hr',
]);

export interface Block {
    h: number; // 0 = text, 1..6 = heading level
    text: string;
}

export interface Extracted {
    title: string | null;
    blocks: Block[];
    sections: Section[];
    text: string;
}

function isConsentBanner($: CheerioAPI, el: Element): boolean {
    const at = el.attribs ?? {};
    const idc = `${at.id ?? ''} ${at.class ?? ''}`.toLowerCase();
    if (!/cookie|consent|gdpr|ccpa/.test(idc)) return false;
    const role = (at.role ?? '').toLowerCase();
    if (role === 'dialog' || role === 'alertdialog' || at['aria-modal'] === 'true') return true;
    const text = collapse($(el).text());
    return (
        text.length < 1500 &&
        /\b(accept|agree|allow|reject|decline|got it|manage (?:preferences|cookies)|cookie settings)\b/i.test(text)
    );
}

/** Remove scripts, styles, consent banners and hidden templates. Keeps page chrome (nav/footer) for link discovery. */
export function loadClean(html: string): CheerioAPI {
    const $ = load(html);
    $(DROP_TAGS).remove();
    $(CONSENT_SELECTORS.join(',')).remove();
    $('[id],[class]').each((_, el) => {
        if (el.type === 'tag' && isConsentBanner($, el)) $(el).remove();
    });
    return $;
}

/**
 * Main content root: a pinned CSS selector when the user set one, otherwise `<main>`/`[role=main]`
 * if present and substantial, else `<body>` without nav/header/footer/aside.
 * A selector is applied after scripts and consent banners are removed.
 */
export function contentRoot($: CheerioAPI, cssSelector?: string | null): Cheerio<Element> {
    if (cssSelector) {
        let matched: Cheerio<AnyNode>;
        try {
            matched = $(cssSelector);
        } catch (e) {
            throw new SelectorError(
                `CSS selector is not valid (${cssSelector}): ${e instanceof Error ? e.message : String(e)}`,
                'SELECTOR_INVALID',
            );
        }
        if (!matched.length)
            throw new SelectorError(`CSS selector matched nothing on the page (${cssSelector})`, 'SELECTOR_NOT_FOUND');
        // One wrapper so section and plan extraction walk every match, including the matched element's own text.
        const wrapper = $('<div data-fq-selector-root="1"></div>');
        matched.each((_, el) => {
            wrapper.append($(el).clone());
        });
        return wrapper as Cheerio<Element>;
    }
    const main = $('main, [role="main"]').first();
    if (main.length && collapse(main.text()).length > 200) {
        const m = main.clone() as Cheerio<Element>;
        m.find('nav,[role="navigation"],[role="contentinfo"]').remove();
        return m;
    }
    const body = (($('body').length ? $('body') : $.root()) as Cheerio<AnyNode>).clone() as unknown as Cheerio<Element>;
    const stripped = body.clone();
    removePageChrome($, stripped);
    if (collapse(stripped.text()).length >= 200 || collapse(body.text()).length < 200) return stripped;
    // Over-stripped (e.g. the whole page sits inside <header>): fall back to body minus nav/footer only.
    body.find('nav,footer,[role="navigation"],[role="contentinfo"]').remove();
    return body;
}

export function blocksFrom($: CheerioAPI, root: Cheerio<AnyNode>): Block[] {
    const out: Block[] = [];
    let buf = '';
    const flush = () => {
        const t = collapse(buf);
        if (t) out.push({ h: 0, text: t });
        buf = '';
    };
    const walk = (node: AnyNode) => {
        if (node.type === 'text') {
            buf += (node as unknown as { data: string }).data;
            return;
        }
        if (node.type !== 'tag' && node.type !== 'root') return;
        const el = node as Element;
        const tag = el.name?.toLowerCase();
        const hm = tag ? /^h([1-6])$/.exec(tag) : null;
        if (hm) {
            flush();
            const t = collapse($(el).text());
            if (t) out.push({ h: Number(hm[1]), text: t });
            return;
        }
        if (tag === 'br') {
            buf += ' ';
            return;
        }
        const block = tag ? BLOCK_TAGS.has(tag) : false;
        if (block) flush();
        for (const c of el.children ?? []) walk(c);
        if (block) flush();
    };
    root.each((_, n) => {
        for (const c of (n as Element).children ?? []) walk(c);
    });
    flush();
    // drop consecutive duplicates (carousels, responsive duplicates)
    const dedup: Block[] = [];
    for (const b of out) {
        const prev = dedup[dedup.length - 1];
        if (prev && prev.text === b.text && prev.h === b.h) continue;
        dedup.push(b);
    }
    return dedup;
}

export function sectionsFrom(blocks: Block[]): Section[] {
    const sections: Section[] = [];
    let cur: { heading: string; lines: string[] } = { heading: '', lines: [] };
    const seen = new Map<string, number>();
    let total = 0;
    const push = () => {
        if (!cur.heading && !cur.lines.length) return;
        const base = cur.heading;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const heading = n ? `${base} (${n + 1})` : base;
        let text = cur.lines.join('\n');
        if (total + text.length > LIMITS.maxSectionChars)
            text = text.slice(0, Math.max(0, LIMITS.maxSectionChars - total));
        total += text.length;
        sections.push({ heading, text });
    };
    for (const b of blocks) {
        if (b.h >= 1 && b.h <= 4) {
            push();
            cur = { heading: b.text.slice(0, 200), lines: [] };
        } else cur.lines.push(b.text);
    }
    push();
    return sections;
}

/** Accepts raw HTML or a document already prepared with loadClean() (read-only use, so it can be shared). */
export function extract(html: string | CheerioAPI, cssSelector?: string | null): Extracted {
    const $ = typeof html === 'string' ? loadClean(html) : html;
    const title = collapse($('title').first().text()) || collapse($('h1').first().text()) || null;
    const root = contentRoot($, cssSelector);
    const blocks = blocksFrom($, root);
    return { title, blocks, sections: sectionsFrom(blocks), text: blocks.map((b) => b.text).join('\n') };
}

export interface Link {
    href: string;
    text: string;
}

/** All absolute http(s) links on the page (including nav/footer, which is where pricing/terms links live). */
export function linksFrom(html: string, baseUrl: string): Link[] {
    const $ = load(html);
    const out: Link[] = [];
    $('a[href]').each((_, a) => {
        const raw = ($(a).attr('href') ?? '').trim();
        if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(raw)) return;
        try {
            const u = new URL(raw, baseUrl);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
            u.hash = '';
            out.push({ href: u.toString(), text: collapse($(a).text()).slice(0, 120) });
        } catch {
            /* ignore bad href */
        }
    });
    return out;
}

const GENERIC_ENTRY =
    /^(read more|learn more|more|next|previous|older posts|newer posts|load more|view all|see all|subscribe|share|categories|tags|recent posts|related posts|popular posts|blog|changelog|release notes|news)$/i;

/** Changelog / blog entries: headings (h1-h4) in the content area with the link they point to. */
export function entriesFrom(html: string | CheerioAPI, baseUrl: string, cssSelector?: string | null): Entry[] {
    const $ = typeof html === 'string' ? loadClean(html) : html;
    const root = contentRoot($, cssSelector);
    const out: Entry[] = [];
    const seen = new Set<string>();
    for (const h of root.find('h1,h2,h3,h4').toArray()) {
        if (out.length >= LIMITS.maxEntries) break;
        const title = collapse($(h).text()).slice(0, 300);
        if (title.length < 3 || GENERIC_ENTRY.test(title)) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        let href = $(h).find('a[href]').first().attr('href') ?? $(h).closest('a[href]').attr('href') ?? null;
        if (!href) {
            const art = $(h).closest('article,li');
            if (art.length) href = art.find('a[href]').first().attr('href') ?? null;
        }
        let url: string | null = null;
        if (href) {
            try {
                url = new URL(href, baseUrl).toString();
            } catch {
                url = null;
            }
        }
        out.push({ title, url });
    }
    return out;
}
