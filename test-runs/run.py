"""Start a run of the private Actor, wait, and save dataset/OUTPUT/cost. Usage: run.py NAME INPUT.json [MEMORY_MB]
The API token is read from the APIFY_TOKEN env var and never printed."""
import json,os,sys,time,urllib.request
ACT=open(os.path.join(os.path.dirname(__file__),'actor-id.txt')).read().strip()
H={"Authorization":"Bearer "+os.environ['APIFY_TOKEN'],"Content-Type":"application/json"}
def api(path,data=None,method="GET",raw=False):
    req=urllib.request.Request("https://api.apify.com/v2"+path,data=json.dumps(data).encode() if data is not None else None,headers=H,method=method)
    r=urllib.request.urlopen(req).read()
    return r if raw else json.loads(r)
name,inp=sys.argv[1],sys.argv[2]; mem=sys.argv[3] if len(sys.argv)>3 else "256"
out=os.path.join(os.path.dirname(__file__),name); os.makedirs(out,exist_ok=True)
body=json.load(open(inp)); json.dump(body,open(f"{out}/input.json","w"),indent=1)
rid=os.environ.get('ATTACH_RUN') or api(f"/acts/{ACT}/runs?memory={mem}",body,"POST")['data']['id']; print("run",name,rid,flush=True)
while True:
    d=api(f"/actor-runs/{rid}")['data']
    if d['status'] not in ('READY','RUNNING'): break
    time.sleep(5)
items=api(f"/datasets/{d['defaultDatasetId']}/items?clean=1&format=json",raw=True)
json.dump(json.loads(items),open(f"{out}/dataset.json","w"),indent=1)
try: o=json.loads(api(f"/key-value-stores/{d['defaultKeyValueStoreId']}/records/OUTPUT",raw=True))
except Exception: o=None
json.dump(o,open(f"{out}/OUTPUT.json","w"),indent=1)
log=api(f"/logs/{rid}",raw=True).decode('utf8','replace'); open(f"{out}/log.txt","w").write(log)
st=d.get('stats',{})
info={"run_id":rid,"status":d['status'],"memory_mb":int(mem),"started":d['startedAt'],"finished":d['finishedAt'],
 "usage_usd":d.get('usageTotalUsd'),"compute_units":st.get('computeUnits'),"run_time_secs":st.get('runTimeSecs'),
 "usage":d.get('usageUsd'),"charged_event_counts":d.get('chargedEventCounts')}
json.dump(info,open(f"{out}/run.json","w"),indent=1)
print(json.dumps({k:info[k] for k in ('run_id','status','usage_usd','compute_units','run_time_secs')}))
if o: print(json.dumps({k:o.get(k) for k in ('status','counts','requests','bytes','events','event_charges_usd_at_list_price','duration_secs','webhook')}))
