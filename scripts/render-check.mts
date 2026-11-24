import { Renderer } from '../src/browser.ts';
import { extractPlans, fmtPrice } from '../src/pricing.ts';
const r = new Renderer();
for (const u of ['https://www.atlassian.com/software/jira/pricing','https://www.typeform.com/pricing/']) {
  const t0=Date.now();
  try { const out = await r.render(u); const plans = extractPlans(out.html);
  console.log(u, out.status, out.html.length, Date.now()-t0,'ms', plans.slice(0,6).map(p=>p.name+' '+p.prices.slice(0,2).map(fmtPrice).join('/')));
  } catch(e) { console.log(u,'ERR',String(e).slice(0,300)); }
}
await r.close();
