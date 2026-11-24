"""Simulate competitor changes on the platform by editing the stored previous snapshots of watchlist fq-clean-108
in the named store (the live page then differs from the edited baseline). Token from env, never printed."""
import json,os,hashlib,urllib.request,urllib.parse,copy
H={"Authorization":"Bearer "+os.environ['APIFY_TOKEN'],"Content-Type":"application/json"}
def api(path,data=None,method="GET",raw=False):
    req=urllib.request.Request("https://api.apify.com/v2"+path,data=json.dumps(data).encode() if data is not None else None,headers=H,method=method)
    r=urllib.request.urlopen(req).read(); return r if raw else json.loads(r)
store=api("/key-value-stores/~fairquery-competitor-tracker")['data']['id'] if False else None
# named store id
for s in api("/key-value-stores?unnamed=0&limit=100")['data']['items']:
    if s['name']=='fairquery-competitor-tracker': store=s['id']
WL='fq-clean-108'
key=lambda t,u:'snap-'+hashlib.sha1(f"{WL}\n{t}\n{u}".encode()).hexdigest()[:32]
def get(t,u): return json.loads(api(f"/key-value-stores/{store}/records/{key(t,u)}",raw=True))
def put(t,u,s):
    s['etag']=None; s['last_modified']=None; s['raw_hash']=None
    req=urllib.request.Request(f"https://api.apify.com/v2/key-value-stores/{store}/records/{key(t,u)}",data=json.dumps(s).encode(),headers=H,method="PUT"); urllib.request.urlopen(req)
log={}
# 1 Basecamp pricing: Pro was $79 (now live $99), Studio missing (live: added), fake "Starter" (live: removed)
s=get('pricing','https://basecamp.com/pricing'); before=[(p['name'],[x.get('amount') for x in p['prices']]) for p in s['plans']]
for p in s['plans']:
    if p['name']=='Pro':
        for x in p['prices']: x['amount']=79; x['raw']=x.get('raw','').replace('99','79')
s['plans']=[p for p in s['plans'] if p['name']!='Studio']
fake=copy.deepcopy(s['plans'][0]); fake['name']='Starter'; fake['key']='starter'
for x in fake['prices']: x['amount']=15; x['raw']='$15'
s['plans'].append(fake); put('pricing','https://basecamp.com/pricing',s); log['basecamp_pricing']={'before':before,'edit':'Pro 99->79 in stored baseline, Studio removed, fake Starter $15 added'}
# 2 Linear pricing: Business stored as $14
s=get('pricing','https://linear.app/pricing')
for p in s['plans']:
    if p['name']=='Business':
        for x in p['prices']: x['amount']=14
put('pricing','https://linear.app/pricing',s); log['linear_pricing']='Business 16->14 in stored baseline'
# 3 Linear terms: one section reworded, one section deleted
s=get('terms','https://linear.app/terms'); secs=s['sections']
i=next(i for i,x in enumerate(secs) if len(x['text'])>400)
old=secs[i]['text']; parts=old.split('. ')
parts[1]='Customer may terminate this Agreement at any time with thirty days written notice and will receive a pro-rata refund of prepaid fees'
secs[i]['text']='. '.join(parts)
j=next(j for j,x in enumerate(secs) if j>i+3 and len(x['text'])>200)
removed=secs[j]['heading']
# deleting it from the baseline means the live page shows it as an added section
del secs[j]
s['content_hash']='simulated'; put('terms','https://linear.app/terms',s); log['linear_terms']={'reworded_section':secs[i]['heading'],'section_missing_from_baseline':removed}
# 4 Ashby Linear: 3 roles missing from baseline (live: new), 1 fake role (live: closed)
s=get('careers','https://jobs.ashbyhq.com/linear'); jobs=s['jobs']; dropped=[j['title'] for j in jobs[:3]]
fakej=copy.deepcopy(jobs[-1]); fakej['id']='sim-closed-1'; fakej['title']='Senior Simulated Engineer'; fakej['department']='Engineering'
s['jobs']=jobs[3:]+[fakej]; s['content_hash']='simulated'; put('careers','https://jobs.ashbyhq.com/linear',s); log['ashby_linear']={'missing_from_baseline':dropped,'fake_closed':'Senior Simulated Engineer'}
# 5 Linear changelog: top 2 entries missing from baseline
s=get('changelog','https://linear.app/changelog'); top=[e['title'] for e in s['entries'][:2]]; s['entries']=s['entries'][2:]; s['content_hash']='simulated'
put('changelog','https://linear.app/changelog',s); log['linear_changelog']={'missing_from_baseline':top}
# 6 Tailscale sitemap: 5 URLs missing (live: added), 2 fake (live: removed)
s=get('product','https://tailscale.com/'); urls=s['sitemap_urls']; miss=[u for u in urls if '/kb/' in u][:5] or urls[:5]
s['sitemap_urls']=sorted([u for u in urls if u not in miss]+['https://tailscale.com/features/simulated-a','https://tailscale.com/features/simulated-b']); s['content_hash']='simulated'
put('product','https://tailscale.com/',s); log['tailscale_sitemap']={'missing_from_baseline':miss,'fake':['/features/simulated-a','/features/simulated-b']}
json.dump(log,open('B4-simulated/edits.json','w'),indent=1) if os.path.isdir('B4-simulated') else (os.makedirs('B4-simulated'),json.dump(log,open('B4-simulated/edits.json','w'),indent=1))
print(json.dumps(log,indent=1)[:2500])
