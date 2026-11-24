export const VERSION = '1.0';
export const SCHEMA_VERSION = '1.0.0';
export const ROBOTS_AGENT = 'FairqueryChangeTracker';
export const USER_AGENT = `${ROBOTS_AGENT}/${VERSION} (+https://getfairquery.com; info@getfairquery.com)`;

export const PAGE_TYPES = [
    'pricing',
    'product',
    'terms',
    'privacy',
    'careers',
    'changelog',
    'blog',
    'generic',
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export const CHARGE_EVENTS = {
    pageChecked: 'page-checked',
    changeDetected: 'change-detected',
    pageRendered: 'page-rendered',
} as const;

/** List prices proposed for the Store (used only to report an estimate in the run summary). */
export const LIST_PRICES_USD: Record<string, number> = {
    'page-checked': 0.0003,
    'change-detected': 0.0049,
    'page-rendered': 0.0059,
};

export const LIMITS = {
    maxPages: 200,
    maxDomains: 50,
    maxKeywords: 50,
    maxIgnorePatterns: 20,
    maxPatternLength: 200,
    maxHtmlBytes: 5_000_000,
    maxSitemapBytes: 30_000_000,
    maxJsonBytes: 20_000_000,
    maxSitemapUrls: 50_000,
    maxSectionChars: 400_000,
    maxJobs: 5_000,
    maxEntries: 300,
    maxPlans: 80,
    maxListedItems: 50,
};

export const DEFAULTS = {
    requestTimeoutMs: 20_000,
    hostDelayMs: 1_500,
    minHostDelayMs: 1_000,
    maxCrawlDelayS: 30,
    parallelHosts: 4,
    robotsCacheMs: 24 * 3600_000,
    discoveryCacheMs: 30 * 24 * 3600_000,
};

export interface Price {
    amount: number | null;
    currency: string | null;
    period: 'month' | 'year' | 'week' | 'day' | 'hour' | 'one_time' | null;
    billing: 'monthly' | 'annual' | null;
    unit: string | null;
    custom?: boolean;
    raw: string;
}

export interface Plan {
    name: string;
    key: string;
    prices: Price[];
}

export interface Section {
    heading: string;
    text: string;
}

export interface Entry {
    title: string;
    url: string | null;
}

export interface Job {
    id: string;
    title: string;
    department: string | null;
    location: string | null;
}

export interface Snapshot {
    v: 1;
    url: string;
    final_url: string;
    type: PageType;
    checked_at: string;
    etag: string | null;
    last_modified: string | null;
    raw_hash: string | null;
    content_hash: string;
    rendered: boolean;
    title: string | null;
    sections: Section[];
    plans: Plan[] | null;
    entries: Entry[] | null;
    jobs: Job[] | null;
    ats: { ats: string; slug: string } | null;
    sitemap_urls: string[] | null;
    sitemap_files: string[] | null;
    keyword_counts: Record<string, number>;
    recent_hashes?: { h: string; at: string }[]; // earlier content versions (A/B flip detection)
    /** Region pinned for this snapshot. Absent on snapshots saved before CSS selectors existed. */
    css_selector?: string | null;
}

export interface ChangeItem {
    kind: string;
    severity: Severity;
    summary: string;
    details: Record<string, unknown>;
}

export interface PageTarget {
    url: string;
    type: PageType;
    label: string | null;
    source: 'input' | 'discovered';
    domain: string | null;
    /** When set, only this DOM region is extracted and compared. */
    cssSelector?: string | null;
}
