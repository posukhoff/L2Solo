// T106: a safe cold solo fight on a fresh mob is a formula kill
// (ColdHuntFormula) and must match the real stepped fight on average: its
// length, the damage the bot takes, the MP and shots it spends. Risky
// fights still run for real.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Formula = invoke('GameServer/Bot/Population/ColdHuntFormula');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const HuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');

const full = path.join(__dirname, '../src/GameServer/Bot/Population/BackgroundResolver.js');
const copy = new Module(full, module);
copy.filename = full;
copy.paths = Module._nodeModulePaths(path.dirname(full));
copy._compile(fs.readFileSync(full, 'utf8') + '\nmodule.exports.__resolveFight = resolveFight;', full);
const resolveFight = copy.exports.__resolveFight;

// The edge: shots are measured loaded, as the tables measure them.
ShotStock.usePolicy = () => ({ usePerHour: 1 });
const TS = 1_791_060_000_000;
function seeded(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
function bot(classId, level, shots) {
    const state = HuntCycle.referenceState(classId, level);
    if (shots) {
        const plan = ShotStock.planForState(state);
        state.inventory[String(plan.selfId)] = { selfId: Number(plan.selfId), amount: 1e6 };
    }
    const profile = ColdCombatProfile.profileFor(state, TS);
    state.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
    state.loc = { locX: 0, locY: 0, locZ: 0 };
    return state;
}
// A lone melee mob some levels below the bot that its gate admits.
function mobFor(level) {
    return DataCache.npcs.find(npc => Number(npc.template?.level) === level && HuntingTargetPolicy.canHunt(npc)
        && ColdCombatProfile.npcCombatStats(npc).pAtk > 0 && !npc.template?.clan);
}
function fights(state, npc, enabled, n) {
    Formula.enabled = enabled;
    const spot = { id: `formula-${npc.selfId}`, avgLevel: npc.template.level, npcEntries: [{ selfId: npc.selfId, count: 1 }],
        rewards: { exp: 0, sp: 0, adenaMin: 0, adenaMax: 0 } };
    const sum = { ms: 0, taken: 0, mp: 0, shots: 0, won: 0, formula: 0, n: 0 };
    for (let i = 0; i < n; i++) {
        const before = state.vitals.mp;
        const random = Math.random;
        Math.random = seeded(9000 + i);
        try {
            const r = resolveFight({ state, spot, pressure: {}, targetNpcId: npc.selfId, rng: seeded(i + 1), timestamp: TS,
                fightLimitMs: 60000, maxActions: 400 });
            if (r.avoided) continue;
            sum.n += 1;
            sum.ms += r.debug.durationMs;
            sum.taken += r.debug.damageTaken;
            sum.mp += before - r.mp;
            sum.shots += r.debug.shotActions;
            sum.won += r.won ? 1 : 0;
            sum.formula += r.debug.formula ? 1 : 0;
        } finally {
            Math.random = random;
        }
    }
    Formula.enabled = true;
    return sum;
}
const near = (a, b, tolerance, what) => assert(Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b), 1e-9),
    `${what}: formula ${a.toFixed(1)} vs real ${b.toFixed(1)}`);

const N = 120;
for (const [name, classId, level, gap, shots] of [['Gladiator', 2, 50, 6, true], ['Sorcerer', 12, 56, 6, true],
    ['Hawkeye', 9, 56, 6, false], ['Paladin', 5, 62, 4, true], ['Warrior', 1, 30, 4, false]]) {
    const npc = mobFor(level - gap);
    assert(npc, `${name}: a mob of level ${level - gap}`);
    const state = bot(classId, level, shots);
    const formula = fights(state, npc, true, N), real = fights(state, npc, false, N);
    assert(formula.n >= N * 0.9 && real.n >= N * 0.9, `${name}: the fights run (${formula.n}, ${real.n})`);
    assert(formula.formula >= formula.n * 0.8, `${name}: a safe fight is a formula kill (${formula.formula}/${formula.n})`);
    assert.strictEqual(real.formula, 0, `${name}: off, every fight is stepped`);
    const per = (s, key) => s[key] / s.n;
    console.log(name, npc.template.name, ["ms","taken","mp","shots"].map(k => `${k} ${per(formula,k).toFixed(1)}/${per(real,k).toFixed(1)}`).join(" "), formula.formula + "/" + formula.n);
    near(per(formula, 'ms'), per(real, 'ms'), 0.25, `${name} vs ${npc.template.name}: fight ms`);
    near(per(formula, 'taken'), per(real, 'taken'), 0.3, `${name}: damage taken`);
    near(per(formula, 'mp'), per(real, 'mp'), 0.35, `${name}: MP spent`);
    if (shots) near(per(formula, 'shots'), per(real, 'shots'), 0.3, `${name}: shots`);
    assert.strictEqual(formula.won, formula.n, `${name}: a safe fight is won`);
}

// Risky: a bot that would not survive the formula's worst case fights for real.
const frail = bot(2, 50, false);
frail.vitals = { ...frail.vitals, hp: 1 };
const risky = fights(frail, mobFor(44), true, 5);
assert.strictEqual(risky.formula, 0, 'a bot near death fights its mob for real');
// No rotation row: the real fight.
Formula.useTable({ rows: {}, fields: [], bandLevels: 2, openingSeconds: [] });
assert.strictEqual(fights(bot(2, 50, false), mobFor(44), true, 3).formula, 0, 'an unmeasured class fights for real');
Formula.useTable(undefined);

console.log('Cold hunt formula checks passed');
