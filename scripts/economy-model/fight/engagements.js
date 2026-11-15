'use strict';
// The game's own fight per engagement on held-out cells of a built hunt table:
// the reference a fight formula is measured against. Per cell, the direct hunt
// of the cell (decompose.watchHunt, the lift on: it reproduces the table's cell)
// yields the states a fight started from: the state the round handed to the
// resolver's fight (its vitals, cooldowns, potions and bag, after the walk), read
// where every fight reads its encounter key (ColdPveEncounter.key/read), so no
// game code is touched. Each of up to STATES states is replayed SEEDS times
// through the resolver's own resolveFight (a compiled copy that exports it, as
// test_cold_combat_parity.js does) with limits no engagement reaches, so one
// call is one whole engagement: the pull it rolls (k mobs), its time, the damage
// taken before any heal, the bot's actions and skills, potions, death. Beside
// each replay the model under test runs from the same start; today that is the
// mean-path fight of decompose (the baseline a fight formula must beat).
// Offline only.
//   node scripts/economy-model/fight/engagements.js --table <hunt table json> [--catalogue <catalogue json>]
//        [--adm 120] [--close 50] [--refused 30] [--states 50] [--seeds 20] [--out <json>]
require('../../../src/Global');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const Generator = require('../../generate-spot-table');
const HuntTable = require('../hunt-table');
const Lift = require('../hunt-lift');
const Cohort = require('../cohort');
const Weights = require('../weights');
const Decompose = require('./decompose');

const CCPol = invoke('GameServer/Bot/Population/ColdClassPolicy');
const RP = invoke('GameServer/Bot/AI/RestPolicy');
const PveEncounter = require('../../../src/GameServer/Bot/Population/ColdPveEncounter');

const HOURS = 2;
// Limits no single engagement reaches (a fight the bot cannot win ends in its death):
// a replay that stops on them is counted as cut, not read as an engagement.
const LIMIT_MS = 3_600_000;
const LIMIT_ACTIONS = 20_000;
// Below this share of the bot's max HP a cell's damage per engagement is judged on maxHp.
const SMALL_DAMAGE = 0.02;
const F = Object.fromEntries(HuntTable.FIELDS.map((name, i) => [name, i]));

// resolveFight is module-private: compile a second copy that exports it.
function loadWith(file, extra) {
    const full = path.join(__dirname, '../../../src', file);
    const copy = new Module(full, module);
    copy.filename = full;
    copy.paths = Module._nodeModulePaths(path.dirname(full));
    copy._compile(fs.readFileSync(full, 'utf8') + extra, full);
    return copy.exports;
}
let resolveFight = null;
const fightCopy = () => resolveFight ||= loadWith('GameServer/Bot/Population/BackgroundResolver.js',
    '\nmodule.exports.__resolveFight = resolveFight;').__resolveFight;

// FNV-1a and mulberry32, as the spot table generator seeds its hunts (its own are not exported).
function fnv(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The formula's held-out half (our choice of hash): even levels at spots whose
// FNV-1a hash of the id is odd. Train: odd levels at even-hash spots.
const heldOut = (level, spotId) => level % 2 === 0 && fnv(String(spotId)) % 2 === 1;
// Admitted as the model reads the table (kills >= 10/h, deaths <= 0.05/kill); close:
// not admitted, yet a bot that dies now and then rather than every fight.
function kindOf(cell) {
    if (cell[F.kills] >= 10 && cell[F.deaths] <= 0.05) return 'admitted';
    if (cell[F.deaths] > 0.005 && cell[F.deaths] < 1) return 'close';
    return 'refused';
}

// A line of the fresh world that hunts with the table's key at a level (lines
// sharing a key share its class and creation kit: hunt-table keysAt).
function lineFor(key, level, classId) {
    const lines = Cohort.freshLines(Object.keys(Weights.CLASS_WEIGHTS), line => Generator.classFor(line, 1)).sort((a, b) => Number(a) - Number(b));
    const line = lines.find(one => String(Generator.botFor(one, level)) === String(key));
    if (line == null || Generator.classFor(line, level) !== classId) throw new Error(`engagements: no fresh line with key ${key} and class ${classId} at L${level}`);
    return line;
}

// The held-out cells, stratified: per kind, strata (key, level, form) taken in
// turn over the keys, from each its cell of lowest hash, until n.
function sampleCells(table, counts) {
    const strata = { admitted: new Map(), close: new Map(), refused: new Map() };
    for (const [body, spots] of Object.entries(table.cells)) {
        const [key, level] = body.split('|').map(Number), classId = table.bodies[body].classId;
        if (level % 2 !== 0) continue;
        for (const [spotId, species] of Object.entries(spots)) {
            if (!heldOut(level, spotId)) continue;
            for (const [selfId, forms] of Object.entries(species)) {
                forms.forEach((cell, form) => {
                    if (!cell) return;
                    const kind = kindOf(cell), k = `${key}|${level}|${spotId}|${selfId}|${form}`;
                    const stratum = `${key}|${level}|${form}`, held = strata[kind].get(stratum) || [];
                    held.push({ k, key, level, spotId, selfId: Number(selfId), form, classId, kind, cell, h: fnv(k) });
                    strata[kind].set(stratum, held);
                });
            }
        }
    }
    const out = [];
    for (const [kind, n] of Object.entries(counts)) {
        const byKey = new Map();
        for (const [stratum, cells] of strata[kind]) {
            const key = stratum.split('|')[0];
            cells.sort((a, b) => a.h - b.h);
            (byKey.get(key) || byKey.set(key, []).get(key)).push({ h: fnv(stratum), cells });
        }
        const queues = [...byKey.keys()].sort((a, b) => Number(a) - Number(b)).map(key => byKey.get(key).sort((a, b) => a.h - b.h));
        const taken = [];
        for (let round = 0; taken.length < n && queues.some(q => q.length); round++) {
            for (const q of queues) {
                if (taken.length >= n) break;
                const stratum = q.find(s => s.cells.length);
                if (!stratum) continue;
                taken.push(stratum.cells.shift());
                q.push(q.splice(q.indexOf(stratum), 1)[0]);
            }
        }
        out.push(...taken);
    }
    return out;
}

// The direct hunt of a cell, collecting the state each fight started from: the
// last encounter read before a fight's first bot action (a continued fight's
// read finds its pending encounter and is not a start).
function huntStarts(c, spotProfile) {
    const spot = Decompose.speciesSpot(spotProfile, c.selfId), line = lineFor(c.key, c.level, c.classId);
    const real = { key: PveEncounter.key, read: PveEncounter.read, select: CCPol.select };
    const starts = [];
    let candidate = null;
    PveEncounter.key = (members, at, partyId) => {
        const key = real.key(members, at, partyId);
        candidate = members.length === 1 && !partyId ? { state: members[0], spot: at, timestamp: null, pending: false } : null;
        return key;
    };
    PveEncounter.read = (record, key, timestamp, options) => {
        const pending = real.read(record, key, timestamp, options);
        if (candidate && candidate.timestamp === null) Object.assign(candidate, { timestamp, pending: !!pending });
        return pending;
    };
    CCPol.select = (profile, context) => {
        if (candidate && !context?.prepare) {
            if (!candidate.pending && candidate.timestamp !== null) {
                starts.push({ state: structuredClone(candidate.state), spot: candidate.spot, timestamp: candidate.timestamp });
            }
            candidate = null;
        }
        return real.select(profile, context);
    };
    try {
        const watched = Decompose.watchHunt({ spot, line, level: c.level, form: c.form, hours: HOURS, classId: c.classId,
            kit: Decompose.creationKit(c.classId) });
        return { line, watched, starts };
    } finally {
        Object.assign(PveEncounter, { key: real.key, read: real.read });
        CCPol.select = real.select;
    }
}

// Up to n of the hunt's starts, evenly over the hunt.
function spread(starts, n) {
    if (starts.length <= n) return starts;
    const step = starts.length / n;
    return Array.from({ length: n }, (_, i) => starts[Math.floor(i * step + step / 2)]);
}

// The model under test at one start state: today the mean-path fight
// (decompose.meanPathFight) on the readiness's usual view, its cooldowns fresh.
function baseline(seen, start) {
    const p = seen.profiles?.find(q => q.servitor !== true);
    if (!p || !seen.view || !seen.fp) return null;
    const out = Decompose.meanPathFight(p, seen.view, seen.fp, start.hp, start.mp);
    const k = Math.max(1, Number(seen.view.pull) || 1);
    return out.fight == null ? { cut: true } : { msPerKill: out.fight * 1000, taken: out.taken, square: out.takenSquare,
        actionsPerKill: out.actionsPerKill, castsPerKill: out.castsPerKill, k };
}

function measureCell(c, spotProfile, { states, seeds }) {
    const started = Date.now();
    const { line, watched, starts } = huntStarts(c, spotProfile);
    const asIs = Decompose.summarize(watched, HOURS), seen = asIs.seen;
    const owner = seen.profiles?.find(q => q.servitor !== true);
    const picked = spread(starts, states);
    const fight = fightCopy(), random = Math.random, select = CCPol.select;
    const replays = [], plain = [];
    let avoided = 0, cut = 0, longestMs = 0, botActions = 0;
    // The bot's own actions (the fight's action count holds the mob's too): one class-policy pick each.
    CCPol.select = (profile, context) => {
        if (!context?.prepare) botActions += 1;
        return select(profile, context);
    };
    try {
        picked.forEach((s, si) => {
            const cooldowns = s.state.stats?.coldCombat?.cooldowns || {};
            plain.push({ hp: Number(s.state.vitals?.hp), mp: Number(s.state.vitals?.mp),
                cooldowns: Object.fromEntries(Object.entries(cooldowns).map(([id, at]) => [id, Math.max(0, Number(at) - s.timestamp)]).filter(([, left]) => left > 0)) });
            for (let seed = 0; seed < seeds; seed++) {
                const roll = fnv(`${c.k}|${si}|${seed}`);
                Math.random = seeded(roll ^ 0x9e3779b9);
                const t0 = process.hrtime.bigint();
                botActions = 0;
                const r = fight({ state: structuredClone(s.state), spot: s.spot, targetNpcId: 0, rng: seeded(roll), timestamp: s.timestamp,
                    fightLimitMs: LIMIT_MS, maxActions: LIMIT_ACTIONS });
                longestMs = Math.max(longestMs, Number(process.hrtime.bigint() - t0) / 1e6);
                if (r.avoided) { avoided += 1; continue; }
                if (!r.won && !r.died) { cut += 1; continue; }
                const d = r.debug || {};
                // The round's clock: a kill costs at least its killing action (resolveSolo foughtMs).
                replays.push([si, Number(d.pullMobs) || 1, Math.max(Number(d.durationMs) || 0, Number(d.killMs) || 0), Number(d.damageTaken) || 0,
                    botActions, Number(d.skillUses) || 0, Number(d.potionsUsed) || 0, r.died ? 1 : 0]);
            }
        });
    } finally { Math.random = random; CCPol.select = select; }
    const v0 = plain.map(start => baseline(seen, start));
    return { k: c.k, key: c.key, level: c.level, spotId: c.spotId, selfId: c.selfId, form: c.form, line, classId: c.classId, kind: c.kind,
        cell: c.cell, huntCell: asIs.cell, same: asIs.cell.every((v, i) => v === c.cell[i]), maxHp: owner?.maxHp ?? null, maxMp: owner?.maxMp ?? null,
        starts: starts.length, states: plain, replays, avoided, cut, longestReplayMs: longestMs,
        R: reference(replays), v0: alongside(replays, v0), ms: Date.now() - started };
}

// The game's fight per cell: time per kill over all kills, damage per engagement and its second moment.
function reference(replays) {
    if (!replays.length) return null;
    const sum = i => replays.reduce((a, r) => a + r[i], 0), kills = sum(1), n = replays.length;
    return { n, k: kills / n, msPerKill: sum(2) / kills, taken: sum(3) / n, square: replays.reduce((a, r) => a + r[3] ** 2, 0) / n,
        actionsPerKill: sum(4) / kills, castsPerKill: sum(5) / kills, potions: sum(6) / n, died: sum(7) / n };
}
// A model's per-start answers weighted as the replays that ran from each start.
function alongside(replays, perStart) {
    const ran = replays.map(r => perStart[r[0]]).filter(Boolean), done = ran.filter(m => !m.cut);
    if (!done.length) return { n: 0, cut: ran.length };
    const avg = name => done.reduce((a, m) => a + m[name], 0) / done.length;
    return { n: done.length, cut: ran.length - done.length, k: avg('k'), msPerKill: avg('msPerKill'), taken: avg('taken'), square: avg('square'),
        actionsPerKill: avg('actionsPerKill'), castsPerKill: avg('castsPerKill') };
}

const pct = (values, p) => { const s = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const rel = (m, r) => m != null && r > 0 ? Math.abs(m - r) / r : null;

// B1-B4 of a model against the reference, per kind.
function bounds(cells, model) {
    const out = {};
    for (const kind of ['admitted', 'close', 'refused']) {
        const g = cells.filter(c => c.kind === kind && c.R && c[model]?.n > 0);
        if (!g.length) { out[kind] = { cells: 0 }; continue; }
        const b1 = g.map(c => rel(c[model].msPerKill, c.R.msPerKill));
        const big = g.filter(c => c.R.taken >= SMALL_DAMAGE * c.maxHp), small = g.filter(c => c.R.taken < SMALL_DAMAGE * c.maxHp);
        const b2 = big.map(c => rel(c[model].taken, c.R.taken));
        const ratio = g.filter(c => c.R.square > 0 && c[model].square > 0).map(c => c[model].square / c.R.square);
        out[kind] = { cells: g.length, b1: { p50: pct(b1, 0.5), p90: pct(b1, 0.9) },
            b2: { cells: big.length, p50: pct(b2, 0.5), p90: pct(b2, 0.9), small: small.length,
                smallWithin: small.filter(c => Math.abs(c[model].taken - c.R.taken) / c.maxHp <= 0.01).length },
            b3: { cells: ratio.length, p50: pct(ratio, 0.5), p10: pct(ratio, 0.1), p90: pct(ratio, 0.9), absLnP90: pct(ratio.map(r => Math.abs(Math.log(r))), 0.9) },
            b4: { actions: pct(g.map(c => c[model].actionsPerKill / c.R.actionsPerKill), 0.5), castsP50: pct(g.map(c => c.R.castsPerKill > 0 ? c[model].castsPerKill / c.R.castsPerKill : null), 0.5) },
            cutCells: cells.filter(c => c.kind === kind && c[model]?.cut > 0).length };
    }
    return out;
}

function report(result) {
    const f = v => v == null ? '-' : Number(v).toFixed(3);
    const cells = result.cells;
    console.log(`table ${result.tableStamp}, tree stamp ${result.treeStamp}; cells ${cells.length}, hunt equal to the table cell ${cells.filter(c => c.same).length}`);
    console.log(`engagements ${cells.reduce((a, c) => a + c.replays.length, 0)}, avoided replays ${cells.reduce((a, c) => a + c.avoided, 0)}, cut replays ${cells.reduce((a, c) => a + c.cut, 0)}, longest replay ${f(Math.max(0, ...cells.map(c => c.longestReplayMs)))} ms, run ${f(result.ms / 1000)} s`);
    for (const [model, b] of Object.entries(result.bounds)) {
        for (const [kind, s] of Object.entries(b)) {
            if (!s.cells) { console.log(`${model} ${kind}: no cells`); continue; }
            console.log(`${model} ${kind} cells ${s.cells}: B1 time/kill p50 ${f(s.b1.p50)} p90 ${f(s.b1.p90)}; B2 damage/eng (${s.b2.cells} cells) p50 ${f(s.b2.p50)} p90 ${f(s.b2.p90)}, small ${s.b2.smallWithin}/${s.b2.small} within 0.01 maxHp; `
                + `B3 E[D^2] ratio (${s.b3.cells}) p10 ${f(s.b3.p10)} p50 ${f(s.b3.p50)} p90 ${f(s.b3.p90)} |ln| p90 ${f(s.b3.absLnP90)}; B4 actions ratio p50 ${f(s.b4.actions)} casts ${f(s.b4.castsP50)}; cells with cut paths ${s.cutCells}`);
        }
    }
    for (const c of cells) {
        const m = c.v0 || {}, r = c.R || {};
        console.log(`  ${c.k} ${c.kind} L${c.line} same ${c.same} starts ${c.starts} eng ${c.replays.length} k ${f(r.k)}/${f(m.k)} ms/kill ${f(r.msPerKill)}/${f(m.msPerKill)} dmg ${f(r.taken)}/${f(m.taken)} `
            + `E[D2] ${f(r.square)}/${f(m.square)} act/kill ${f(r.actionsPerKill)}/${f(m.actionsPerKill)} cast/kill ${f(r.castsPerKill)}/${f(m.castsPerKill)} pot ${f(r.potions)} died ${f(r.died)} cut ${m.cut ?? '-'}`);
    }
}

function main(argv) {
    const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
    const tableFile = arg('table');
    if (!tableFile) throw new Error('engagements: --table <hunt table json> is required');
    const started = Date.now();
    let catalogue = arg('catalogue'), dir = null;
    if (!catalogue) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engagements-'));
        catalogue = path.join(dir, 'catalogue.json');
        const built = Generator.buildCatalogue();
        fs.writeFileSync(catalogue, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
    }
    try {
        Generator.loadSimulation(catalogue);
        const profiles = new Map(JSON.parse(fs.readFileSync(catalogue, 'utf8')).profiles.map(spot => [String(spot.id), spot]));
        const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
        const counts = { admitted: Number(arg('adm') || 120), close: Number(arg('close') || 50), refused: Number(arg('refused') || 30) };
        const options = { states: Number(arg('states') || 50), seeds: Number(arg('seeds') || 20) };
        const cells = [];
        Lift.lift(true);
        try {
            for (const c of sampleCells(table, counts)) {
                const spot = profiles.get(String(c.spotId));
                if (!spot) throw new Error(`engagements: no spot ${c.spotId} in the catalogue`);
                cells.push(measureCell(c, spot, options));
            }
        } finally { Lift.lift(false); }
        const result = { tableStamp: table.stamp, treeStamp: HuntTable.stamp(), counts, options, cells, bounds: { v0: bounds(cells, 'v0') }, ms: Date.now() - started };
        if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(result));
        report(result);
        return result;
    } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { heldOut, kindOf, sampleCells, huntStarts, measureCell, reference, bounds, main };
if (require.main === module) main(process.argv.slice(2));
