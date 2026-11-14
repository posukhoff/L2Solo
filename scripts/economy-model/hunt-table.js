'use strict';
// The model's own hunting table: what a bot of each kit key, at its own level, in
// a kit (its stat point; for now the creation kit only) gets from each species of
// each spot near its level, the species alone, bare and with its weapon's shots.
// Measured by the spot table generator's hunt() (the game's cold combat) with the
// game's solo readiness lifted (hunt-lift.js); physics at rate x1. The model
// applies the rates, its per-species admission and the combination of species on
// time (combine) when it reads the file. Offline only, one file per combat
// revision (stamp) and level range:
//   node scripts/economy-model/hunt-table.js --levels 1-19 [--children 7] [--hours 2]
//        [--spots id,id] [--keys k,k] [--out file]   (a pick: --out required)
//        [--catalogue file]   (a saved { spots, profiles } catalogue; default: built now, geodata required)
require('../../src/Global');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Boot = require('./boot');
const Generator = require('../generate-spot-table');
const Lift = require('./hunt-lift');
const Weights = require('./weights');

const ROOT = path.resolve(__dirname, '../..');
// A cell, per form [bare, shots]: kills an hour, then per kill: deaths, the
// fight without the walk (s), the rest it calls for (s), the other time of the
// hunt (death recovery, waits; s), the walk to the mobs (s), exp (x1, before
// the level-gap penalty), shots, potions, and the mobs per engagement (pull).
// fight + rest + other + walk = the hunt's time per kill, so species combine
// on time. A cell without a kill has kills 0 and every per-kill field null.
const FIELDS = Object.freeze(['kills', 'deaths', 'fight', 'rest', 'other', 'walk', 'exp', 'shots', 'potions', 'pull']);
const FORMS = Object.freeze(['bare', 'shots']);
// Species level minus bot level: below -9 the mob is deep blue (the reader's
// world rule); above +7 every swept cell was a death per kill or worse.
const WINDOW = Object.freeze([-9, 7]);
const POINT_FIELDS = Object.freeze(['attack', 'defence']);
const REST_RULE = 'fight when the vitals cover one expected fight with the mob (survival ratio 1), or at a whole bar';
const START = 1_750_000_000_000;
const DWARF_FIGHTER = 53;
// The combination check: per key and level this many spots whose species all
// lie in the window, hunted whole.
const CHECK_SPOTS = 3;
// The combat inputs the stamp covers (their live git tree).
const STAMP_PATHS = Object.freeze(['src', 'data', 'scripts/generate-spot-table.js', 'scripts/economy-model/hunt-lift.js',
    'scripts/economy-model/hunt-table.js']);

const round = value => value === 0 ? 0 : Number(value.toPrecision(4));

// A hunt's sums as one cell form (FIELDS).
function cellOf(sum, hours) {
    const mobs = sum.mobs;
    if (!(mobs > 0)) return [0, ...FIELDS.slice(1).map(() => null)];
    const seconds = ms => round(ms / 1000 / mobs);
    return [round(mobs / hours), round(sum.deaths / mobs), seconds(sum.fightMs - sum.walkMs), seconds(sum.restMs),
        seconds(hours * 3600000 - sum.fightMs - sum.restMs), seconds(sum.walkMs), round(sum.exp / mobs),
        round(sum.shots / mobs), round(sum.potions / mobs), round(sum.pullMobs / sum.pulls)];
}

// The spot's species: selfId -> { level, count, production (mobs an hour, null without a production table) }.
function speciesOf(spot) {
    const by = new Map();
    for (const entry of spot.npcEntries || []) {
        const selfId = Number(entry.selfId), held = by.get(selfId) || { level: Number(entry.level), count: 0, production: null };
        held.count += Math.max(1, Number(entry.count) || 1);
        if (Number.isFinite(entry.production)) held.production = round((held.production || 0) + entry.production);
        by.set(selfId, held);
    }
    return by;
}

// The species alone on its spot: its own spawns, its share of the spot's
// density (the walk between its mobs), its level counts.
function speciesSpot(spot, selfId) {
    const entries = spot.npcEntries.filter(entry => Number(entry.selfId) === selfId);
    const total = spot.npcEntries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const count = entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const levelCounts = {};
    for (const entry of entries) levelCounts[entry.level] = (levelCounts[entry.level] || 0) + Math.max(1, Number(entry.count) || 1);
    return { ...spot, npcEntries: entries, npcSelfIds: [selfId], npcNames: [entries[0].name],
        density: (Number(spot.density) || 1) * count / total, levelCounts,
        dominantLevels: Object.entries(levelCounts).map(([level, held]) => ({ level: Number(level), count: held })).sort((a, b) => b.count - a.count) };
}

// The class's creation kit (StarterItemCatalog, the game's rule for players and
// bots), worn: hunt()'s kit(bot) over the reference body.
function creationKit(classId) {
    const Data = invoke('GameServer/DataCache'), Starter = invoke('GameServer/Knowledge/StarterItemCatalog');
    const rows = Starter.starterRows(Data.newbieItems, classId, Data.items);
    return bot => {
        const inventory = {};
        for (const row of rows) inventory[String(row.selfId)] = row.equipped
            ? { selfId: Number(row.selfId), amount: 1, equipped: true, equippedCount: 1, equippedSlots: [row.slot], slot: row.slot }
            : { selfId: Number(row.selfId), amount: Number(row.amount) || 1 };
        bot.inventory = inventory;
    };
}

// The body a line hunts with at a level: its class, in its creation kit, and
// the kit's profile (unbuffed, day).
function creationBody(line, level) {
    const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const classId = Generator.classFor(line, level);
    const bot = invoke('GameServer/Bot/AI/HuntCycle').referenceState(classId, level,
        { gear: invoke('GameServer/Bot/AI/BotGear'), profile: CCP, line: Generator.lineClassFor(line) });
    creationKit(classId)(bot);
    return { classId, profile: CCP.profileFor(bot, START, { store: false }) };
}

// The kit's stat point: the weapon's item attack (magical for a caster-weapon
// class, else physical) and the armour's item defence with its set bonus, the
// kit's raw sums before the level multiplier (ColdCombatProfile's kit part).
function pointOf(profile, classId) {
    const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Sets = invoke('GameServer/Items/C4ArmorSets');
    const sets = (profile.effects || []).filter(effect => effect.category === Sets.CATEGORY).map(effect => effect.stats);
    const gear = profile.equipment;
    return { attack: invoke('GameServer/Bot/AI/BotRoles').usesCasterWeaponCombat(classId) ? gear.mAtk : gear.pAtk,
        defence: Math.round(gear.pDef * CCP.statMultiplier(null, 'pDefMul', START, sets) + CCP.statAdd(null, 'pDefAdd', START, sets)) };
}

// The lines of the fresh world: weighted, without the dwarf fighter (no dwarf is created).
function freshLines() {
    return Object.keys(Weights.CLASS_WEIGHTS).filter(line => Weights.CLASS_WEIGHTS[line] > 0 && Generator.classFor(line, 1) !== DWARF_FIGHTER)
        .sort((a, b) => Number(a) - Number(b));
}

// The kit keys of a level: key -> { line, classId, point, lines }. Lines that
// share a key share its class and creation kit, so its point (thrown otherwise)
// and its weapon's speed and critical (one weapon type per key).
function keysAt(level, lines, onlyKeys) {
    const keys = new Map();
    for (const line of lines) {
        const key = Generator.botFor(line, level);
        if (onlyKeys && !onlyKeys.includes(key)) continue;
        const { classId, profile } = creationBody(line, level);
        const point = pointOf(profile, classId), speed = [profile.equipment.atkSpd, profile.equipment.critical].join('/');
        const held = keys.get(key);
        if (!held) { keys.set(key, { line, classId, point, speed, lines: [line] }); continue; }
        if (held.classId !== classId || held.point.attack !== point.attack || held.point.defence !== point.defence || held.speed !== speed) {
            throw new Error(`key ${key} L${level}: line ${line} (class ${classId}, point ${point.attack}/${point.defence}, speed/critical ${speed}) `
                + `differs from line ${held.line} (class ${held.classId}, point ${held.point.attack}/${held.point.defence}, ${held.speed})`);
        }
        held.lines.push(line);
    }
    return keys;
}

// Where a line's creation kit wields another weapon type than the best rung of
// its gear ladder (the hunt tables' gear table, the rungs of the level's grade
// and below): the stat grid built later starts from the ladder's type there.
// [{ line, from, to, creation, ladder, types }] by line and level band.
function weaponTypes(lines, from, to) {
    const Mask = invoke('GameServer/Skills/WeaponMask'), Grades = require('../../src/GameServer/Bot/AI/GearGradeRule');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const gear = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/Bots/hunt/gear.json'), 'utf8'));
    const items = new Map(gear.items.map(row => [Number(row[0]), row]));
    const out = [];
    for (const line of lines) {
        let band = null;
        for (let level = from; level <= to; level++) {
            const creation = creationBody(line, level).profile.equipment.weaponKind || 'none';
            const rank = Grades.rankOf(Grades.gradeForLevel(level));
            const row = gear.classes.find(held => Number(held.classId) === Number(Table.roleClass(line, level)));
            const rungs = (row?.slots.weapon || []).map(([selfId]) => items.get(Number(selfId))).filter(item => item && Grades.rankOf(item[4]) <= rank);
            const kinds = [...new Set(rungs.map(item => Mask.weaponType(item[2], item[3])))];
            const ladder = kinds[0] || 'none', types = kinds.join(',');
            if (band && band.creation === creation && band.ladder === ladder && band.types === types) band.to = level;
            else out.push(band = { line, from: level, to: level, creation, ladder, types });
        }
    }
    return out.filter(band => band.creation !== band.ladder);
}

// The model's combination of species on time for an admitted set of a spot:
// species drawn by their density share p, the time per kill the share-weighted
// fight, rest and other time plus the walk at the set's density over its pull
// (walkMs: BackgroundResolver.soloWalkMs, the game's rule), kills an hour at
// most the set's production. cells: selfId -> [bare, shots]; admitted: selfIds.
function combine({ spot, cells, body, form, admitted, walkMs }) {
    const total = Object.values(spot.species).reduce((sum, held) => sum + held.count, 0);
    let count = 0, production = 0, capped = true;
    for (const selfId of admitted) {
        count += spot.species[selfId].count;
        if (spot.species[selfId].production === null) capped = false;
        else production += spot.species[selfId].production;
    }
    if (!count) return null;
    const at = Object.fromEntries(FIELDS.map((field, index) => [field, index]));
    let perKill = 0, deaths = 0, pull = 0;
    for (const selfId of admitted) {
        const share = spot.species[selfId].count / count, cell = cells[selfId][FORMS.indexOf(form)];
        perKill += share * (cell[at.fight] + cell[at.rest] + cell[at.other]);
        deaths += share * cell[at.deaths];
        pull += share * cell[at.pull];
    }
    perKill += walkMs(spot.density * count / total, body.runSpd, spot.area, body.reach) / 1000 / pull;
    const kills = 3600 / perKill;
    return { kills: capped ? Math.min(kills, production) : kills, deaths };
}

// The live tree's combat inputs: the git tree ids of STAMP_PATHS over a copy of
// the index with the working files added (edits count, HEAD does not).
function stamp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-stamp-'));
    try {
        const git = (args, env = {}) => childProcess.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
        const index = path.join(dir, 'index');
        fs.copyFileSync(path.resolve(ROOT, git(['rev-parse', '--git-path', 'index'])), index);
        git(['add', '-A', '--', ...STAMP_PATHS], { GIT_INDEX_FILE: index });
        const tree = git(['write-tree'], { GIT_INDEX_FILE: index });
        const ids = STAMP_PATHS.map(entry => `${entry} ${git(['rev-parse', `${tree}:${entry}`])}`);
        return crypto.createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 12);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// The server's spot catalogue, saved for the children; built on the geodata
// (the spot ids and floors of the server), refused without it.
function saveCatalogue(file) {
    process.env.L2_TABLES_GEODATA = 'required';
    const built = Generator.buildCatalogue();
    fs.writeFileSync(file, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
    return file;
}

function plan({ profiles, from, to, lines, onlyKeys, onlySpots }) {
    const tasks = [], bodies = {}, spots = {}, pick = onlySpots ? profiles.filter(spot => onlySpots.includes(String(spot.id))) : profiles;
    for (let level = from; level <= to; level++) {
        for (const [key, held] of keysAt(level, lines, onlyKeys)) {
            const body = `${key}|${level}|${held.point.attack}/${held.point.defence}`;
            bodies[body] = { classId: held.classId, runSpd: null, reach: null, point: held.point };
            let checks = 0;
            for (const spot of pick) {
                const species = speciesOf(spot), spotId = String(spot.id);
                const near = [...species].filter(([, one]) => one.level - level >= WINDOW[0] && one.level - level <= WINDOW[1]);
                if (!near.length) continue;
                spots[spotId] ||= { area: spot.spawnArea, density: spot.density, species: Object.fromEntries([...species].map(([selfId, one]) => [selfId, one])) };
                for (const [selfId] of near) for (const form of [0, 1]) tasks.push({ body, line: held.line, classId: held.classId, level, spotId, selfId, form });
                if (checks < CHECK_SPOTS && near.length === species.size && species.size > 1) {
                    checks += 1;
                    for (const form of [0, 1]) tasks.push({ body, line: held.line, classId: held.classId, level, spotId, selfId: 0, form });
                }
            }
        }
    }
    tasks.forEach((task, index) => { task.i = index; });
    return { tasks, bodies, spots };
}

// A child: its share of the tasks (every n-th), one result line each.
function runChild([tasksFile, shard, n, outFile, catalogueFile, hours]) {
    Generator.loadSimulation(catalogueFile);
    const profiles = new Map(JSON.parse(fs.readFileSync(catalogueFile, 'utf8')).profiles.map(spot => [String(spot.id), spot]));
    const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).filter((task, index) => index % Number(n) === Number(shard));
    const out = fs.openSync(outFile, 'w');
    Lift.lift(true);
    for (const task of tasks) {
        const spot = profiles.get(task.spotId), started = Date.now();
        const sum = Generator.hunt(task.selfId ? speciesSpot(spot, task.selfId) : spot, task.line, task.level, task.form, Number(hours),
            undefined, creationKit(task.classId), task.classId);
        fs.writeSync(out, `${JSON.stringify({ i: task.i, cell: cellOf(sum, Number(hours)), runSpd: sum.runSpd, reach: sum.reach, ms: Date.now() - started })}\n`);
    }
    fs.closeSync(out);
    Lift.lift(false);
}

function runChildren(dir, tasks, children, catalogueFile, hours) {
    const tasksFile = path.join(dir, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasks));
    const n = Math.max(1, Math.min(children, tasks.length));
    const runs = Array.from({ length: n }, (_, shard) => new Promise((resolve, reject) => {
        const outFile = path.join(dir, `results-${shard}.jsonl`);
        const child = childProcess.fork(__filename, ['child', tasksFile, String(shard), String(n), outFile, catalogueFile, String(hours)],
            { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve(outFile) : reject(new Error(`hunt table child ${shard} exited ${code}`)));
    }));
    return Promise.all(runs).then(files => files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))));
}

const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))] : null;

async function build({ from, to, hours = 2, children = 7, spots: onlySpots = null, keys: onlyKeys = null, catalogue = null, out = null,
    limit = 0.05, log = console.log }) {
    if ((onlySpots || onlyKeys) && !out) throw new Error('a pick of spots or keys is not the table: name its --out');
    const started = Date.now(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-table-'));
    try {
        const catalogueFile = catalogue || saveCatalogue(path.join(dir, 'catalogue.json'));
        Generator.loadSimulation(catalogueFile);
        const profiles = JSON.parse(fs.readFileSync(catalogueFile, 'utf8')).profiles;
        const canary = Lift.checkLift(Generator, profiles.find(spot => String(spot.id) === Lift.CANARY.spotId));
        log(`lift canary ${Lift.CANARY.spotId}: kills ${canary.gated} gated, ${canary.lifted} lifted`);
        const lines = freshLines();
        for (const band of weaponTypes(lines, from, to)) {
            log(`weapon type: line ${band.line} L${band.from}-${band.to} creation kit ${band.creation}, gear ladder ${band.ladder} (rungs ${band.types || 'none'})`);
        }
        const { tasks, bodies, spots } = plan({ profiles, from, to, lines, onlyKeys, onlySpots });
        log(`levels ${from}-${to}: bodies ${Object.keys(bodies).length}, spots ${Object.keys(spots).length}, hunts ${tasks.length} on ${children} children`);
        const results = await runChildren(dir, tasks, children, catalogueFile, hours);
        if (results.length !== tasks.length) throw new Error(`hunt table: ${results.length} results for ${tasks.length} hunts`);
        const cells = {}, whole = [];
        for (const result of results) {
            const task = tasks[result.i], body = bodies[task.body];
            if (body.runSpd === null) Object.assign(body, { runSpd: result.runSpd, reach: result.reach });
            else if (body.runSpd !== result.runSpd || body.reach !== result.reach) throw new Error(`body ${task.body}: run speed or reach differs between its hunts`);
            if (!task.selfId) { whole.push({ task, cell: result.cell }); continue; }
            const held = ((cells[task.body] ||= {})[task.spotId] ||= {})[task.selfId] ||= [null, null];
            held[task.form] = result.cell;
        }
        const table = { stamp: stamp(), range: [from, to], window: WINDOW, hours, restRule: REST_RULE, point: { fields: POINT_FIELDS },
            fields: FIELDS, forms: FORMS, bodies, spots, cells };
        const file = out || path.join(ROOT, 'tmp/economy-model/hunt', `hunt-${from}-${to}-${table.stamp}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(table));
        const check = summary({ table, whole, results, limit, log });
        log(`wrote ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - started) / 1000)} s`);
        return { file, table, check };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// The build's prints: hunts and their time, the cells over the kill-death
// limit and without a kill, the rest share per key and level, and the
// combination check (the whole spot hunted against combine over its species
// within the limit).
function summary({ table, whole, results, limit, log }) {
    const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
    const ms = results.reduce((sum, result) => sum + result.ms, 0);
    log(`hunts ${results.length}, ${(ms / Math.max(1, results.length)).toFixed(0)} ms a hunt (child time)`);
    let over = 0, none = 0, all = 0;
    for (const [body, bySpot] of Object.entries(table.cells)) {
        const rest = [];
        for (const bySpecies of Object.values(bySpot)) for (const forms of Object.values(bySpecies)) for (const cell of forms) {
            all += 1;
            if (!(cell[0] > 0)) { none += 1; continue; }
            if (cell[1] > limit) over += 1;
            rest.push(cell[3] * cell[0] / 3600);
        }
        log(`rest share ${body}: p50 ${quantile(rest, 0.5)?.toFixed(3)} p90 ${quantile(rest, 0.9)?.toFixed(3)} (${rest.length} cells with kills)`);
    }
    log(`cells ${all}: deaths a kill over ${limit} ${over}, without a kill ${none}`);
    const check = [];
    for (const { task, cell } of whole) {
        const spot = table.spots[task.spotId], cells = table.cells[task.body]?.[task.spotId] || {};
        // The reader's admission: the species with a kill and deaths a kill within the limit.
        const admitted = Object.keys(spot.species).filter(selfId => cells[selfId]?.[task.form]?.[0] > 0 && cells[selfId][task.form][1] <= limit);
        const read = combine({ spot, cells, body: table.bodies[task.body], form: FORMS[task.form], admitted, walkMs: BR.soloWalkMs });
        const row = { body: task.body, spotId: task.spotId, form: FORMS[task.form], species: Object.keys(spot.species).length, admitted: admitted.length,
            measured: { kills: cell[0], deaths: cell[1] }, combined: read && { kills: round(read.kills), deaths: round(read.deaths) } };
        check.push(row);
        log(`check ${row.body} ${row.spotId} ${row.form}: species ${row.admitted}/${row.species}, whole kills/h ${row.measured.kills} deaths/kill ${row.measured.deaths}`
            + ` | combined ${read ? `${row.combined.kills} ${row.combined.deaths}` : 'none'}`);
    }
    const ratios = check.filter(row => row.combined && row.measured.kills > 0).map(row => row.combined.kills / row.measured.kills);
    log(`combination check: ${check.length} spot forms, combined/whole kills p10 ${quantile(ratios, 0.1)?.toFixed(2)} p50 ${quantile(ratios, 0.5)?.toFixed(2)} p90 ${quantile(ratios, 0.9)?.toFixed(2)}`);
    return check;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv[0] === 'child') {
        runChild(argv.slice(1));
        process.exit(0);
    }
    const [from, to] = String(Boot.option(argv, 'levels', '1-19')).split('-').map(Number);
    const list = name => Boot.option(argv, name, null)?.split(',') || null;
    build({ from, to: to || from, hours: Number(Boot.option(argv, 'hours', 2)), children: Number(Boot.option(argv, 'children', 7)),
        spots: list('spots'), keys: list('keys'), catalogue: Boot.option(argv, 'catalogue', null), out: Boot.option(argv, 'out', null) })
        .catch(error => { console.error(error.stack || error); process.exit(1); });
}

module.exports = { build, combine, stamp, cellOf, FIELDS, FORMS, WINDOW, POINT_FIELDS };
