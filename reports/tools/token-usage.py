#!/usr/bin/env python3
# Real token use per subagent from harness transcripts: sum of per-message usage, deduped by message id.
# usage.py <tasks-dir> <from-iso> [to-iso] → JSON lines per agent + totals by role.
import json,sys,os,glob,collections
D,lo=sys.argv[1],sys.argv[2]; hi=sys.argv[3] if len(sys.argv)>3 else '9999'
def role(text):
    t=text[:300].lower()
    for k,v in [('cause verifier','verifier'),('verifier','verifier'),('implementer','implementer'),('reviewer','reviewer'),('analyse','analysis'),('analyze','analysis'),('investigate','analysis'),('rules audit','audit')]:
        if k in t: return v
    return 'other'
rows=[];tot=collections.defaultdict(lambda:collections.Counter())
for f in glob.glob(os.path.join(D,'*.output')):
    seen={};first=None;r=None;model=None;ts=[]
    for l in open(f,errors='ignore'):
        try:d=json.loads(l)
        except:continue
        if not isinstance(d,dict): continue
        t=d.get('timestamp')
        if t: ts.append(t)
        m=d.get('message')
        if r is None and d.get('type')=='user' and isinstance(m,dict) and isinstance(m.get('content'),str): r=role(m['content'])
        if isinstance(m,dict) and m.get('usage') and m.get('id'):
            seen[m['id']]=m['usage']; model=m.get('model',model)
    if not ts or min(ts)<lo or min(ts)>hi or not seen: continue
    c=collections.Counter()
    for u in seen.values():
        c['input']+=u.get('input_tokens',0); c['cache_write']+=u.get('cache_creation_input_tokens',0)
        c['cache_read']+=u.get('cache_read_input_tokens',0); c['output']+=u.get('output_tokens',0); c['messages']+=1
    rows.append({'agent':os.path.basename(f)[:-7],'role':r or 'other','model':model,'start':min(ts),'end':max(ts),**c})
    tot[r or 'other'].update(c); tot['ALL'].update(c)
for x in sorted(rows,key=lambda x:x['start']): print(json.dumps(x))
for k,v in tot.items(): print(json.dumps({'role':k,**v}))
