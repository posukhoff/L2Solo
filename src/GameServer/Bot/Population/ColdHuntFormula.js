'use strict';

// Owner: one cold solo kill by formula (T106). A safe solo fight on an
// ordinary mob is not stepped action by action: its length, the mob's damage,
// the MP and shots it spends come from the class's measured rotation (the hunt
// tables' table 4, data/Bots/hunt/rotation.json) and the bot's own numbers.
// BackgroundResolver.resolveFight asks kill() and keeps everything else of the
// fight (the target pick, potions, soul crystals, rewards); null means the
// fight runs for real (a risky or unmeasured case). The hunt tables' offline
// model (scripts/hunt-tables/HuntModel) reads the same rotation through here.
const fs = require('fs');
const path = require('path');
const Formulas = invoke('GameServer/Formulas');

const ROTATION_FILE = path.join(__dirname, '../../../../data/Bots/hunt/rotation.json');

// A rotation row of table 4 as an object (fields: the table's).
function rotationOf(rotationTable, classId, level) {
    const rows = rotationTable?.rows?.[classId];
    if (!rows) return null;
    const bands = Object.keys(rows).map(Number);
    const want = Math.floor(level / rotationTable.bandLevels);
    const band = bands.reduce((best, b) => Math.abs(b - want) < Math.abs(best - want) ? b : best, bands[0]);
    const rot = Object.fromEntries(rotationTable.fields.map((field, index) => [field, rows[band][index]]));
    rot.openingSeconds = rotationTable.openingSeconds;
    return rot;
}

// A value of the opening curve at t seconds (linear between points; before
// the first the first, after the last the last for a rate, the long-run MP
// rate added for MP).
function openingAt(rot, list, t, rate = null) {
    const times = rot.openingSeconds || [];
    if (!times.length || !list) return null;
    if (t <= times[0]) return rate === null ? list[0] : list[0] * t / times[0];
    for (let i = 1; i < times.length; i++) {
        if (t <= times[i]) {
            const w = (t - times[i - 1]) / (times[i] - times[i - 1]);
            return list[i - 1] + w * (list[i] - list[i - 1]);
        }
    }
    return rate === null ? list.at(-1) : list.at(-1) + rate * (t - times.at(-1));
}

// The rotation's damage rate times defence (dps x def) for a strength:
// physical and magic parts, with MP (the rotation) and without (dry).
function damageTerms(rot, numbers, mobEvasion) {
    const speed = numbers.atkSpd * (1 + numbers.critical / 1000) * Formulas.coldHitChance(numbers.accur, mobEvasion) / 0.98;
    const phys = (rot.A * numbers.pAtk + rot.B) * speed;
    const magic = rot.M * Math.sqrt(Math.max(1, numbers.mAtk)) * numbers.castSpd / 333;
    // A rotation that never ran dry in its measure keeps its MP-phase rate.
    const dry = rot.dryUnit > 0 ? rot.dryUnit * numbers.pAtk * speed : rot.mpPhaseSec >= 180 ? phys : 0;
    return { phys, magic, dry };
}

function normalCdf(x) {
    // Abramowitz-Stegun 7.1.26 on erf.
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
        * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// The mob's melee on the bot (resolveFight: melee only, at its attack
// speed): per attempt hit chance, the hit, its critical share and the
// spread of the sum over a fight of `seconds`. mod: the weapon-kind modifier.
function incoming(mob, profile, seconds, mod = 1) {
    const hitChance = Formulas.coldHitChance(mob.accur, profile.evasion);
    const perHit = 70 * mob.pAtk / Math.max(1, profile.pDef) * mod;
    const crit = Math.min(1, Math.max(0, Number(mob.critical) || 0) / 1000);
    const attempts = 1000 / Math.max(250, Formulas.calcMeleeAtkTime(mob.atkSpd)) * seconds;
    const spread = 1 + Math.pow(Number(mob.pAtkRnd) || 0, 2) / 3 / 10000;
    const meanHit = perHit * (1 + crit), squareHit = perHit * perHit * (1 + 3 * crit) * spread;
    const mean = attempts * hitChance * meanHit;
    const sigma = Math.sqrt(Math.max(0, attempts * (hitChance * squareHit - Math.pow(hitChance * meanHit, 2))));
    return { mean, sigma };
}

// The live rotation table, read once; tests swap it (useTable).
let table;
const rotations = new Map();
function useTable(next) {
    table = next;
    rotations.clear();
}
function rotationFor(classId, level) {
    if (table === undefined) {
        try { table = JSON.parse(fs.readFileSync(ROTATION_FILE, 'utf8')); } catch { table = null; }
    }
    const key = `${classId}|${Math.floor(level / (table?.bandLevels || 2))}`;
    if (!rotations.has(key)) rotations.set(key, table ? rotationOf(table, classId, level) : null);
    return rotations.get(key);
}

// The z of the worst case a formula kill may still take: past it the fight
// runs for real (the bot may die, drink, heal; the steps decide).
const WORST_Z = 3;
let enabled = true;

// One kill by formula, or null when the fight must run for real.
// bot { classId, level, profile (the fight profile), hp, mp, maxMp, shots
// (loaded and paying), opens (a bot that rests for MP at a full bar: its
// opening burst) }, mob: the pull's view (BotPullEstimate.pullView),
// mobHp, fightLimitMs, mod (the mob's weapon modifier on the bot), rng.
// Returns { ms, taken, mp, shotActions, died }.
function kill(bot, mob, { mobHp = mob.maxHp, fightLimitMs, mod = 1, rng = Math.random } = {}) {
    if (!enabled) return null;
    const rot = rotationFor(bot.classId, bot.level);
    if (!rot || !(rot.d1 > 0) || !Number.isFinite(rot.shotsPerSec)) return null;
    const { profile } = bot;
    const terms = damageTerms(rot, profile, mob.evasion);
    const shot = bot.shots ? rot.shotMul : 1;
    // Area skills strike every mob of the pull (resolveFight).
    const area = 1 + (Number(rot.areaShare) || 0) * (Math.max(1, Number(mob.pull) || 1) - 1);
    const wet = (terms.phys / Math.max(1, mob.pDef) + terms.magic / Math.max(1, mob.mDef)) * shot * area;
    const dry = terms.dry / Math.max(1, mob.pDef) * shot;
    let seconds, mp;
    if (wet > 0) {
        seconds = mobHp / wet;
        // A fight from a full bar opens with its burst (three passes).
        if (bot.opens) for (let pass = 0; pass < 3; pass++) {
            const burst = openingAt(rot, rot.openDamage, seconds);
            if (burst > 0) seconds = mobHp / (wet * burst);
        }
        mp = bot.opens ? openingAt(rot, rot.openMp, seconds, rot.mpPerSec) : rot.mpPerSec * seconds;
        if (mp > bot.mp) {
            // The bar runs out: the rest of the mob falls to the dry rate.
            if (!(dry > 0) || !(rot.mpPerSec > 0)) return null;
            const wetSeconds = bot.mp / rot.mpPerSec;
            seconds = wetSeconds + Math.max(0, mobHp - wet * wetSeconds) / dry;
            mp = bot.mp;
        }
    } else {
        if (!(dry > 0)) return null;
        seconds = mobHp / dry;
        mp = 0;
    }
    if (!(seconds > 0) || seconds * 1000 > fightLimitMs) return null;
    const hits = incoming(mob, profile, seconds, mod);
    if (hits.mean + WORST_Z * hits.sigma >= bot.hp) return null;
    // A normal deviate of the fight's damage (Box-Muller on the fight's rng).
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
    const taken = Math.max(0, hits.mean + z * hits.sigma);
    const actions = bot.shots ? rot.shotsPerSec * seconds : 0;
    const shotActions = Math.floor(actions) + (rng() < actions % 1 ? 1 : 0);
    return { ms: Math.round(seconds * 1000), taken, mp: Math.max(0, mp), shotActions, died: taken >= bot.hp };
}

module.exports = {
    rotationOf, openingAt, damageTerms, normalCdf, incoming, rotationFor, useTable, kill, WORST_Z,
    get enabled() { return enabled; },
    set enabled(value) { enabled = value === true; }
};
