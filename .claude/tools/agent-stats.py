#!/usr/bin/env python3
"""agent-stats.py [--since <ISO time, default 24 h ago>] [--session <id prefix>] [--list]
Per role: how many agents ran, how many calls and how much context they took, how many the context hook told to put
work on file and how many it stopped (.claude/hooks/agent-context.js), and what they cost, in all and past 200k.
The limit's numbers are decided on this table (2026-11-13). --list adds one line per agent the hook stopped.
A role is the agent's type (l2-planner ...); an untyped launch is placed by the words of its description."""
import glob, json, os, re, sys, collections, statistics as st, datetime as dt
ROOT = os.path.expanduser('~/.claude/projects/-Users-iposukhoff-L2Solo')
PRICE = {'fable': (8, 40), 'opus': (4, 20), 'sonnet': (2, 10), 'haiku': (1, 5)}  # $ per million tokens in, out
ROLES = (('planner', r'plan|cause'), ('reviewer', r'review'), ('implementer', r'implement|fix round|slice'), ('audit', r'audit|gate|read the run|proofread|check'))
def arg(k, d=None): return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
def price(m): return next((v for k, v in PRICE.items() if k in (m or '')), PRICE['opus'])
def role(meta):
    t = meta.get('agentType') or ''
    if t.startswith('l2-'): return t[3:]
    if 'fork' in t.lower(): return 'fork'
    return next((k for k, pat in ROLES if re.search(pat, (meta.get('description') or '').lower())), 'other')
def main():
    since = arg('--since', (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M'))
    rows = []
    for f in glob.glob(f"{ROOT}/{arg('--session', '')}*/subagents/agent-*.jsonl"):
        try: meta = json.load(open(f[:-6] + '.meta.json'))
        except Exception: meta = {}
        turns, start, noted, stopped = {}, None, 0, False
        for line in open(f, errors='replace'):
            try: j = json.loads(line)
            except Exception: continue
            start = start or j.get('timestamp'); m = j.get('message') or {}
            if j.get('type') == 'assistant' and m.get('usage'): turns[m.get('id')] = (m['usage'], m.get('model'))
            elif j.get('type') == 'user' and isinstance(m.get('content'), list):
                for c in m['content']:
                    if c.get('type') != 'tool_result': continue
                    s = c.get('content'); s = s if isinstance(s, str) else ''.join(x.get('text', '') for x in (s or []) if isinstance(x, dict))
                    noted += 'of your work is on no file' in s
                    stopped = stopped or 'This call was refused once. Decide now' in s or 'every further turn costs about twice' in s
        if not turns or (start or '') < since: continue
        cost = past = peak = 0
        for u, model in turns.values():
            pi, po = price(model); ctx = (u.get('input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)
            c = ((u.get('input_tokens') or 0) * pi + (u.get('cache_read_input_tokens') or 0) * pi * .1 + (u.get('cache_creation_input_tokens') or 0) * pi * 1.25 + (u.get('output_tokens') or 0) * po) / 1e6
            cost += c; past += c if ctx >= 200000 else 0; peak = max(peak, ctx)
        rows.append(dict(role=role(meta), calls=len(turns), peak=peak, cost=cost, past=past, noted=noted, stopped=stopped, start=start, desc=meta.get('description') or '', sess=f.split('/')[-3][:8]))
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
    print(f"agents since {since}: {len(rows)} · ${sum(r['cost'] for r in rows):.0f} · stopped by the context limit {sum(r['stopped'] for r in rows)}")
    print(f"{'role':12}{'n':>4}{'calls med':>10}{'p90':>5}{'ctx med':>9}{'p90':>6}{'told to write':>15}{'stopped':>9}{'$':>7}{'$/agent':>9}{'$ past 200k':>13}")
    by = collections.defaultdict(list)
    for r in rows: by[r['role']].append(r)
    for k, v in sorted(by.items(), key=lambda x: -sum(r['cost'] for r in x[1])):
        c = [r['calls'] for r in v]; p = [r['peak'] // 1000 for r in v]; cost = sum(r['cost'] for r in v)
        print(f"{k:12}{len(v):>4}{st.median(c):>10.0f}{q(c, .9):>5}{st.median(p):>8.0f}k{q(p, .9):>5}k{sum(r['noted'] > 0 for r in v):>15}{sum(r['stopped'] for r in v):>9}{cost:>7.0f}{cost / len(v):>9.1f}{sum(r['past'] for r in v):>13.0f}")
    if '--list' in sys.argv:
        for r in sorted(rows, key=lambda r: r['start']):
            if r['stopped']: print(f"stopped {r['start'][5:16]} {r['sess']} {r['role']:11} {r['calls']:>3} calls {r['peak'] // 1000}k ${r['cost']:.1f} | {r['desc'][:80]}")
if __name__ == '__main__': main()
