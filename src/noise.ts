/**
 * Noise filter. Text is compared after "noise normalisation": volatile tokens (times, dates, relative
 * times, session/CSRF-like tokens, UUIDs, hashes, copyright years, cache-busting query strings, view
 * counters) are replaced by placeholders, so a change that only touches them is not reported.
 * On page types where numbers matter (pricing, terms, privacy) other numbers are kept; elsewhere they
 * are masked too, so rotating counters ("12,431 teams use us") don't trigger alerts.
 */
const MONTHS =
    '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAYS = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*';

const RULES: [RegExp, string][] = [
    [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi, '<ts>'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
    [/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b/g, '<token>'],
    [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
    [/([?&](?:v|ver|t|ts|cb|cache|_|rev|hash|nonce|sig|token|utm_[a-z]+)=)[^&\s"')]+/gi, '$1<q>'],
    [new RegExp(`\\b${DAYS},?\\s+`, 'gi'), ''],
    [new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'), '<date>'],
    [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\.?,?\\s+\\d{4}\\b`, 'gi'), '<date>'],
    [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
    [/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, '<date>'],
    [/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?(?:\s*[A-Z]{2,4}T?)?\b/gi, '<time>'],
    [/\b(?:\d+|an?|one)\s+(?:sec(?:ond)?s?|min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b/gi, '<ago>'],
    [/\b(?:just now|yesterday|today|tomorrow|moments ago)\b/gi, '<ago>'],
    [/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?\d{4}/gi, '©'],
    [/\b\d[\d,.]*\s*(?:people|users|visitors|viewers)\s+(?:are\s+)?(?:viewing|online|watching|reading)\b/gi, '<live>'],
];

export function compileIgnore(patterns: string[]): RegExp[] {
    const out: RegExp[] = [];
    for (const p of patterns) {
        if (!p || p.length > 200) continue;
        if (/(\([^)]*[+*][^)]*\))[+*{]/.test(p)) continue; // nested quantifier (ReDoS) refused
        try {
            out.push(new RegExp(p, 'gi'));
        } catch {
            /* invalid regex: ignored (reported by validation) */
        }
    }
    return out;
}

export function normalizeNoise(text: string, numberSensitive: boolean, ignore: RegExp[] = []): string {
    let t = text;
    for (const re of ignore) t = t.replace(re, ' ');
    for (const [re, rep] of RULES) t = t.replace(re, rep);
    if (!numberSensitive) t = t.replace(/\d[\d,.]*/g, '<n>');
    return t.replace(/\s+/g, ' ').trim();
}

export function isNumberSensitive(type: string): boolean {
    return type === 'pricing' || type === 'terms' || type === 'privacy';
}
