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
# a transcript that began before the window still counts its messages inside it; one starting inside but running past is cut
rows,tot=u.count([d],'2026-01-01T01:15:00Z','2026-01-01T01:45:00Z')
assert tot['ALL']['output']==10100, tot['ALL']
print('PASS token-usage: per-message window, [from,to) bounds, one count per message id across files, bad lines skipped')
