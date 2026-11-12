'use strict';

// Does second-hand gear have a market under the design's rates? Per grade and
// preset, the share of the grade's gear pieces whose best buyer's cap reaches
// the seller's floor (rules/bounds.js), split into weapons, armour and
// jewellery. NPC prices taxed, as bots pay them (the shop tax is in the
// buylist data).
//
//   node scripts/economy-model/floor-cap.js [--dir <snapshots>] [--preset x1,x10,x50]
//
// The buyer: each line's reference bot entering the grade (the grade's first
// level) in the author's kit of the level before, the grade's first kit
// upgrade. Its worth of a piece is today's gear gain carried over
// (rules/worth.js gearWorth) over its hours to the end of the grade stage at
// the preset's exp per hour, in adena at its own hour: the design-rate income
// per hunting hour at its best spot (adena + loot at the NPC's buy price, the
// design drop rule, design-income.js). A death costs the exp it loses over
// the exp per hour plus the walk back from that spot (WalkBack over the hunt
// tables' spot centers, design-income.walkBackHours). The best buyer of a
// piece is the line whose cap is highest. Its own route's cost is left out
// but for the NPC's sell price, which lifts a cap where a craft route is
// cheaper than the worth.
// The seller's floor, three ways side by side:
// - npc: the NPC's buy price alone, the lowest floor a seller keeps: the
//   share reads high.
// - +D: or the D crystals a crystallizer gets from the piece, each at the
//   cheapest NPC gear route's adena per crystal (buy NPC gear, crystallize):
//   the most a crystal costs, so an upper bound of a crystallizer's bid; the
//   share reads low.
// - +D+C: also C crystals at five times that, the D crystals Luxury charges
//   for one (C4 exchange), again a ceiling: the share reads low.
// B, A and S crystals have no route a price can be read from: their floor is
// the NPC's.

const path = require('path');
const Boot = require('./boot');
const Weights = require('./weights');
const Capacity = require('./capacity');
const Bounds = require('./rules/bounds');
const Worth = require('./rules/worth');
const Income = require('./design-income');
const { DESIGN_RATES } = require('./rules/dropRule');

// The grade, its first level and the C4 crystal id.
const GRADES = Object.freeze([
    { grade: 'D', entry: 20, crystalId: 1458 }, { grade: 'C', entry: 40, crystalId: 1459 },
    { grade: 'B', entry: 52, crystalId: 1460 }, { grade: 'A', entry: 61, crystalId: 1461 },
    { grade: 'S', entry: 76, crystalId: 1462 }
]);
// D crystals Luxury charges for a C crystal (C4 exchange): a C crystal's ceiling.
const D_PER_C = 5;
const FLOORS = Object.freeze(['npc', '+D', '+D+C']);

function owners() {
    return {
        Data: invoke('GameServer/DataCache'),
        Index: require('../../src/GameServer/Item/ItemTemplateIndex'),
        Table: invoke('GameServer/Bot/AI/SpotValueTable'),
        HuntCycle: invoke('GameServer/Bot/AI/HuntCycle'),
        Profile: invoke('GameServer/Bot/Population/ColdCombatProfile'),
        BotGear: invoke('GameServer/Bot/AI/BotGear'),
        Equipment: require('../../src/GameServer/Bot/AI/BotEquipmentCompatibility'),
        Valuation: invoke('GameServer/Bot/Economy/EconomicValuation'),
        Caster: invoke('GameServer/Bot/Economy/BotImprovementPolicy'),
        // Loads the World module's code (no world is built), as the spot table generator does.
        Planner: invoke('GameServer/Bot/AI/GearAcquisitionPlanner')
    };
}

// A line's reference bot at the grade's first level in its kit of the level before.
function entryBot(o, line, entry) {
    const classId = o.Table.roleClass(line, entry), state = o.HuntCycle.referenceState(classId, entry, { line: Number(line) });
    const earlier = o.Table.roleClass(line, entry - 1), inventory = {};
    for (const row of o.BotGear.planFor({ classId: earlier, level: entry - 1, characterId: o.HuntCycle.referenceId(earlier, Number(line)) }).items) {
        const key = `kit-${row.selfId}`, prior = inventory[key], amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId: Number(row.selfId), amount, equipped: true, equippedCount: amount,
            equippedSlots: [...(prior?.equippedSlots || []), Number(row.slot)], slot: Number(row.slot) };
    }
    return { ...state, inventory, stats: { ...state.stats, exp: o.Data.experience[entry - 1] } };
}

// Each usable piece's kit numbers without and with it: itemId -> { before, after, caster }.
// A weapon counts only where the line's role prefers it to the weapon it holds
// (the gate of today's gear gain, WishProviders.gearGainReader).
function gains(o, state, items) {
    const role = o.Planner.roleFor(state), classId = state.classId, caster = o.Caster.isCaster(state);
    const candidates = o.Profile.candidateProfiles(state, 0, {}), out = new Map();
    const held = Object.values(state.inventory).map(row => o.Index.find(o.Data.items, row.selfId)).find(item => o.Equipment.isWeaponSlot(item?.etc?.slot));
    for (const item of items) {
        const slot = Number(item.etc?.slot);
        if (!o.Planner.equipmentCandidate(item, state, role)) continue;
        if (o.Equipment.isWeaponSlot(slot) && !o.Planner.equipmentItemBetter(item, held, role, classId)) continue;
        const after = candidates.after({ free: worn => o.Equipment.equipmentReplacementConflict(slot, worn), wear: { selfId: Number(item.selfId), enchant: 0, slot } });
        out.set(Number(item.selfId), { before: candidates.before, after, caster });
    }
    return out;
}

// A piece's group: weapon, armour (body, helmet, gloves, boots, shield) or jewellery.
function group(item) {
    const kind = String(item.template?.kind || '');
    return kind.startsWith('Weapon.') ? 'weapon' : kind === 'Armor.Jewel' ? 'jewellery' : 'armour';
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
}

function main(argv) {
    const dir = path.resolve(Boot.option(argv, 'dir', path.join(Boot.root, 'tmp', 'economy-model')));
    const presets = Boot.presetsOption(argv), startedAt = Date.now();
    Boot.boot('x1');
    const o = owners(), game = Income.gameRules();
    const snapshots = new Map(presets.map(preset => [preset, Income.loadSnapshot(dir, preset).snapshot]));
    const dCrystal = Capacity.crystalRoutes(Capacity.gameWorld().gearOffers()).get(1458).taxed.perCrystal;
    // Adena per crystal of each floor: crystal id -> price.
    const crystalPrice = { npc: {}, '+D': { 1458: dCrystal }, '+D+C': { 1458: dCrystal, 1459: D_PER_C * dCrystal } };
    const npcSell = new Map(Capacity.gameWorld().npcPrices());
    const lines = Object.entries(Weights.CLASS_WEIGHTS).filter(([, weight]) => weight > 0).map(([line]) => line);
    console.log(`D crystal ceiling (cheapest NPC gear route, taxed): ${Math.round(dCrystal)} adena; C ceiling ${D_PER_C} D = ${Math.round(D_PER_C * dCrystal)}.`);
    console.log('Floors: npc = NPC buy price alone (share reads high); +D and +D+C = crystals at their ceiling, an upper bound of a crystallizer\'s bid (share reads low).');
    console.log('death h = median over the lines of exp lost / exp per hour + walk back (median walk shown); own hour = median design-rate income per hunting hour at the best spot.');
    console.log('Shares: all (weapon/armour/jewellery) of the pieces some line can use.');
    console.log(`grade preset pieces w/a/j  | death h (walk) | own hour  horizon h | ${FLOORS.map(name => `floor ${name}`.padEnd(22)).join(' | ')} | caps by worth/npc`);
    for (const { grade, entry, crystalId } of GRADES) {
        const items = o.Data.items.filter(item => /^(Weapon|Armor)\./.test(item.template?.kind || '') && !/Pet/.test(item.template.kind)
            && String(item.etc?.rank || '').toUpperCase() === grade);
        const bots = lines.map(line => {
            const state = entryBot(o, line, entry);
            process.stderr.write(`[${grade}] line ${line}: ${items.length} pieces\n`);
            return { line, state, gains: gains(o, state, items) };
        });
        for (const preset of presets) {
            const snapshot = snapshots.get(preset), rates = DESIGN_RATES[preset];
            const buyers = bots.map(bot => {
                const hour = Income.designHour(snapshot, bot.line, entry, rates, game);
                const expPerHour = hour?.exp || 0, walk = Income.walkBackHours(hour?.spotId, bot.state);
                return { ...bot, ownHour: hour ? hour.design.adena + hour.design.loot : 0, walk,
                    horizon: o.Valuation.stageHours(bot.state, expPerHour, null),
                    deathHours: o.Valuation.deathHours(bot.state, { expPerHour, walkBackHours: walk }) };
            });
            const empty = () => ({ weapon: 0, armour: 0, jewellery: 0 });
            const pieces = empty(), pass = Object.fromEntries(FLOORS.map(name => [name, empty()])), by = { worth: 0, npc: 0 };
            for (const item of items) {
                const id = Number(item.selfId), ref = Number(item.template.price || 0), npcBuy = Math.max(1, Math.floor(ref * 0.5));
                const usable = buyers.filter(buyer => buyer.gains.has(id));
                if (!usable.length) continue;
                pieces[group(item)]++;
                const worth = Math.max(...usable.map(buyer => Worth.gearWorth({ ...buyer.gains.get(id), threatMask: 3, deathHours: buyer.deathHours,
                    horizonHours: buyer.horizon, ownHour: buyer.ownHour }).adena));
                const cap = Bounds.cap({ worth, npcSell: npcSell.has(id) ? npcSell.get(id) : null });
                by[cap.by === 'npc' ? 'npc' : 'worth']++;
                const crystals = Number(snapshot.items[id]?.crystals || 0);
                for (const name of FLOORS) {
                    const bid = crystals * (crystalPrice[name][crystalId] || 0);
                    if (cap.cap >= Bounds.floor({ npcBuy, crystallizerBids: bid > 0 ? [bid] : [] })) pass[name][group(item)]++;
                }
            }
            const total = row => row.weapon + row.armour + row.jewellery;
            const pct = (part, whole) => whole ? `${Math.round(part / whole * 100)}` : '-';
            const shares = row => `${pct(total(row), total(pieces))} % (${pct(row.weapon, pieces.weapon)}/${pct(row.armour, pieces.armour)}/${pct(row.jewellery, pieces.jewellery)})`;
            console.log(`${grade.padEnd(5)} ${preset.padEnd(6)} ${`${total(pieces)} ${pieces.weapon}/${pieces.armour}/${pieces.jewellery}`.padEnd(14)} | `
                + `${median(buyers.map(b => b.deathHours)).toFixed(3)} (${median(buyers.map(b => b.walk)).toFixed(3)})`.padEnd(14) + ' | '
                + `${Income.fmt(median(buyers.map(b => b.ownHour))).padStart(8)} ${Income.fmt(median(buyers.map(b => b.horizon))).padStart(9)} | `
                + `${FLOORS.map(name => shares(pass[name]).padEnd(22)).join(' | ')} | ${by.worth}/${by.npc}`);
        }
    }
    process.stderr.write(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`);
}

if (require.main === module) main(process.argv.slice(2));
