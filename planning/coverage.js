'use strict';
// Coverage: <trace.jsonl>... --root <tree> [--log <server.log>] [--json]; per run woke/wait take answers/%same;
// near: raise@body, economy_near 1st min, main death, --log spans.
const fs = require('fs'), path = require('path');
const A = process.argv.slice(2), T = [];
let root = '.', json = false;
for (let i = 0; i < A.length; i++) {
    if (A[i] === '--json') json = true;
    else if (A[i] === '--root') root = A[++i];
    else if (A[i] === '--log') T[T.length - 1].log = A[++i];
    else T.push({ file: A[i], name: path.basename(A[i], '.trace.jsonl'), boot: 0, c: {}, ans: {} });
}
const { DECISIONS } = require(path.resolve(root, 'src/GameServer/Bot/Situations.js'));
const MODES = new Set('party,request,formed,joined,dissolved,member meeting,prepared,accepted,refused,cancelled,delivered errand,taken,done,failed raid,search,forming,outcome town,visit'
    .split(' ').flatMap(s => s.split(',').slice(1).map(p => `${s.split(',')[0]} ${p}`)).concat('death'));
const modeOf = r => /^(party|meeting|errand|raid)$/.test(r.kind) ? `${r.kind} ${r.phase}` : r.kind === 'death' ? r.kind
    : r.reason ? `s,${r.name},${r.reason}` : /^arrived_town/.test(r.kind === 'raise' && r.name) ? 'town visit' : r.party || /^(party|member)/.test(r.caller) ? 'party member' : 0;
const get = (m, k, f) => m.get(k) || m.set(k, f()).get(k), list = s => (s || '').split(',').filter(Boolean);
function spans(log, t0, k = 0, m, id, open = new Map(), out = new Map()) {
    const db = new (require('node:sqlite').DatabaseSync)(path.join(path.dirname(log), 'world.sqlite'), { readOnly: true });
    const ids = new Map(db.prepare('SELECT id, name FROM characters').all().map(r => [r.name, r.id]));
    const close = (id, b) => get(out, id, Array).push([open.get(id), b]) && open.delete(id);
    for (const l of fs.readFileSync(log, 'utf8').split('\n')) {
        if (l.includes(':: summary hot')) k++;
        else if ((id = ids.get((m = l.match(/activation for (\S+) reason=near_player|:: cooled (\S+) /)) && (m[1] || m[2])))) {
            if (m[1]) open.has(id) || open.set(id, t0 + k * 30000); else open.has(id) && close(id, t0 + k * 30000 + 30000);
        }
    }
    for (const id of [...open.keys()]) close(id, Infinity);
    return out;
}
for (const t of T) {
    const rows = fs.readFileSync(t.file, 'utf8').split('\n').flatMap(l => { try { const r = JSON.parse(l); return r?.type ? [] : [r]; } catch { return []; } })
        .sort((a, b) => a.at - b.at);
    const t0 = rows[0]?.at || 0, sp = t.log ? spans(t.log, t0) : null, pend = new Map(), wait = new Map(), seen = new Set();
    const always = new Set(rows.filter(r => r.caller === 'economy_near' && r.at - t0 < 60000).map(r => r.bot));
    const add = k => t.c[k] = (t.c[k] || 0) + 1, per = (m, r, d) => get(m, `${r.bot}|${d}`, () => new Set());
    t.records = rows.length; t.place = sp ? 'spans' + sp.size : 'trace';
    for (const r of rows) {
        const P = r.place === 'body' || r.caller === 'economy_near' || r.kind === 'death' && r.thread === 'main' || always.has(r.bot)
            || sp?.get(r.bot)?.some(([a, b]) => r.at >= a && r.at <= b) ? 'near' : 'far';
        const m = modeOf(r); if (m) add(`m|${m}|${P}`), MODES.add(m);
        if (r.kind === 'raise') {
            add(`${r.name}|*|${P}`);
            for (const d of list(r.woke)) { add(`${r.name}|${d}|${P}|w`); per(pend, r, d).add(r.name); }
            for (const d of list(r.waits)) { add(`${r.name}|${d}|${P}|q`); per(wait, r, d).add(r.name); }
        } else if (r.kind === 'stop') for (const d of list(r.woke)) {
            const s = per(wait, r, d);
            for (const x of s.size ? s : ['stop']) per(pend, r, d).add(x);
            s.clear();
        } else if (r.kind === 'decided') {
            const d = r.decision, p = per(pend, r, d), cs = [...p], first = seen.size < seen.add(`${r.bot}|${d}`).size;
            p.clear();
            if (!cs.length && first && r.how !== 'unwoken') { t.boot++; continue; }
            if (!cs.length) { add(`u|${d}|${P}|${r.how}:${r.caller}`); cs.push(`${r.how}:${r.caller}`); }
            for (const s of cs) {
                const k = `${s}|${d}|${P}|`, a = t.ans[k] ||= { set: new Set(), was: 0, kept: 0 };
                add(k + 't'); if (r.answer !== undefined) a.set.add(r.answer);
                if (r.was !== undefined) { a.was++; a.kept += r.was === r.answer; }
            }
        }
    }
}
const n = (t, k) => t.c[k] || 0, sum = k => T.reduce((x, t) => x + n(t, k), 0), cells = [], empty = { far: [], near: [] };
const spread = a => !a ? '-' : `${a.set.size || 'n/t'}${a.was ? `/${Math.round(100 * a.kept / a.was)}%` : ''}`;
for (const [d, sits] of Object.entries(DECISIONS)) for (const s of sits) for (const P of ['far', 'near']) {
    const k = `${s}|${d}|${P}|`, w = sum(k + 'w') + sum(k + 'q'), raised = sum(`${s}|*|${P}`);
    cells.push({ decision: d, situation: s, place: P, runs: T.map(t => [n(t, k + 'w'), n(t, k + 'q'), n(t, k + 't'), spread(t.ans[k])]) });
    if (!sum(k + 't')) empty[P].push(`${d}<${s}${w ? ` (woke/wait ${w})` : raised ? ` (raised ${raised}, woke none)` : ''}`);
}
const unwoken = [...new Set(T.flatMap(t => Object.keys(t.c).filter(k => k.startsWith('u|'))))].sort().map(k => [k.slice(2), T.map(t => n(t, k))]);
const modes = [...MODES].map(m => [m, T.map(t => `${n(t, `m|${m}|far`)}/${n(t, `m|${m}|near`)}`)]);
const names = T.map(t => t.name).join(' | ');
if (json) return console.log(JSON.stringify({ traces: T.map(({ c, ans, file, log, ...t }) => t), cells, unwoken, modes, empty }));
console.log([`traces: ${T.map(t => `${t.name} ${t.records} rec boot ${t.boot} ${t.place}`).join('; ')}`,
    `decision|situation|place|${T.map(t => `${t.name} woke/wait take spread`).join('|')}`,
    ...cells.map(x => `${x.decision}|${x.situation}|${x.place}|${x.runs.map(r => `${r[0]}/${r[1]} ${r[2]} ${r[3]}`).join('|')}`),
    `uncaused (decision|place|how:caller): ${names}`, ...unwoken.map(([k, v]) => `  ${k}: ${v.join(' | ')}`),
    `modes far/near: ${names}`, ...modes.map(([m, v]) => `  ${m}: ${v.join(' | ')}`),
    ...['far', 'near'].map(P => `empty (no take) ${P}: ${empty[P].join(', ')}`)].join('\n'));
