#!/usr/bin/env python3
# Real token use and its price from harness transcripts (JSONL): per-message usage, counted once per message id across
# all files, kept when the message's own timestamp is in [from, to). The harness `subagent_tokens` figure is
# a context size, not consumption: do not sum it. Money is the API price per model (PRICE below, USD per million
# tokens; a cache read is cheap, so tokens alone overstate long contexts). `batched` = tool turns with more than one call.
# Usage: token-usage.py [<dir-or-file>...] --from <iso> [--to <iso>] [--table] [--only <session id prefixes, comma>]
#   --only: the sessions of one track (a release's coordinator sessions); the total line then says how many of all
#   sessions it counts and what all of them cost, so a release is not charged for the other tracks
#   no path: every session of this project (main transcripts and their subagents)
#   default output: JSON lines per transcript, then totals by role; --table: one line per session and launch, totals by role
import json,sys,os,glob,collections
PRICE={'fable':(8,40,.2),'opus':(4,20,.2),'sonnet':(2,10,.1),'haiku':(.1,.5,.01)}  # input, output, cache read; a 5 min cache write is 1.25 x input, a 1 h one 2 x
def role(text):
    t=text[:300].lower()
    hits=[(t.find(k),v) for k,v in [('planner','planner'),('cause-finder','planner'),('verifier','verifier'),('implementer','implementer'),('reviewer','reviewer'),('analyse','analysis'),('analyze','analysis'),('investigate','analysis'),('rules audit','audit'),('audit','audit')] if k in t]
    return min(hits)[1] if hits else 'other'  # the role the brief names first, not the first in this list
def files(paths):
    for p in paths:
        if os.path.isdir(p): yield from sorted(glob.glob(os.path.join(p,'*.output'))+glob.glob(os.path.join(p,'*.jsonl'))+glob.glob(os.path.join(p,'*','subagents','*.jsonl')))
        else: yield p
def text_of(content):
    if isinstance(content,str): return content
    if isinstance(content,list): return ' '.join(x.get('text','') for x in content if isinstance(x,dict) and x.get('type')=='text')
    return ''
def usd(model,u):
    i,o,r=PRICE[next((k for k in PRICE if k in (model or '')),'opus')]
    cc=u.get('cache_creation') or {}; w5=cc.get('ephemeral_5m_input_tokens',0); w1=cc.get('ephemeral_1h_input_tokens',0)
    if not cc: w5=u.get('cache_creation_input_tokens',0)
    return (u.get('input_tokens',0)*i+w5*i*1.25+w1*i*2+u.get('cache_read_input_tokens',0)*r+u.get('output_tokens',0)*o)/1e6
def count(paths,lo,hi='9999',only=None):
    seen=set(); rows=[]; tot=collections.defaultdict(collections.Counter)
    for f in files(paths):
        r=None; model=None; c=collections.Counter(); first=last=None; label=''; calls=collections.Counter(); cost=0.0; ctx=0
        for line in open(f,errors='ignore'):
            try: d=json.loads(line)
            except ValueError: continue
            if not isinstance(d,dict): continue
            m=d.get('message')
            if r is None and d.get('type')=='user' and isinstance(m,dict):
                first_text=text_of(m.get('content'))
                if first_text: r=role(first_text); label=' '.join(first_text.split())[:70]
            if not (isinstance(m,dict) and m.get('id')): continue
            t=d.get('timestamp') or ''
            if not (lo<=t<hi): continue
            if isinstance(m.get('content'),list): calls[m['id']]+=sum(1 for x in m['content'] if isinstance(x,dict) and x.get('type')=='tool_use')  # one line per content block: add them up
            if not m.get('usage') or m['id'] in seen: continue
            seen.add(m['id']); u=m['usage']; model=m.get('model',model)
            c['input']+=u.get('input_tokens',0); c['cache_write']+=u.get('cache_creation_input_tokens',0)
            c['cache_read']+=u.get('cache_read_input_tokens',0); c['output']+=u.get('output_tokens',0); c['messages']+=1
            cost+=usd(model,u); ctx=max(ctx,u.get('input_tokens',0)+u.get('cache_read_input_tokens',0)+u.get('cache_creation_input_tokens',0))
            first=min(first or t,t); last=max(last or t,t)
        if c['messages']:
            main=os.path.basename(os.path.dirname(f))!='subagents' and f.endswith('.jsonl')
            c['tool_turns']=sum(1 for v in calls.values() if v); c['batched']=sum(1 for v in calls.values() if v>1); c['launches']=1
            k='session' if main else (r or 'other')
            sid=os.path.basename(f)[:-6] if main else os.path.basename(os.path.dirname(os.path.dirname(f)))
            tot['EVERY']['usd']+=cost; tot['EVERY'][('s',sid)]=1
            if only and not any(sid.startswith(o) for o in only): continue
            rows.append({'file':os.path.basename(f),'session':(os.path.basename(f)[:-6] if main else os.path.basename(os.path.dirname(os.path.dirname(f))))[:8],'role':k,'model':model,'first':first,'last':last,'usd':round(cost,2),'ctx':ctx,'label':label,**c})
            for key in (k,'ALL'): tot[key].update(c); tot[key]['usd']+=cost
    return rows,tot
def table(rows,tot):
    hm=lambda t:(t or '')[11:16]; out=[]
    for s in sorted({x['session'] for x in rows},key=lambda s:min(x['first'] for x in rows if x['session']==s)):
        mine=sorted((x for x in rows if x['session']==s),key=lambda x:(x['role']!='session',x['first']))
        out.append(f"session {s}: ${sum(x['usd'] for x in mine):.2f}")
        for x in mine: out.append(f"  {x['role']:<12} {(x['model'] or '')[7:20]:<13} ${x['usd']:>6.2f}  {x['messages']:>3} turns  batched {x['batched']}/{x['tool_turns']}  ctx {x['ctx']//1000}k  {hm(x['first'])}-{hm(x['last'])}  {'' if x['role']=='session' else x['label']}")
    out.append('by role (launches, cost, per launch, batched tool turns):')
    for k,v in sorted(tot.items(),key=lambda kv:-kv[1]['usd']):
        if k not in ('ALL','EVERY'): out.append(f"  {k:<12} {v['launches']:>3}  ${v['usd']:>7.2f}  ${v['usd']/max(1,v['launches']):>6.2f}  {v['batched']}/{v['tool_turns']} ({100*v['batched']//max(1,v['tool_turns'])} %)")
    a=tot['ALL']; out.append(f"total ${a['usd']:.2f} · agents ${a['usd']-tot['session']['usd']:.2f} · sessions ${tot['session']['usd']:.2f} · batched tool turns {a['batched']}/{a['tool_turns']} ({100*a['batched']//max(1,a['tool_turns'])} %)")
    e=tot['EVERY']; every=sum(1 for k in e if isinstance(k,tuple)); mine=len({x['session'] for x in rows})
    if tot['EVERY'].get('only') or mine<every: out[-1]+=f" · {mine} of {every} sessions, all ${e['usd']:.2f}"
    return '\n'.join(out)
if __name__=='__main__':
    a=sys.argv[1:]
    if '--from' not in a: sys.exit('usage: token-usage.py [<dir-or-file>...] --from <iso> [--to <iso>] [--table] [--only <session id prefixes, comma>]  (a release report: --table --only <the release sessions>)')
    lo=a[a.index('--from')+1]; hi=a[a.index('--to')+1] if '--to' in a else '9999'
    only=a[a.index('--only')+1].split(',') if '--only' in a else None
    paths=[x for i,x in enumerate(a) if not x.startswith('--') and (i==0 or a[i-1] not in ('--from','--to','--only'))] or [os.path.expanduser('~/.claude/projects/-Users-iposukhoff-L2Solo')]
    rows,tot=count(paths,lo,hi,only)
    if only: tot['EVERY']['only']=1
    if '--table' in a: print(table(rows,tot))
    else:
        for x in sorted(rows,key=lambda x:x['first']): print(json.dumps(x))
        for k,v in tot.items():
            if k!='EVERY': print(json.dumps({'role':k,**{n:(round(q,2) if n=='usd' else q) for n,q in v.items()}}))
