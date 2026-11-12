#!/usr/bin/env python3
# Real token use from harness transcripts (JSONL): per-message usage, counted once per message id across
# all files, kept when the message's own timestamp is in [from, to). The harness `subagent_tokens` figure is
# a context size, not consumption: do not sum it.
# Usage: token-usage.py <dir-or-file>... --from <iso> [--to <iso>]  → JSON lines per transcript, then totals by role.
import json,sys,os,glob,collections
def role(text):
    t=text[:300].lower()
    for k,v in [('planner','planner'),('cause verifier','verifier'),('verifier','verifier'),('implementer','implementer'),('reviewer','reviewer'),('analyse','analysis'),('analyze','analysis'),('investigate','analysis'),('rules audit','audit')]:
        if k in t: return v
    return 'other'
def files(paths):
    for p in paths:
        if os.path.isdir(p): yield from sorted(glob.glob(os.path.join(p,'*.output'))+glob.glob(os.path.join(p,'*.jsonl')))
        else: yield p
def count(paths,lo,hi='9999'):
    seen=set(); rows=[]; tot=collections.defaultdict(collections.Counter)
    for f in files(paths):
        r=None; model=None; c=collections.Counter(); first=last=None
        for line in open(f,errors='ignore'):
            try: d=json.loads(line)
            except ValueError: continue
            if not isinstance(d,dict): continue
            m=d.get('message')
            if r is None and d.get('type')=='user' and isinstance(m,dict) and isinstance(m.get('content'),str): r=role(m['content'])
            if not (isinstance(m,dict) and m.get('usage') and m.get('id')): continue
            t=d.get('timestamp') or ''
            if not (lo<=t<hi) or m['id'] in seen: continue
            seen.add(m['id']); u=m['usage']; model=m.get('model',model)
            c['input']+=u.get('input_tokens',0); c['cache_write']+=u.get('cache_creation_input_tokens',0)
            c['cache_read']+=u.get('cache_read_input_tokens',0); c['output']+=u.get('output_tokens',0); c['messages']+=1
            first=min(first or t,t); last=max(last or t,t)
        if c['messages']:
            rows.append({'file':os.path.basename(f),'role':r or 'other','model':model,'first':first,'last':last,**c})
            tot[r or 'other'].update(c); tot['ALL'].update(c)
    return rows,tot
if __name__=='__main__':
    a=sys.argv[1:]; lo=a[a.index('--from')+1]; hi=a[a.index('--to')+1] if '--to' in a else '9999'
    paths=[x for i,x in enumerate(a) if not x.startswith('--') and (i==0 or a[i-1] not in ('--from','--to'))]
    rows,tot=count(paths,lo,hi)
    for x in sorted(rows,key=lambda x:x['first']): print(json.dumps(x))
    for k,v in tot.items(): print(json.dumps({'role':k,**v}))
