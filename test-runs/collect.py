"""Refresh final usage for every saved run and write cost-summary.json/.md. Token from env, never printed."""
import json,os,glob,urllib.request
H={"Authorization":"Bearer "+os.environ['APIFY_TOKEN']}
rows=[]
for f in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)),'*/run.json'))):
    info=json.load(open(f)); d=json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.apify.com/v2/actor-runs/{info['run_id']}",headers=H)))['data']
    info.update(usage_usd=d.get('usageTotalUsd'),compute_units=d['stats'].get('computeUnits'),run_time_secs=d['stats'].get('runTimeSecs'),usage=d.get('usageUsd'))
    json.dump(info,open(f,'w'),indent=1)
    o=json.load(open(os.path.join(os.path.dirname(f),'OUTPUT.json')))
    docs=o['events'].get('page-checked',0)
    rows.append(dict(name=os.path.basename(os.path.dirname(f)),run_id=info['run_id'],memory_mb=info['memory_mb'],pages=docs,renders=o.get('browser_renders',0),changes=o['changes'],
        baselines=o['baselines'],requests=o['requests'],mb=round(o['bytes_downloaded']/1e6,1),secs=round(info['run_time_secs'],1),cu=round(info['compute_units'],5),
        usage_usd=round(info['usage_usd'],5),usd_per_page=round(info['usage_usd']/max(docs,1),6),cu_per_page=round(info['compute_units']/max(docs,1),6)))
json.dump(rows,open('cost-summary.json','w'),indent=1)
hdr=list(rows[0].keys()); md=['| '+' | '.join(hdr)+' |','|'+'---|'*len(hdr)]+['| '+' | '.join(str(r[k]) for k in hdr)+' |' for r in rows]
open('cost-summary.md','w').write('\n'.join(md)+'\n'); print('\n'.join(md))
