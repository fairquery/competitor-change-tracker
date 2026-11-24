import { type Cheerio, type CheerioAPI, load } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

import { collapse, contentRoot, loadClean, spacedText } from './extract.js';
import { type ChangeItem, LIMITS, type Plan, type Price } from './types.js';

const PRE =
    '(US\\$|CA\\$|C\\$|A\\$|AU\\$|NZ\\$|HK\\$|S\\$|R\\$|\\$|€|£|¥|₹|₩|₽|₺|₪|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|INR|BRL|CHF|SEK|NOK|DKK|PLN)\\b)';
const NUM = '(\\d{1,3}(?:[,.\\u202f\\u00a0 ]\\d{3})+(?:[.,]\\d{1,4})?|\\d+(?:[.,]\\d{1,4})?)';
const POST = '(€|£|\\b(?:USD|EUR|GBP|CAD|AUD|CHF|SEK|NOK|DKK|PLN|kr|zł)\\b)';
export const PRICE_RE = new RegExp(`${PRE}\\s?${NUM}(?![\\d%])|(?<![\\d.,])${NUM}\\s?${POST}`, 'g');

const SYMBOL_TO_CODE: Record<string, string> = {
    $: 'USD',
    US$: 'USD',
    CA$: 'CAD',
    C$: 'CAD',
    A$: 'AUD',
    AU$: 'AUD',
    NZ$: 'NZD',
    HK$: 'HKD',
    S$: 'SGD',
    R$: 'BRL',
    '€': 'EUR',
    '£': 'GBP',
    '¥': 'JPY',
    '₹': 'INR',
    '₩': 'KRW',
    '₽': 'RUB',
    '₺': 'TRY',
    '₪': 'ILS',
    kr: 'SEK',
    zł: 'PLN',
};

export function currencyCode(sym: string): string {
    return SYMBOL_TO_CODE[sym] ?? sym.toUpperCase();
}

/** Parse "1,234.56", "1.234,56", "19,99", "$0.125" style numbers. */
export function parseAmount(raw: string, currency: string): number | null {
    let s = raw.replace(/[\u202f\u00a0 ]/g, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
        if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
        else s = s.replace(/,/g, '');
    } else if (lastComma >= 0) {
        const decimals = s.length - lastComma - 1;
        s =
            decimals === 3 && (s.match(/,/g) ?? []).length >= 1 && !/^0,/.test(s)
                ? s.replace(/,/g, '')
                : s.replace(',', '.');
    } else if (lastDot >= 0) {
        const decimals = s.length - lastDot - 1;
        const dots = (s.match(/\./g) ?? []).length;
        if (dots > 1 || (decimals === 3 && currency !== 'USD' && !/^0\./.test(s))) s = s.replace(/\./g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

export interface PriceMatch {
    raw: string;
    amount: number | null;
    currency: string;
    index: number;
}

export function findPrices(text: string): PriceMatch[] {
    const out: PriceMatch[] = [];
    PRICE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRICE_RE.exec(text))) {
        const sym = m[1] ?? m[4];
        const num = m[2] ?? m[3];
        const currency = currencyCode(sym);
        out.push({ raw: m[0].trim(), amount: parseAmount(num, currency), currency, index: m.index });
    }
    return out;
}

const MONTH_RE =
    /(?:\/\s*mo(?:nth)?\b|per\s+month|a\s+month|\bmonthly\b|\bmo\b|\/\s*mes\b|pro\s+monat|par\s+mois|\/\s*m\b)/i;
const YEAR_RE = /(?:\/\s*y(?:ea)?r\b|per\s+year|a\s+year|\byearly\b|\bannually\b|\/\s*an\b|pro\s+jahr|par\s+an\b)/i;
const WEEK_RE = /(?:\/\s*w(?:ee)?k\b|per\s+week|weekly)/i;
const HOUR_RE = /(?:\/\s*h(?:ou)?r\b|per\s+hour|hourly)/i;
const ONE_TIME_RE = /(?:one[-\s]time|lifetime|pay once)/i;
const ANNUAL_BILLING_RE =
    /(?:billed\s+(?:annually|yearly|per\s+year|once\s+a\s+year)|annual(?:ly)?\s+billing|paid\s+(?:annually|yearly)|\bper\s+year,?\s+billed|when\s+billed\s+yearly)/i;
const MONTHLY_BILLING_RE = /(?:billed\s+monthly|monthly\s+billing|paid\s+monthly|month-to-month)/i;
const UNIT_RE =
    /(?:\/|\bper\b|\ba\b|\beach\b)\s*(?:active\s+)?(user|seat|member|editor|agent|host|creator|contact|gb|tb|mb|request|credit|minute|1k|1,000|1m|million|domain|site|project|node|device)s?\b/i;

export function periodOf(after: string, context: string): Pick<Price, 'period' | 'billing' | 'unit'> {
    const near = after.slice(0, 40);
    let period: Price['period'] = null;
    if (ONE_TIME_RE.test(near)) period = 'one_time';
    else if (HOUR_RE.test(near)) period = 'hour';
    else if (WEEK_RE.test(near)) period = 'week';
    else if (MONTH_RE.test(near)) period = 'month';
    else if (YEAR_RE.test(near) && !ANNUAL_BILLING_RE.test(near)) period = 'year';
    else if (MONTH_RE.test(context)) period = 'month';
    else if (YEAR_RE.test(context)) period = 'year';
    let billing: Price['billing'] = null;
    if (ANNUAL_BILLING_RE.test(context)) billing = 'annual';
    else if (MONTHLY_BILLING_RE.test(context)) billing = 'monthly';
    if (period === 'year' && !billing) billing = 'annual';
    const um = UNIT_RE.exec(near) ?? UNIT_RE.exec(context.slice(0, 160));
    const unit = um ? um[1].toLowerCase().replace('1,000', '1k') : null;
    return { period, billing, unit };
}

const GENERIC_NAME =
    /^(?:usd|eur|gbp|us\$)\b|^(?:per|\/)|^(?:starts? at|starting at|from|your estimate|estimate.*|uh oh!?|placeholder|total|subtotal|price|cost|billed .*|save .*|or|and|then|plus tax.*)$|^(pricing|prices|plans?|plans (?:&|and) pricing|compare plans|monthly|annual(?:ly)?|yearly|billed (?:monthly|annually|yearly)|most popular|popular|recommended|best value|new|save \d+%?|save up to \d+%|features|faq|frequently asked questions|per month|per user|get started|start free|try (?:it )?(?:for )?free|buy now|choose|select|includes?|everything in .*|let[’']?s talk|talk to (?:us|sales)|contact (?:us|sales)|plans and features|compare (?:all )?features|add more .*|add-?ons?)$/i;
const NAME_CLASS =
    /(?:plan|tier|package|edition|product|card|pricing|price-?box)[-_]?(?:name|title|heading|label)|(?:^|[\s_-])(?:title|name|heading)(?:$|[\s_-])/i;

const BADGE = /(?:most popular|recommended|best value|popular|new|beta|current plan)/i;

function cleanName(t: string): string {
    let c = collapse(t.replace(PRICE_RE, ' '));
    c = c
        .replace(new RegExp(`^${BADGE.source}\\s+(?=\\S)`, 'i'), '')
        .replace(new RegExp(`\\s+${BADGE.source}$`, 'i'), '');
    c = c.replace(/\s*(?:\/\s*(?:mo|month|yr|year|user|seat)\b.*)$/i, '');
    return c.replace(/^[\s:,–-]+|[\s:,–-]+$/g, '');
}

function goodName(t: string): boolean {
    const c = cleanName(t);
    return c.length >= 2 && c.length <= 50 && !GENERIC_NAME.test(c) && /[a-z]/i.test(c) && c.split(' ').length <= 7;
}

export const sig = (p: Price): string => `${p.currency ?? ''}|${p.period ?? ''}|${p.billing ?? ''}|${p.unit ?? ''}`;
const samePrice = (a: Price, b: Price) => sig(a) === sig(b) && a.amount === b.amount && !!a.custom === !!b.custom;

export const planKey = (name: string): string =>
    name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

interface Ordered {
    order: Map<AnyNode, number>;
}

function indexOrder(root: Cheerio<AnyNode>): Ordered {
    const order = new Map<AnyNode, number>();
    let i = 0;
    const walk = (n: AnyNode) => {
        order.set(n, i++);
        for (const c of (n as Element).children ?? []) walk(c);
    };
    root.each((_, n) => walk(n));
    return { order };
}

/** 3 = h1-h6, 2 = element whose class/id says plan name/title, 1 = strong/b, 0 = not heading-like. */
function headingRank($: CheerioAPI, el: Element): number {
    const tag = el.name.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 3;
    if (tag === 'th' || tag === 'td' || tag === 'li') return 0;
    const cls = `${$(el).attr('class') ?? ''} ${$(el).attr('id') ?? ''} ${$(el).attr('data-testid') ?? ''}`;
    if (NAME_CLASS.test(cls)) return 2;
    return tag === 'strong' || tag === 'b' ? 1 : 0;
}
const headingLike = ($: CheerioAPI, el: Element) => headingRank($, el) > 0;
const nameText = (el: AnyNode) => spacedText(el);

function tableName($: CheerioAPI, cand: Element): string | null {
    const cell = $(cand).closest('td,th');
    if (!cell.length) return null;
    const row = cell.closest('tr');
    const table = row.closest('table');
    if (!table.length) return null;
    const idx = row.children('td,th').index(cell);
    const headRow = table.find('thead tr').first().length ? table.find('thead tr').first() : table.find('tr').first();
    if (headRow.length && !headRow.is(row)) {
        const hc = headRow.children('td,th').get(idx);
        const h = hc ? nameText(hc) : '';
        if (goodName(h)) return cleanName(h);
    }
    const fc = row.children('td,th').get(0);
    const first = fc ? nameText(fc) : '';
    if (idx > 0 && goodName(first)) return cleanName(first);
    return null;
}

/** Plans from JSON-LD Product / Offer markup, when the page has it. */
export function plansFromJsonLd(html: string): Plan[] {
    const $ = load(html);
    const plans: Plan[] = [];
    const visit = (node: unknown, parentName: string | null) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const x of node) visit(x, parentName);
            return;
        }
        const o = node as Record<string, unknown>;
        const type = String(o['@type'] ?? '');
        const name = typeof o.name === 'string' ? o.name : parentName;
        if (type.includes('Offer') && name) {
            const amount = Number(o.price ?? o.lowPrice);
            const currency = typeof o.priceCurrency === 'string' ? o.priceCurrency.toUpperCase() : null;
            if (Number.isFinite(amount) && currency) {
                const spec = o.priceSpecification as Record<string, unknown> | undefined;
                const unitText = String(spec?.unitText ?? spec?.billingDuration ?? '');
                const per = /mon|P1M/i.test(unitText) ? 'month' : /year|ann|P1Y/i.test(unitText) ? 'year' : null;
                plans.push({
                    name: collapse(name).slice(0, 80),
                    key: planKey(name),
                    prices: [
                        {
                            amount,
                            currency,
                            period: per,
                            billing: per === 'year' ? 'annual' : null,
                            unit: null,
                            raw: `${currency} ${amount}`,
                        },
                    ],
                });
            }
        }
        for (const [k, v] of Object.entries(o)) if (k !== '@context') visit(v, name);
    };
    $('script[type="application/ld+json"]').each((_, s) => {
        try {
            visit(JSON.parse($(s).text()), null);
        } catch {
            /* invalid JSON-LD ignored */
        }
    });
    return plans;
}

const CUSTOM_RE =
    /\b(contact (?:us|sales)|custom(?: pricing| quote)?|talk to (?:us|sales)|get a quote|let'?s talk|request (?:a )?(?:demo|quote)|book a demo)\b/i;

/**
 * Parse plan names and prices from a pricing page. Works on server-rendered HTML: each price is tied to the
 * closest preceding plan heading in its card (or its table column header). Strikethrough prices are skipped.
 */
export function extractPlans(html: string, prepared?: CheerioAPI, cssSelector?: string | null): Plan[] {
    const $ = prepared ?? loadClean(html);
    const root = contentRoot($, cssSelector) as Cheerio<AnyNode>;
    const { order } = indexOrder(root);
    const candidates: Element[] = [];
    root.find('*').each((_, el) => {
        if (el.type !== 'tag') return;
        const t = spacedText(el);
        if (!t || t.length > 90) return;
        PRICE_RE.lastIndex = 0;
        if (!PRICE_RE.test(t)) return;
        if ($(el).closest('del,s,strike').length) return;
        candidates.push(el);
    });
    const cset = new Set(candidates);
    const minimal = candidates.filter(
        (el) =>
            !$(el)
                .find('*')
                .toArray()
                .some((d) => cset.has(d as Element)),
    );
    const plans = new Map<string, Plan & { card: Element | null }>();
    const cards = new Set<Element>();
    for (const cand of minimal) {
        const text = spacedText(cand);
        const matches = findPrices(text);
        if (!matches.length) continue;
        let name: string | null = tableName($, cand);
        let card: Element | null = null;
        if (!name) {
            const co = order.get(cand) ?? 0;
            let anc: Element | null = cand;
            let fallback: { name: string; card: Element } | null = null;
            for (let lvl = 0; lvl < 7 && anc; lvl++) {
                anc = anc.parent && anc.parent.type === 'tag' ? (anc.parent as Element) : null;
                if (!anc) break;
                if (headingRank($, anc) === 3 && goodName(nameText(anc))) {
                    name = cleanName(nameText(anc));
                    card = anc.parent && anc.parent.type === 'tag' ? (anc.parent as Element) : anc;
                    break;
                }
                const heads = $(anc)
                    .find('*')
                    .toArray()
                    .filter(
                        (h) =>
                            h.type === 'tag' &&
                            (order.get(h) ?? 0) < co &&
                            headingLike($, h as Element) &&
                            !$(h).find(cand).length &&
                            goodName(nameText(h)),
                    ) as Element[];
                const best = Math.max(0, ...heads.map((h) => headingRank($, h)));
                const pick = heads.filter((h) => headingRank($, h) === best).pop();
                if (pick && best >= 2) {
                    name = cleanName(nameText(pick));
                    card = anc;
                    break;
                }
                if (pick && !fallback && lvl <= 2) fallback = { name: cleanName(nameText(pick)), card: anc };
            }
            if (!name && fallback) ({ name, card } = fallback);
        }
        if (!name) continue;
        const key = planKey(name);
        if (!key) continue;
        // context: the card (or parent) text after the price
        const ctxEl = card ?? (cand.parent as Element | null) ?? cand;
        const ctxText = spacedText(ctxEl);
        let plan = plans.get(key);
        if (!plan) {
            if (plans.size >= LIMITS.maxPlans) continue;
            plan = { name, key, prices: [], card };
            plans.set(key, plan);
        }
        if (card) cards.add(card);
        for (const m of matches) {
            const pos = ctxText.indexOf(text);
            const after =
                pos >= 0 ? ctxText.slice(pos + text.indexOf(m.raw) + m.raw.length) : text.slice(m.index + m.raw.length);
            const p: Price = { amount: m.amount, currency: m.currency, ...periodOf(after, ctxText), raw: m.raw };
            if (!plan.prices.some((x) => samePrice(x, p))) plan.prices.push(p);
        }
    }
    // plans without a number ("Enterprise: Contact sales") that sit in the same grid as priced cards
    const parents = new Map<Element, number>();
    for (const c of cards)
        if (c.parent && c.parent.type === 'tag')
            parents.set(c.parent as Element, (parents.get(c.parent as Element) ?? 0) + 1);
    for (const [grid, n] of parents) {
        if (n < 2) continue;
        $(grid)
            .children()
            .each((_, child) => {
                if (cards.has(child as Element)) return;
                const t = spacedText(child);
                if (!CUSTOM_RE.test(t) || findPrices(t).length) return;
                const h = $(child)
                    .find('*')
                    .toArray()
                    .find((x) => x.type === 'tag' && headingLike($, x as Element) && goodName(nameText(x)));
                if (!h) return;
                const name = cleanName(nameText(h));
                const key = planKey(name);
                if (!key || plans.has(key)) return;
                plans.set(key, {
                    name,
                    key,
                    card: child as Element,
                    prices: [
                        {
                            amount: null,
                            currency: null,
                            period: null,
                            billing: null,
                            unit: null,
                            custom: true,
                            raw: (CUSTOM_RE.exec(t) ?? [''])[0],
                        },
                    ],
                });
            });
    }
    const out: Plan[] = [...plans.values()].map(({ name, key, prices }) => ({
        name,
        key,
        prices: prices.sort((a, b) => sig(a).localeCompare(sig(b)) || (a.amount ?? -1) - (b.amount ?? -1)),
    }));
    if (/application\/ld\+json/i.test(html))
        for (const j of plansFromJsonLd(html)) if (!out.some((p) => p.key === j.key)) out.push(j);
    return out.slice(0, LIMITS.maxPlans);
}

export function fmtPrice(p: Price): string {
    if (p.custom) return p.raw || 'custom pricing';
    if (p.amount === null) return p.raw;
    const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' };
    const amt = Number.isInteger(p.amount) ? String(p.amount) : String(p.amount);
    const base = sym[p.currency ?? ''] ? `${sym[p.currency!]}${amt}` : `${amt} ${p.currency ?? ''}`.trim();
    const per = p.period && p.period !== 'one_time' ? `/${p.period}` : p.period === 'one_time' ? ' one-time' : '';
    const unit = p.unit ? ` per ${p.unit}` : '';
    const bill = p.billing === 'annual' && p.period === 'month' ? ' (billed annually)' : '';
    return `${base}${per}${unit}${bill}`;
}

const fmtList = (ps: Price[]) => (ps.length ? ps.map(fmtPrice).join(', ') : 'no price');

/** Compare two plan lists. Returns change items (price changes, plans added / removed). */
export function comparePlans(prev: Plan[], next: Plan[]): ChangeItem[] {
    const items: ChangeItem[] = [];
    const pm = new Map(prev.map((p) => [p.key, p]));
    const nm = new Map(next.map((p) => [p.key, p]));
    const added = next.filter((p) => !pm.has(p.key));
    const removed = prev.filter((p) => !nm.has(p.key));
    if (prev.length >= 2 && next.length === 0) {
        return [
            {
                kind: 'pricing_unparsed',
                severity: 'medium',
                summary: `Plan prices could no longer be read from the page (${prev.length} plans before). The page may have been redesigned or now loads prices with JavaScript; see the text diff.`,
                details: { previous_plans: prev.map((p) => p.name) },
            },
        ];
    }
    const common = prev.filter((p) => nm.has(p.key)).length;
    if (added.length >= 3 && removed.length >= 3 && common / Math.max(prev.length, 1) < 0.3) {
        return [
            {
                kind: 'pricing_restructured',
                severity: 'high',
                summary: `Pricing page restructured: plans now ${next.map((p) => p.name).join(', ')} (before: ${prev.map((p) => p.name).join(', ')}).`,
                details: {
                    plans_before: prev.map((p) => ({ name: p.name, prices: p.prices.map(fmtPrice) })),
                    plans_after: next.map((p) => ({ name: p.name, prices: p.prices.map(fmtPrice) })),
                },
            },
        ];
    }
    for (const p of added)
        items.push({
            kind: 'plan_added',
            severity: 'high',
            summary: `New plan "${p.name}" (${fmtList(p.prices)}).`,
            details: { plan: p.name, prices: p.prices },
        });
    for (const p of removed)
        items.push({
            kind: 'plan_removed',
            severity: 'high',
            summary: `Plan "${p.name}" removed (was ${fmtList(p.prices)}).`,
            details: { plan: p.name, previous_prices: p.prices },
        });
    for (const n of next) {
        const p = pm.get(n.key);
        if (!p) continue;
        const bySig = (ps: Price[]) => {
            const m = new Map<string, Price[]>();
            for (const x of ps)
                m.set(sig(x) + (x.custom ? '|custom' : ''), [
                    ...(m.get(sig(x) + (x.custom ? '|custom' : '')) ?? []),
                    x,
                ]);
            return m;
        };
        const a = bySig(p.prices);
        const b = bySig(n.prices);
        const changes: { from: Price | null; to: Price | null; pct: number | null }[] = [];
        const onlyA: Price[] = [];
        const onlyB: Price[] = [];
        for (const [s, pa] of a) {
            const pb = b.get(s);
            if (!pb) {
                onlyA.push(...pa);
                continue;
            }
            const am = pa.map((x) => x.amount ?? -1).sort((x, y) => x - y);
            const bm = pb.map((x) => x.amount ?? -1).sort((x, y) => x - y);
            if (am.join() === bm.join()) continue;
            if (pa.length === 1 && pb.length === 1) {
                const pct =
                    pa[0].amount && pb[0].amount !== null ? ((pb[0].amount - pa[0].amount) / pa[0].amount) * 100 : null;
                changes.push({ from: pa[0], to: pb[0], pct: pct === null ? null : Math.round(pct * 10) / 10 });
            } else {
                onlyA.push(...pa.filter((x) => !pb.some((y) => y.amount === x.amount)));
                onlyB.push(...pb.filter((x) => !pa.some((y) => y.amount === x.amount)));
            }
        }
        for (const [s, pb] of b) if (!a.has(s)) onlyB.push(...pb);
        // same amounts, different labels only (e.g. "per user" now detected): not a price change
        const amtKey = (ps: Price[]) =>
            ps
                .map((x) => `${x.currency}:${x.amount}`)
                .sort()
                .join();
        if (onlyA.length && onlyB.length && amtKey(onlyA) === amtKey(onlyB)) {
            onlyA.length = 0;
            onlyB.length = 0;
        }
        if (onlyA.length === 1 && onlyB.length === 1 && onlyA[0].currency === onlyB[0].currency) {
            const pct =
                onlyA[0].amount && onlyB[0].amount !== null
                    ? ((onlyB[0].amount - onlyA[0].amount) / onlyA[0].amount) * 100
                    : null;
            changes.push({ from: onlyA[0], to: onlyB[0], pct: pct === null ? null : Math.round(pct * 10) / 10 });
            onlyA.length = 0;
            onlyB.length = 0;
        }
        for (const c of changes) {
            const dir = c.pct === null ? 'changed' : c.pct > 0 ? `up ${c.pct}%` : `down ${Math.abs(c.pct)}%`;
            items.push({
                kind: 'price_changed',
                severity: 'high',
                summary: `"${n.name}" price changed from ${fmtPrice(c.from!)} to ${fmtPrice(c.to!)} (${dir}).`,
                details: { plan: n.name, from: c.from, to: c.to, change_pct: c.pct },
            });
        }
        if (onlyA.length || onlyB.length)
            items.push({
                kind: 'plan_prices_changed',
                severity: 'high',
                summary: `"${n.name}" prices changed: now ${fmtList(n.prices)} (before: ${fmtList(p.prices)}).`,
                details: {
                    plan: n.name,
                    removed_prices: onlyA,
                    added_prices: onlyB,
                    prices_before: p.prices,
                    prices_after: n.prices,
                },
            });
    }
    return items;
}
