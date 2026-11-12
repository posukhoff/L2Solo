#!/usr/bin/env python3
# Boundary checks for token-token-usage.py on synthetic transcripts.
import json,os,sys,tempfile,importlib.util
spec=importlib.util.spec_from_file_location('u',os.path.join(os.path.dirname(os.path.abspath(__file__)),'token-usage.py')); u=importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
d=tempfile.mkdtemp()
def msg(t,i,o): return json.dumps({'type':'assistant','timestamp':t,'message':{'id':i,'model':'m','usage':{'input_tokens':1,'cache_creation_input_tokens':0,'cache_read_input_tokens':0,'output_tokens':o}}})
open(os.path.join(d,'a.output'),'w').write('\n'.join([
 json.dumps({'type':'user','timestamp':'2026-01-01T00:00:00Z','message':{'role':'user','content':'You are an implementer'}}),
 msg('2026-01-01T00:59:59Z','m0',1),   # before the window: excluded although the file is read
 msg('2026-01-01T01:00:00Z','m1',10),  # at the lower bound: included
 msg('2026-01-01T01:00:00Z','m1',10),  # same id repeated (one line per content block): counted once
 msg('2026-01-01T01:30:00Z','m2',100),
 msg('2026-01-01T02:00:00Z','m3',1000),# at the upper bound: excluded
 '{broken json', '7']))
open(os.path.join(d,'b.output'),'w').write('\n'.join([msg('2026-01-01T01:10:00Z','m2',100), msg('2026-01-01T01:20:00Z','m4',10000)]))  # m2 again in another file
rows,tot=u.count([d],'2026-01-01T01:00:00Z','2026-01-01T02:00:00Z')
assert tot['ALL']['output']==10+100+10000, tot['ALL']; assert tot['ALL']['messages']==3, tot['ALL']
assert tot['implementer']['output']==110, tot
assert u.role('You are the read-only PLANNER for one fix; a reviewer reads your plan')=='planner'  # the first prompt names its own role first
assert u.role('You are the IMPLEMENTER for one planned fix; follow the planner\'s plan')=='implementer'
assert u.role('You are the independent REVIEWER: the planner proved the chain, the implementer changed it')=='reviewer'
# a transcript that began before the window still counts its messages inside it; one starting inside but running past is cut
rows,tot=u.count([d],'2026-01-01T01:15:00Z','2026-01-01T01:45:00Z')
assert tot['ALL']['output']==10100, tot['ALL']
# money: the model's price per token kind (1 h cache writes cost twice the input); batched: tool turns with more than one call
d2=tempfile.mkdtemp(); os.makedirs(os.path.join(d2,'s1','subagents'))
def turn(i,model,usage,calls): return [json.dumps({'type':'assistant','timestamp':'2026-01-01T01:00:00Z','message':{'id':i,'model':model,'usage':usage,'content':[{'type':'tool_use','name':'Read'}]}}) for _ in range(calls)]
open(os.path.join(d2,'s1','subagents','agent-a.jsonl'),'w').write('\n'.join([json.dumps({'type':'user','timestamp':'2026-01-01T00:59:00Z','message':{'role':'user','content':[{'type':'text','text':'reviewer dt1, review 1'}]}})]
 +turn('a1','claude-sonnet-5-5',{'input_tokens':1000000,'output_tokens':0,'cache_read_input_tokens':0,'cache_creation_input_tokens':0},2)
 +turn('a2','claude-sonnet-5-5',{'input_tokens':0,'output_tokens':100000,'cache_read_input_tokens':1000000,'cache_creation_input_tokens':1000000,'cache_creation':{'ephemeral_1h_input_tokens':1000000}},1)))
open(os.path.join(d2,'s1.jsonl'),'w').write('\n'.join(turn('m1','claude-opus-5-5',{'input_tokens':1000000,'output_tokens':0,'cache_read_input_tokens':0,'cache_creation_input_tokens':0},1)))
rows,tot=u.count([d2],'2026-01-01T00:00:00Z')
r=next(x for x in rows if x['role']=='reviewer'); assert abs(r['usd']-(2+1+0.1+4))<1e-9, r; assert (r['tool_turns'],r['batched'],r['session'])==(2,1,'s1'), r
assert tot['session']['usd']==4 and abs(tot['ALL']['usd']-11.1)<1e-9, tot
assert u.table(rows,tot).splitlines()[-1]=='total $11.10 · agents $7.10 · sessions $4.00 · batched tool turns 1/3 (33 %)', u.table(rows,tot)
os.makedirs(os.path.join(d2,'s2')); open(os.path.join(d2,'s2.jsonl'),'w').write('\n'.join(turn('n1','claude-opus-5-5',{'input_tokens':1000000,'output_tokens':0,'cache_read_input_tokens':0,'cache_creation_input_tokens':0},1)))
rows,tot=u.count([d2],'2026-01-01T00:00:00Z',only=['s1'])  # one track's sessions: the other session is named in the total line, not counted
assert u.table(rows,tot).splitlines()[-1]=='total $11.10 · agents $7.10 · sessions $4.00 · batched tool turns 1/3 (33 %) · 1 of 2 sessions, all $15.10', u.table(rows,tot)
print('PASS token-usage: per-message window, [from,to) bounds, one count per message id across files, bad lines skipped; price per model and batched turns')
