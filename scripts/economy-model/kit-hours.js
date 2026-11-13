'use strict';

const Boot = require('./boot');
const Load = require('./load');
const Worth = require('./rules/worth');

const { wornKit } = Worth;

// The seam of a kit's hunt hour:
// - hour(line, level, kit) -> hour | null: the hunt hour of the line's main
//   at that level wearing that kit; null when it cannot be stated.
// - swaps(line, level, kit, pieces) -> { hour, swaps: [{ hour }] }: the
//   worn kit's hour and per piece ({ slot, selfId }) the hour of the kit with
//   the piece put on in its slot (taking off what it cannot be worn with);
//   hour null where a kit cannot be stated.
// - shotScale(line, level, spotId, weapon, blessed) -> the shots the weapon
//   fires at a spot row of the line at that level over the row's own count,
//   the row's plain shots or its Blessed Spiritshots (blessed); null
//   where the table has no reference count for the row (rowCharge: the kind
//   is no option there).
// - warm(): builds every band's body at once.
// kit: { paperdoll slot: selfId }, an empty slot absent or 0 (the body
// fights with its class's bare numbers there).
// A kit's hour, in the design's adena per hunting hour, carries no shot
// price: { none, shots: [{ id, kind, gross, units }] }. none: the hour
// firing no shots (the hunt cycle's shotless form), null where the line
// fights nothing so; shots: per kind of shot the worn weapon fires (its
// class's soulshot; a spiritshot class's Spiritshot and Blessed
// Spiritshot; a kind the anchor has no price for is left out) the hour gross of shots (gross) and the shots it fires an
// hour (units) at the worn weapon's own count per action; empty for a
// weapon that fires none or bare hands. A decision prices the shots
// (rules/worth firing). A worn bow spends one arrow per attack: its hour
// states per option the arrows it spends, { id: the arrow of the bow's
// grade, units: an hour }, on each shot kind (arrows) and for the hour
// firing none (noneArrows, beside none when none is stated); `arrows: null`
// on a bow means the attacks are not stated, never zero arrows; absent for any
// other weapon. The hour is gross of
// arrows as it is of shots.
// Each option also states killShare, the kit's kills an hour over the cell
// row's (the table's reference bot at the band's level), and shotShare, its
// kills times fight share over them; the shotless hour states them in
// noneShare { killShare, shotShare }. null where the row states no kills.

// The spots a main's occupation ranks (its line's first spots by income).
const TOP_SPOTS = 10;
// The numbers the hunt cycle's reference carries (HuntCycle REFERENCE_NUMBERS):
// the only ones its hour formula reads off a kit's numbers.
const REFERENCE_NUMBERS = Object.freeze(['pAtk', 'atkSpd', 'accur', 'critical', 'mAtk', 'castSpd', 'pDef', 'mDef', 'evasion', 'maxHp', 'con', 'men']);
// A kit's numbers as the hunt cycle's reference states them: the full
// profile also carries the weapon's own fields (a bow's attack reuse), which
// the reference's numbers and the formula's candidates leave out, so an hour
// read on them would weigh one kit by two attack cycles.
function referenceNumbers(numbers) {
    const out = {};
    for (const key of REFERENCE_NUMBERS) out[key] = numbers[key];
    return out;
}

// The inventory rows of worn pieces ({ selfId, slot }), as a bot's equipped
// rows (HuntCycle.referenceState): one row per item, its slots listed.
function inventoryOf(pieces) {
    const inventory = {};
    for (const row of pieces) {
        const key = `kit-${row.selfId}`, prior = inventory[key], amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId: Number(row.selfId), amount, equipped: true, equippedCount: amount,
            equippedSlots: [...(prior?.equippedSlots || []), Number(row.slot)], slot: Number(row.slot) };
    }
    return inventory;
}

// A line's kit of a level (BotGear's, for the line's class there): [{ selfId, slot }].
function lineKit(owners, line, level) {
    const { Table, HuntCycle, BotGear } = owners, classId = Table.roleClass(line, level);
    return BotGear.planFor({ classId, level, characterId: HuntCycle.referenceId(classId, Number(line)) }).items
        .map(row => ({ selfId: Number(row.selfId), slot: Number(row.slot) }));
}

// A line's reference bot at a level wearing pieces ([{ selfId, slot }]).
function referenceBot(owners, line, level, pieces) {
    const { Table, HuntCycle, Data } = owners;
    const classId = Table.roleClass(line, level), state = HuntCycle.referenceState(classId, level, { line: Number(line) });
    return { ...state, inventory: inventoryOf(pieces), stats: { ...state.stats, exp: Data.experience[level - 1] } };
}

// The hunt of a body (state) of a line at a level whose best spot is best
// (SpotValueTable.best), with its shots or none (useShots false): every spot
// weighed by a hunt cycle reader at the best spot or one of the line's
// ranked spots, each once: the reader that weighs it, its index there, the
// shots a kill there takes as the reader charges them (perKill, at the
// reader's price) and per shot of a weapon's charge (perCharge: perKill over
// the row's charge; a worn weapon fires its own count per action).
// rowCharge(role, spotId, shotRows): the charge a spot row counts its shots at,
// null where the table has no reference count for it: a row that fires shots
// without one is no cell of that kind.
// Per cell also the bow attacks a kill takes at the row's own fight
// (attacks): a bow spends one arrow per attack, landed or missed, and none
// on a skill (Actor/BowResources at the normal attack); the table counts no
// attacks, only shot actions (a landed attack or a skill that loads a
// shot), so a kill's attacks are its shot actions: a row firing shots,
// perKill over its charge; a row firing none, its fight seconds at the
// rate of the spot's row firing the plain shot (that row's shot actions
// over its fight seconds: a shot changes an attack's damage, not the
// attack cycle). null where that row fires no shots or has no reference
// count.
function referenceHunt(owners, line, level, state, best, deathHours, useShots, rowCharge) {
    const { Table, HuntCycle, ShotStock, Hunt, Rewards } = owners;
    const spots = [String(best.spotId), ...Table.rankedIncome(line, level).slice(0, TOP_SPOTS).map(row => String(row.spotId))], cells = new Map();
    const role = Table.roleFor(state), shotRows = ShotStock.shotRows(ShotStock.planForState(state), useShots);
    const rewardOptions = { spoilSkillLevel: Rewards.spoilSkillLevel(state) }, price = Hunt.consumablePrices(state).shots;
    const shotlessAttacks = id => {
        const own = Table.cycle(id, role, Number(state.level), shotRows, rewardOptions), fired = Table.cycle(id, role, Number(state.level), true, rewardOptions);
        const ref = own && fired?.shots > 0 && fired.fight > 0 ? rowCharge(role, id, true) : null;
        return ref === null ? null : own.fight * fired.shots / ref / fired.fight;
    };
    for (const spotId of spots) {
        if (cells.has(spotId)) continue;
        const reader = HuntCycle.reader(state, { deathHours, hunt: useShots === false ? { spotId, useShots: false } : { spotId } });
        reader.spotIds.forEach((id, index) => {
            if (cells.has(String(id))) return;
            const cycle = Table.cycle(id, role, Number(state.level), shotRows, rewardOptions), perKill = shotRows ? cycle?.shots || 0 : 0;
            const ref = perKill > 0 ? rowCharge(role, id, shotRows) : null;
            if (perKill > 0 && ref === null) return;
            const perCharge = ref === null ? 0 : perKill / ref;
            cells.set(String(id), { reader, index, perKill, perCharge, price, kph: cycle?.kph || 0, attacks: shotRows ? perCharge : shotlessAttacks(id) });
        });
    }
    return [...cells.values()];
}

// An option's hour over its cells: per cell the reader's hour of the kit
// (numbers) with its shot bill given back (gross, times the band's scale),
// the shots fired at the kit's charge (units) and the bow attacks (attacks:
// the kills' attacks at the kit's fight, null where the cell states none);
// the cell taken is the one that nets most at the anchor price of the
// option's shot (price; 0 firing none). Returns { gross, units, attacks,
// killShare, shotShare }: the kit's kills an hour over the cell row's (kph),
// and its kills times fight share over them (null where the row states no kph).
function optionHour(cells, numbers, charge, price, scale) {
    let best = null;
    for (const cell of cells) {
        const one = cell.reader.hourAt(numbers, cell.index), fired = one.kills * one.share;
        const gross = (one.income + fired * cell.perKill * cell.price) * scale, units = fired * cell.perCharge * charge;
        if (!best || gross - units * price > best.net) best = { gross, units, net: gross - units * price, attacks: cell.attacks === null ? null : fired * cell.attacks, killShare: cell.kph > 0 ? one.kills / cell.kph : null, shotShare: cell.kph > 0 ? fired / cell.kph : null };
    }
    return best;
}

// The game's owners the kit hours read: no World, no database.
function kitOwners() {
    return {
        Data: invoke('GameServer/DataCache'),
        Index: require('../../src/GameServer/Item/ItemTemplateIndex'),
        Table: invoke('GameServer/Bot/AI/SpotValueTable'),
        BotGear: invoke('GameServer/Bot/AI/BotGear'),
        HuntCycle: invoke('GameServer/Bot/AI/HuntCycle'),
        Profile: invoke('GameServer/Bot/Population/ColdCombatProfile'),
        Valuation: invoke('GameServer/Bot/Economy/EconomicValuation'),
        ShotStock: invoke('GameServer/Inventory/ShotStock'),
        Hunt: invoke('GameServer/Bot/AI/BotHuntEfficiency'),
        Rewards: require('../../src/GameServer/Bot/Economy/SpotRewardExpectation'),
        ColdRest: invoke('GameServer/Bot/Population/ColdRest'),
        Enchant: invoke('GameServer/Items/C4EnchantRules'),
        Grades: require('../../src/GameServer/Bot/AI/GearGradeRule'),
        Arrows: require('../../src/GameServer/Inventory/ArrowStock')
    };
}

// Two CON/MEN points the seated regeneration of a kit is read at: the tick is
// linear in each term (a multiplier over the stat's base modifier plus an
// add), so the ticks at two points state the kit's regeneration terms.
const REGEN_POINTS = Object.freeze([20, 40]);
// The hands' slots: one-handed 7, two-handed 14.
const HAND_SLOTS = Object.freeze([7, 14]);

// The kit hours by the game's own hunt cycle. A kit's hour: the line's
// reference bot at the band's middle level wearing the kit, its numbers the
// cold profile's (ColdCombatProfile.profileFor, only the reference numbers
// read), at the best cell (a hunt cycle reader at one of the gear ladder's
// spots) of each option (no shots: readers on the rows without shots; each
// kind of shot: readers on a body firing that kind), money, potions and
// deaths times the band's scale (the design's money over today's at the
// band's best spot), the reader's shot bill given back (gross). The best
// cell of a kind is the one that nets most at the shot's anchor price
// (anchor: item -> adena, the design's first price of the shot, the same at
// every rate and never scaled by the band): a constant, so the cell a kit
// is read at never moves with a market price; the hour is held per kit and
// band, and a decision prices its shots at its own moment.
// A reader reads of the body it is built on the shots it fires (ShotStock's
// plan: their rows, their price, the spots it ranks by them and the hour a
// death costs at them) and the seated regeneration terms of its kit
// (passives on armour kinds, armour sets); everything else it reads of the
// kit's numbers. So the cells are built once per (line, band, option, shot
// fired, regeneration terms), on the first kit that has them, and every kit
// with the same shot and terms reads them.
// null: no band for the level, an item without a template, a piece above the
// band's grade (the cold profile applies no grade penalty, so the hour of
// such a kit is not stated) or no spot weighed.
// The game data must be the snapshot's: the loader (load.js
// loadSnapshot) gives a run only the snapshot whose stamp equals the live one.
function gameKitHours({ snapshot, preset = snapshot?.header?.preset, anchor }) {
    const header = snapshot?.header || {};
    if (preset !== header.preset) throw new Error(`kit hours: preset ${preset} against the snapshot's ${header.preset}`);
    if (!anchor || typeof anchor !== 'object') throw new Error('kit hours: the anchor (item -> adena, the design\'s first price of each shot) is required');
    Boot.boot(preset);
    // No player board stands beside the model: a reader prices shots as a
    // hunt with no board in view does (the NPC price, else the market's
    // evidence, else the first price), never through the live server's board,
    // whose module needs the World and the database.
    invoke('GameServer/Bot/Economy/StaticMerchantPricing').useBoard(() => null);
    const owners = kitOwners(), { Data, Index, Table, Profile, Valuation, ColdRest, Enchant, Grades, ShotStock, Arrows } = owners;
    const lines = snapshot.gearLadder?.lines || {};
    // A shot the anchor has no price for (no route makes it) is no option for
    // the spot choice: null. A price of 0 is a free shot.
    const anchorOf = id => (anchor[id] === null || anchor[id] === undefined || !Number.isFinite(Number(anchor[id])) ? null : Math.max(0, Number(anchor[id])));
    // (line, band index) -> its bare reference bot, best spot and
    // death hours (the exp a death
    // loses and the walk back: no kit reads), null without a best spot.
    const bots = new Map();
    // (line, band index, option, shot fired, regeneration terms) -> its cells, null without one.
    const hunts = new Map();
    const stats = { builds: 0, fresh: 0, swaps: 0, fast: 0 };
    const bandOf = (line, level) => { const bands = lines[line] || [], at = bands.findIndex(band => level >= band.from && level <= band.to); return at < 0 ? null : { at, band: bands[at] }; };
    const botOf = (line, at, band) => {
        const key = `${line}:${at}`;
        if (!bots.has(key)) {
            const best = Table.best(line, band.level, true, 'income');
            if (best && String(best.spotId) !== String(band.best)) throw new Error(`kit hours: line ${line} band ${at} (level ${band.level}) has best spot ${band.best} in the snapshot and ${best.spotId} in the live game; extract the snapshot again (scripts/economy-model/inputs.js)`);
            const bot = best ? referenceBot(owners, line, band.level, []) : null;
            bots.set(key, best ? { best, bot, deathHours: Valuation.deathHours(bot, { expPerHour: best.exp || 0, walkBackHours: Load.walkBackHours(best.spotId, bot) }) } : null);
        }
        return bots.get(key);
    };
    // A worn list the band states: every piece has a template of the band's grade or below.
    const stated = (worn, band) => {
        const rank = Grades.rankOf(band.grade);
        return worn.every(([, selfId]) => { const item = Index.find(Data.items, selfId); return item && Grades.rankOf(Enchant.gradeOf(item.etc)) <= rank; });
    };
    const stateOf = (held, worn) => ({ ...held.bot, inventory: inventoryOf(worn.map(([slot, selfId]) => ({ selfId, slot }))) });
    const regenOf = (state, profile) => REGEN_POINTS.map(point => ColdRest.coldRestRegenPerTick(state, { profile, stats: { con: point, men: point } }))
        .map(tick => `${tick.hp},${tick.mp}`).join(',');
    // A weapon's charge (shots per action) for a class: (class, weapon) ->
    // count, bounded by the classes times the weapon templates.
    const charges = new Map();
    const chargeOf = (classId, weapon) => {
        const key = `${classId}:${weapon}`;
        if (!charges.has(key)) charges.set(key, weapon ? Math.max(0, ShotStock.planForState({ stats: { classId }, inventory: inventoryOf([{ selfId: weapon, slot: 7 }]) }, { blessed: false })?.perAction || 0) : 0);
        return charges.get(key);
    };
    const weaponIn = pieces => pieces.find(row => HAND_SLOTS.includes(Number(row.slot)))?.selfId || 0;
    // The table's reference weapon's charge for a role at a level (the
    // reference bot's kit there): (role, level) -> count, bounded by the
    // roles times the levels.
    const refCharges = new Map();
    const refCharge = (role, level) => {
        const key = `${role}:${level}`;
        if (!refCharges.has(key)) {
            const classId = Table.roleClass(role, level);
            refCharges.set(key, classId === null ? 0 : chargeOf(classId, weaponIn(lineKit(owners, role, level))));
        }
        return refCharges.get(key);
    };
    // The charge a spot row of a role counts its shots at (shotRows: true its
    // plain shots, 2 its Blessed Spiritshots): the table's reference weapon's
    // at the level it hunted the spot at (SpotValueTable.referenceLevel); null
    // where the table has no reference count for the row (the kind is no
    // option there). The hour's units and the hunt's both read it.
    const rowCharge = (role, spotId, shotRows) => {
        const level = Table.referenceLevel(String(spotId), String(role), shotRows), charge = level ? refCharge(String(role), level) : 0;
        return charge > 0 ? charge : null;
    };
    // (line, band index, weapon) -> the options the weapon fires (ShotStock's
    // plans of the body), all a reader reads of the weapon: the body's own
    // plan (its shot key, which the shotless readers' death hour reads) and
    // per kind { kind, id, charge, key }; and the arrow a bow spends (arrow:
    // ArrowStock's of the bow's grade, as Actor/BowResources takes it; null
    // for any other weapon).
    const shots = new Map();
    const firesOf = (line, at, weapon, body) => {
        const key = `${line}:${at}:${weapon}`;
        if (!shots.has(key)) {
            const state = body(), own = ShotStock.planForState(state), plain = ShotStock.planForState(state, { blessed: false });
            const charge = plain ? chargeOf(state.stats.classId, weapon) : 0, kinds = [];
            if (charge > 0) {
                const blessed = plain.kind === 'soulshot' ? null : ShotStock.planForState(state, { blessed: true });
                for (const plan of [plain, blessed]) if (plan?.selfId) kinds.push({ kind: plan.kind, id: Number(plan.selfId), charge, key: `${plan.kind}:${plan.selfId}` });
            }
            const item = weapon ? Index.find(Data.items, weapon) : null;
            const arrow = item?.template?.kind === 'Weapon.Bow' ? Arrows.BY_RANK[String(item.etc?.rank ?? 'none').toLowerCase()] ?? null : null;
            shots.set(key, { own: own ? `${own.kind}:${own.selfId}` : 'none', kinds, arrow });
        }
        return shots.get(key);
    };
    // A body firing one kind of shot: the kind its earning answer names (a
    // spiritshot class with neither in its bag fires that kind, ShotStock
    // choosesBlessed).
    const kindBody = (state, kind) => (kind === 'soulshot' ? state : { ...state, stats: { ...state.stats, earning: { shotKind: kind } } });
    // The cells of a worn list's options with its regeneration terms, each
    // built on the first body (state) that fires such a shot with such terms.
    const cellsOf = (line, at, band, held, worn, regen, state) => {
        let body = null;
        const bodyOf = () => (body ||= state());
        const fires = firesOf(line, at, worn.find(([slot]) => HAND_SLOTS.includes(slot))?.[1] || 0, bodyOf);
        const build = (key, useShots, made) => {
            if (!hunts.has(key)) {
                stats.builds++;
                const cells = referenceHunt(owners, line, band.level, made(), held.best, held.deathHours, useShots, rowCharge);
                hunts.set(key, cells.length ? cells : null);
            }
            return hunts.get(key);
        };
        return {
            arrow: fires.arrow,
            none: build(`${line}:${at}:none:${fires.own}:${regen}`, false, bodyOf),
            kinds: fires.kinds.filter(row => anchorOf(row.id) !== null).map(row => ({ ...row, cells: build(`${line}:${at}:${row.key}:${regen}`, true, () => kindBody(bodyOf(), row.kind)) }))
        };
    };
    // A kit's hour of its options' cells at its numbers.
    // A bow's options carry their arrows ({ id, units }, null where the cell
    // states no attacks); any other weapon's carry none.
    const arrowsOf = (arrow, at) => (at.attacks === null ? null : { id: arrow, units: at.attacks });
    const hourOf = (options, numbers, scale) => {
        const shotless = options.none ? optionHour(options.none, numbers, 0, 0, scale) : null, none = shotless ? shotless.gross : null, out = [];
        for (const row of options.kinds) {
            if (!row.cells) continue;
            const at = optionHour(row.cells, numbers, row.charge, anchorOf(row.id), scale);
            out.push(options.arrow ? { id: row.id, kind: row.kind, gross: at.gross, units: at.units, arrows: arrowsOf(options.arrow, at), killShare: at.killShare, shotShare: at.shotShare }
                : { id: row.id, kind: row.kind, gross: at.gross, units: at.units, killShare: at.killShare, shotShare: at.shotShare });
        }
        if (none === null && !out.length) return null;
        const noneShare = shotless ? { killShare: shotless.killShare, shotShare: shotless.shotShare } : null;
        return shotless && options.arrow ? { none, noneArrows: arrowsOf(options.arrow, shotless), noneShare, shots: out } : { none, noneShare, shots: out };
    };
    // A worn list's hour and numbers by a whole profile pass, with the body
    // wearing it and its regeneration terms (hour null: not stated).
    const NONE = Object.freeze({ hour: null });
    const pass = (line, at, band, held, worn) => {
        stats.fresh++;
        if (!held || !stated(worn, band)) return NONE;
        const state = stateOf(held, worn), profile = Profile.profileFor(state, 0, { store: false }), regen = regenOf(state, profile);
        const numbers = referenceNumbers(profile), hour = hourOf(cellsOf(line, at, band, held, worn, regen, () => state), numbers, band.scale);
        return hour ? { hour, state, regen } : NONE;
    };
    const hour = (line, level, kit) => {
        const found = bandOf(line, level);
        return found ? pass(line, found.at, found.band, botOf(line, found.at, found.band), wornKit(kit)).hour : null;
    };
    // The worn kit's whole pass once and every piece through the cold
    // profile's candidate pass over it (ColdCombatProfile.candidateProfiles:
    // the formula over the new gear while the kit's gear conditions hold, so
    // its regeneration terms hold too; else a whole numbers pass, whose
    // profile states the new terms). A piece the worn kit cannot be stated
    // with, or any piece over a kit not stated, takes its own whole pass.
    const swaps = (line, level, kit, pieces) => {
        const found = bandOf(line, level), held = found && botOf(line, found.at, found.band);
        const out = { hour: null, swaps: pieces.map(() => NONE) };
        if (!held) return out;
        const { at, band } = found, worn = wornKit(kit), base = pass(line, at, band, held, worn);
        let candidates = null;
        out.hour = base.hour;
        out.swaps = pieces.map(({ slot, selfId }) => {
            stats.swaps++;
            const next = wornKit(Object.fromEntries([...worn.filter(([s]) => !Worth.slotsConflict(slot, s)), [slot, selfId]]));
            if (next.length === worn.length && next.every(([s, id], i) => s === worn[i][0] && id === worn[i][1])) return base.hour === null ? NONE : { hour: base.hour };
            if (base.hour === null || !stated(next, band)) return pass(line, at, band, held, next);
            const kept = new Set(next.map(([s, id]) => `${s}:${id}`)), added = next.filter(([s, id]) => !worn.some(([ws, wid]) => ws === s && wid === id));
            const off = new Set(worn.filter(([s, id]) => !kept.has(`${s}:${id}`)).map(([s]) => s));
            candidates ||= Profile.candidateProfiles(base.state, 0, { store: false });
            const after = candidates.after({ free: s => off.has(Number(s)), wear: added.map(([s, id]) => ({ selfId: id, enchant: 0, slot: s })) });
            if (!after.equipment) stats.fast++;
            const terms = after.equipment ? regenOf(stateOf(held, next), after) : base.regen;
            const numbers = referenceNumbers(after), hour = hourOf(cellsOf(line, at, band, held, next, terms, () => stateOf(held, next)), numbers, band.scale);
            return hour ? { hour } : NONE;
        });
        return out;
    };
    // The shots a weapon fires at a spot row of a line at a level over the
    // row's own count (its plain shots, or its Blessed Spiritshots with
    // blessed): the line's class there fires the weapon's own count per
    // action, the row counts at its charge (rowCharge), as a kit's hour
    // counts its units. null where the row has no reference count.
    const shotScale = (line, level, spotId, weapon, blessed = false) => {
        const ref = rowCharge(line, spotId, blessed ? 2 : true);
        return ref === null ? null : chargeOf(Table.roleClass(String(line), level), Number(weapon) || 0) / ref;
    };
    // Every band's body and the cells of its reference kit (BotGear's kit of
    // the band's level), built at once: the game's spot table reads each
    // line's levels on first use, a stretch of up to some 60 ms a read would
    // otherwise take in the run.
    const warm = () => {
        for (const [line, bands] of Object.entries(lines)) bands.forEach((band, at) => {
            const held = botOf(line, at, band);
            if (held) pass(line, at, band, held, wornKit(Object.fromEntries(lineKit(owners, line, band.level).map(row => [row.slot, row.selfId]))));
        });
    };
    return { hour, swaps, shotScale, warm, stats };
}

module.exports = { gameKitHours, wornKit, lineKit, referenceBot, referenceNumbers, TOP_SPOTS };
