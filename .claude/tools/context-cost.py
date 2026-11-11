# Read-only: how much planning/policy text agents actually pull into context, from harness transcripts.
import json, os, re, sys, collections, glob
root = os.path.expanduser('~/.claude/projects/-Users-iposukhoff-L2Solo')
KEYS = [('roadmap', r'planning/roadmap\.md'), ('problems', r'architecture/problems\.md'), ('findings', r'findings-1a\.md'),
        ('maps', r'planning/architecture/(?!problems)[\w-]+\.md'), ('target', r'target-architecture/[\w-]+\.(md|json)'),
        ('workflow', r'\.claude/workflow/[\w-]+\.md'), ('claude', r'L2Solo/CLAUDE\.md|(?<![\w/])CLAUDE\.md'), ('rclog', r'release-1a-pilot\.md|handoff-1a\.md')]
def keys_of(text):
    return [k for k, rx in KEYS if re.search(rx, text)]
tot = collections.defaultdict(lambda: [0, 0])          # key -> [reads, chars]
per = collections.defaultdict(lambda: collections.Counter())  # transcript -> key reads
chars_per = collections.defaultdict(lambda: collections.Counter())
kind = {}
files = glob.glob(root + '/*.jsonl') + glob.glob(root + '/*/subagents/*.jsonl') + glob.glob(root + '/*/*/*.jsonl')
files = sorted(set(files))
for f in files:
    k = 'sub' if '/subagents/' in f else 'main'
    pending = {}
    try:
        for line in open(f, errors='ignore'):
            if '"tool_use"' not in line and '"tool_result"' not in line: continue
            try: m = json.loads(line)
            except Exception: continue
            c = (m.get('message') or {}).get('content')
            if not isinstance(c, list): continue
            for b in c:
                if b.get('type') == 'tool_use':
                    inp = b.get('input') or {}
                    t = (inp.get('file_path') or '') + ' ' + (inp.get('command') or '') if b.get('name') in ('Read', 'Bash') else ''
                    if b.get('name') == 'Bash' and not re.search(r'\b(cat|sed|head|tail|grep|awk|less|python3|node -e)\b', t): t = ''
                    ks = keys_of(t)
                    if ks: pending[b['id']] = ks
                elif b.get('type') == 'tool_result' and b.get('tool_use_id') in pending:
                    ks = pending.pop(b['tool_use_id']); cc = b.get('content')
                    n = len(cc) if isinstance(cc, str) else sum(len(x.get('text', '')) for x in (cc or []) if isinstance(x, dict))
                    key = '+'.join(ks) if len(ks) > 1 else ks[0]
                    tot[key][0] += 1; tot[key][1] += n; per[f][key] += 1; chars_per[f][key] += n; kind[f] = k
    except Exception as e:
        print('skip', f, e, file=sys.stderr)
print('transcripts scanned', len(files), 'with planning/policy reads', len(per))
print('%-28s %6s %9s %8s' % ('file(s)', 'reads', 'chars', '~tokens'))
for key, (r, n) in sorted(tot.items(), key=lambda x: -x[1][1])[:16]:
    print('%-28s %6d %9d %8d' % (key[:28], r, n, n / 3.5))
allc = sum(n for r, n in tot.values()); print('total chars', allc, '~tokens', int(allc / 3.5))
for k in ('main', 'sub'):
    fs = [f for f in per if kind[f] == k]
    if not fs: continue
    c = sum(sum(chars_per[f].values()) for f in fs); r = sum(sum(per[f].values()) for f in fs)
    rep = sum(sum(v - 1 for v in per[f].values() if v > 1) for f in fs)
    print(f'{k}: transcripts {len(fs)}, reads {r}, repeated reads (same file again in one transcript) {rep}, ~tokens {int(c/3.5)}, per transcript ~{int(c/3.5/len(fs))}')
# problems.md specifically: full reads vs partial
big = collections.Counter(); 
print('top transcripts by planning tokens:')
for f in sorted(per, key=lambda f: -sum(chars_per[f].values()))[:5]:
    print(' ', kind[f], os.path.basename(f)[:40], int(sum(chars_per[f].values()) / 3.5), dict(per[f].most_common(4)))
