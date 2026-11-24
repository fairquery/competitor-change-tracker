import { readFileSync } from 'node:fs';
import { snapshotFromHtml } from '../src/analyze.js';
const [file, url, type] = process.argv.slice(2);
const html = readFileSync(file, 'utf8');
const t = performance.now();
// @ts-ignore loose call for timing only
const s = snapshotFromHtml({ url, finalUrl: url, type, html, checkedAt: new Date().toISOString() }, { ignore: [], watchKeywords: [] });
console.log(type, url, Math.round(performance.now() - t), 'ms', s.sections?.length, s.entries?.length, s.plans?.length);
