'use strict';
// The economy model's kit hour is the game's own hunt hour of the kit: a body
// wearing it, its cold profile, the hunt cycle's readers on that body at the
// gear ladder's spots, read without a World or a database. It states the
// hour firing no shots and, per kind of shot the worn weapon fires, the hour
// gross of shots and the shots fired an hour at that weapon's own count per
// action; a decision prices the shots (rules/worth firing).
const assert = require('node:assert/strict');
const os = require('os');

process.chdir(os.tmpdir());
const Boot = require('../scripts/economy-model/boot');
const KitHours = require('../scripts/economy-model/kit-hours');
Boot.boot('x50');

const Table = invoke('GameServer/Bot/AI/SpotValueTable'), HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile'), BotGear = invoke('GameServer/Bot/AI/BotGear');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation'), Data = invoke('GameServer/DataCache');
const ShotStock = invoke('GameServer/Inventory/ShotStock'), Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');
const Grades = require('../src/GameServer/Bot/AI/GearGradeRule');
const DesignIncome = require('../scripts/economy-model/design-income');
const Worth = require('../scripts/economy-model/rules/worth');

const SSNG = 1835, SSD = 1463, SSC = 1464, SSB = 1465, SPSD = 2510, SPSC = 2511, BSPSD = 3948, BSPSC = 3949;
// The anchor the cells are chosen at: a shot's cost from its inputs at NPC prices.
const anchor = { [SSNG]: 8, [SSD]: 7.4, [SSC]: 11.8, [SSB]: 43, [SPSD]: 16.45, [SPSC]: 29.5, [BSPSD]: 41.7, [BSPSC]: 81 };
// Bands of the gear ladder (five levels or fewer, read at the middle): D at 25-29, 30-34 and 35-39, C at 45-49, B at 57-60.
const band = (line, from, to, scale, caster) => ({ from, to, level: Math.floor((from + to) / 2), grade: Grades.gradeForLevel(from), scale, caster,
    best: String(Table.best(line, Math.floor((from + to) / 2), true, 'income')?.spotId) });
const bandsOf = (line, caster, scale = null) => [band(line, 25, 29, scale ?? 0.46, caster), band(line, 30, 34, scale ?? 0.8, caster), band(line, 35, 39, scale ?? 1, caster),
    band(line, 45, 49, scale ?? 1.3, caster), band(line, 57, 60, scale ?? 1.1, caster)];
const fighter = '46', mage = '12', archer = '9';
const stamp = Boot.dataStamp();
const ladder = scale => ({ [fighter]: bandsOf(fighter, false, scale), [mage]: bandsOf(mage, true, scale), [archer]: bandsOf(archer, false, scale) });
const snapshot = { header: { preset: 'x50', ...stamp }, gearLadder: { lines: ladder(null) } };
const kitHours = KitHours.gameKitHours({ snapshot, anchor });
const bandAt = (line, level) => snapshot.gearLadder.lines[line].find(row => level >= row.from && level <= row.to);

// The kit hours read no World and no database.
const kitOf = (line, level) => {
    const classId = Table.roleClass(line, level);
    return Object.fromEntries(BotGear.planFor({ classId, level, characterId: HuntCycle.referenceId(classId, Number(line)) }).items.map(row => [row.slot, row.selfId]));
};
const firstKit = kitOf(fighter, 32);
assert.ok(kitHours.hour(fighter, 32, firstKit).shots[0].gross > 0, 'a fighter\'s own kit earns');
const loaded = Object.keys(require.cache);
assert.ok(!loaded.some(file => /[\\/]World[\\/]World\.js$/.test(file)), 'no World module');
assert.ok(!loaded.some(file => /sqlite|[\\/]Database[\\/]/i.test(file)) && !process.moduleLoadList.some(name => /sqlite/i.test(name)), 'no database module');

const etc = selfId => Index.find(Data.items, selfId).etc;
const weaponOf = kit => Number(kit[7] || kit[14]) || 0;
// The game's own pass, decomposed: a reference bot wearing the kit (firing
// kind: 'none', or the kind its earning answer names), its whole cold
// profile, fresh readers on that body at the best and the ranked spots; per
// cell the reader's hour with its shot bill (the row's shots at the reader's
// price) given back, and the shots at the worn weapon's count per action
// over the count of the table's reference weapon at the level it hunted the
// spot at (item data). The cell taken nets most at price.
function gamePass(line, row, kit, kind, price) {
    const classId = Table.roleClass(line, row.level), base = HuntCycle.referenceState(classId, row.level, { line: Number(line) }), inventory = {};
    for (const [slot, selfId] of KitHours.wornKit(kit)) {
        const key = `kit-${selfId}`, prior = inventory[key], amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId, amount, equipped: true, equippedCount: amount, equippedSlots: [...(prior?.equippedSlots || []), slot], slot };
    }
    let state = { ...base, inventory, stats: { ...base.stats, exp: Data.experience[row.level - 1] } };
    const best = Table.best(line, row.level, true, 'income');
    const deathHours = Valuation.deathHours(state, { expPerHour: best.exp || 0, walkBackHours: DesignIncome.walkBackHours(best.spotId, state) });
    if (kind === 'spiritshot' || kind === 'blessedSpiritshot') state = { ...state, stats: { ...state.stats, earning: { shotKind: kind } } };
    const numbers = KitHours.referenceNumbers(Profile.profileFor(state, 0, { store: false })), plan = ShotStock.planForState(state);
    const shots = ShotStock.shotRows(plan, kind === 'none' ? false : undefined), role = Table.roleFor(state), options = { spoilSkillLevel: Rewards.spoilSkillLevel(state) };
    const field = plan.kind === 'soulshot' ? 'soulshot' : 'spiritshot', charge = kind === 'none' ? 0 : Number(etc(weaponOf(kit))[field]) || 0;
    const costs = Hunt.consumablePrices(state), seen = new Set();
    let out = null;
    for (const spotId of [String(best.spotId), ...Table.rankedIncome(line, row.level).slice(0, 10).map(spot => String(spot.spotId))]) {
        if (seen.has(spotId)) continue;
        const reader = HuntCycle.reader(state, { deathHours, hunt: kind === 'none' ? { spotId, useShots: false } : { spotId } });
        reader.spotIds.forEach((id, index) => {
            if (seen.has(String(id))) return;
            seen.add(String(id));
            const one = reader.hourAt(numbers, index), perKill = shots ? Table.cycle(id, role, row.level, shots, options).shots : 0;
            const refLevel = perKill > 0 ? Table.referenceLevel(id, role, shots) : null, refWeapon = refLevel ? weaponOf(kitOf(line, refLevel)) : 0;
            const refCharge = refWeapon ? Number(etc(refWeapon)[field]) || 0 : 0, raw = one.kills * one.share * perKill;
            const gross = (one.income + raw * costs.shots) * row.scale, units = refCharge > 0 ? raw / refCharge * charge : 0;
            if (!out || gross - units * price > out.net) out = { spotId: String(id), gross, units, raw, refWeapon, refCharge, charge, income: one.income * row.scale, net: gross - units * price, id: plan.selfId };
        });
    }
    return out;
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} against ${expected}`);

// (1) Three lines in two bands, each in the band's reference kit: the hour
// firing none is the game's shotless hour (its readers on the rows without
// shots), and per kind the hour gross of shots less its shots at the anchor
// price is the game's decomposed pass at that price, at the same cell.
for (const line of [fighter, mage, archer]) for (const level of [32, 47]) {
    const row = bandAt(line, level), kit = kitOf(line, row.level), hour = kitHours.hour(line, level, kit);
    near(hour.none, gamePass(line, row, kit, 'none', 0).gross, `line ${line} at ${level}: the shotless hour`);
    assert.deepEqual(hour.shots.map(shot => shot.kind), line === mage ? ['spiritshot', 'blessedSpiritshot'] : ['soulshot'], `line ${line}: the kinds its weapon fires`);
    for (const shot of hour.shots) {
        const game = gamePass(line, row, kit, shot.kind, anchor[shot.id]);
        assert.equal(shot.id, game.id, `line ${line} at ${level}: the ${shot.kind} of its weapon's grade`);
        near(shot.gross - shot.units * anchor[shot.id], game.net, `line ${line} at ${level}, ${shot.kind}: net at the anchor`);
        near(shot.units, game.units, `line ${line} at ${level}, ${shot.kind}: shots an hour`);
    }
}
// Where the worn weapon fires the table's reference count, the kind the game
// fires, priced as the game's reader prices it (its shot price, times the
// band's scale), nets the game's own hour (a scale of 1 and the game's
// prices as the anchor: the same cell).
{
    Pricing.useBoard(() => null);
    const price = id => Pricing.botBuyPrice(id), unit = KitHours.gameKitHours({ snapshot: { header: snapshot.header, gearLadder: { lines: ladder(1) } },
        anchor: Object.fromEntries([SSD, SSC, SPSD, SPSC, BSPSD, BSPSC].map(id => [id, price(id)])) });
    for (const [line, level] of [[fighter, 32], [fighter, 47], [mage, 32]]) {
        const row = band(...[line, bandAt(line, level).from, bandAt(line, level).to, 1, line === mage]), kit = kitOf(line, row.level);
        const own = ShotStock.planForState({ ...HuntCycle.referenceState(Table.roleClass(line, row.level), row.level, { line: Number(line) }), inventory: Object.fromEntries(KitHours.wornKit(kit).map(([slot, selfId]) => [`kit-${selfId}`, { selfId, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [slot], slot }])) });
        const game = gamePass(line, row, kit, own.kind, price(own.selfId)), shot = unit.hour(line, level, kit).shots.find(entry => entry.id === own.selfId);
        assert.equal(game.charge, game.refCharge, `line ${line} at ${level}: the reference count`);
        near(shot.gross - shot.units * price(own.selfId), game.income, `line ${line} at ${level}: the game's own hour`);
    }
}

// (2) A C two-handed sword (Flamberge, 2 soulshots a shot) in the B band at
// 57-60 over the band's B kit, whose table hunted at B levels with a B sword
// (1 a shot): its shots an hour are its own count, twice what the reader's
// row counts at the cell.
{
    const row = bandAt(fighter, 58), bKit = kitOf(fighter, row.level), flamberge = Number(kitOf(fighter, 47)[14]), cKit = { ...bKit, 7: 0, 14: flamberge };
    const shot = kitHours.hour(fighter, 58, cKit).shots[0], game = gamePass(fighter, row, cKit, 'soulshot', anchor[SSC]), gradeOf = invoke('GameServer/Items/C4EnchantRules').gradeOf;
    assert.deepEqual([gradeOf(etc(flamberge)), etc(flamberge).soulshot, gradeOf(etc(game.refWeapon)), game.refCharge], ['C', 2, 'B', 1],
        'Flamberge fires 2 a shot, the table\'s B sword 1');
    assert.equal(shot.id, SSC, 'a C weapon fires C soulshots');
    near(shot.units, 2 * game.raw, 'its shots an hour: twice the row\'s');
    near(shot.gross - shot.units * anchor[SSC], game.net, 'net at the anchor');
    assert.equal(kitHours.shotScale(fighter, 58, game.spotId, flamberge), 2, 'and at that spot row');
}

// (2b) The hour against game owners the service does not compute with.
// A reference bot of the row's level wearing the kit, as the game states it.
const stateIn = (line, row, kit) => {
    const classId = Table.roleClass(line, row.level), base = HuntCycle.referenceState(classId, row.level, { line: Number(line) }), inventory = {};
    for (const [slot, selfId] of KitHours.wornKit(kit)) {
        const key = `kit-${selfId}`, prior = inventory[key], amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId, amount, equipped: true, equippedCount: amount, equippedSlots: [...(prior?.equippedSlots || []), slot], slot };
    }
    return { ...base, inventory, stats: { ...base.stats, exp: Data.experience[row.level - 1] } };
};
// The shots a cold bot in the kit spends per action: what a fight debits from
// its stock at each charge (ColdCombatProfile.shotSupply, read by
// BackgroundResolver.spendColdShot), its bag holding plenty of the shot.
const spentPerAction = (line, row, kit) => {
    const state = stateIn(line, row, kit), plan = ShotStock.combatPlanForState(state);
    return Profile.shotSupply({ ...state, inventory: { ...state.inventory, [String(plan.selfId)]: { selfId: plan.selfId, amount: 100000 } } }, 1e9).perAction;
};
const within = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${message}: ${actual} against ${expected}`);

// (a) At a line's reference kit the shots an hour of a cell are the spot
// table's row for that spot (the row's shots, at the reference weapon's
// count, which the reference kit wears): the units the service states for
// each plain shot match the table's shots of one spot of the line's ranking.
// (A Blessed Spiritshot row is counted at its own reference weapon: not
// compared here.)
for (const line of [fighter, mage, archer]) for (const level of [32, 47]) {
    const row = bandAt(line, level), kit = kitOf(line, row.level), hour = kitHours.hour(line, level, kit), state = stateIn(line, row, kit);
    const role = Table.roleFor(state), options = { spoilSkillLevel: Rewards.spoilSkillLevel(state) };
    const spots = [String(Table.best(line, row.level, true, 'income').spotId), ...Table.rankedIncome(line, row.level).slice(0, KitHours.TOP_SPOTS).map(spot => String(spot.spotId))];
    for (const shot of hour.shots.filter(entry => entry.kind !== 'blessedSpiritshot')) {
        const rows = spots.map(spotId => Table.value(spotId, role, row.level, true, options)?.shots).filter(Number.isFinite);
        const miss = Math.min(...rows.map(value => Math.abs(shot.units - value) / Math.max(1, value)));
        assert.ok(miss <= 1e-9, `line ${line} at ${level}, ${shot.kind}: ${shot.units} shots an hour, the table's rows ${rows.join(', ')}`);
    }
}

// (b) A reference kit's net hour at the game's own prices and scale 1 is the
// hunt cycle's reader's hour of the reference state (the spot a reader hunts
// is its hunt's: HuntCycle.reader, hourAt), the best of the line's ranked
// spots. Where the worn weapon fires the count the table's reference weapons
// did at every spot, the two are equal; where it fires another count at
// some, the service charges the worn weapon's own count (as a fight spends
// it): it equals the reader's best hour with each row's shots at that count.
{
    Pricing.useBoard(() => null);
    const price = id => Pricing.botBuyPrice(id), unit = KitHours.gameKitHours({ snapshot: { header: snapshot.header, gearLadder: { lines: ladder(1) } },
        anchor: Object.fromEntries([SSD, SSC, SPSD, SPSC, BSPSD, BSPSC].map(id => [id, price(id)])) });
    let exact = 0;
    for (const [line, level] of [[fighter, 32], [fighter, 47], [mage, 32], [mage, 47], [archer, 32], [archer, 47]]) {
        const row = bandAt(line, level), kit = kitOf(line, row.level), state = stateIn(line, row, kit), own = ShotStock.planForState(state), best = Table.best(line, row.level, true, 'income');
        const deathHours = Valuation.deathHours(state, { expPerHour: best.exp || 0, walkBackHours: DesignIncome.walkBackHours(best.spotId, state) });
        const numbers = KitHours.referenceNumbers(Profile.profileFor(state, 0, { store: false }));
        const spots = [String(best.spotId), ...Table.rankedIncome(line, row.level).slice(0, KitHours.TOP_SPOTS).map(spot => String(spot.spotId))];
        const shot = unit.hour(line, level, kit).shots.find(entry => entry.id === own.selfId), net = shot.gross - shot.units * price(own.selfId);
        const role = Table.roleFor(state), shotRows = ShotStock.shotRows(own), count = spentPerAction(line, row, kit), options = { spoilSkillLevel: Rewards.spoilSkillLevel(state) };
        // Per spot: the reader's hour, and that hour with the row's shots
        // charged at the worn weapon's count over the row's reference weapon's.
        let game = { income: -Infinity }, charged = -Infinity, same = true;
        for (const spotId of spots) {
            const reader = HuntCycle.reader(state, { deathHours, hunt: { spotId } }), income = reader.hourAt(numbers, reader.spotIds.indexOf(spotId)).income;
            if (income > game.income) game = { income, spotId };
            const refLevel = Table.referenceLevel(spotId, role, shotRows), refCount = refLevel ? spentPerAction(line, row, kitOf(line, refLevel)) : count;
            if (refCount !== count) same = false;
            charged = Math.max(charged, income + (Table.value(spotId, role, row.level, true, options)?.shots || 0) * price(own.selfId) * (1 - count / refCount));
        }
        if (same) { exact++; within(net, game.income, 1e-9, `line ${line} at ${level}: the reader's best hour (spot ${game.spotId})`); }
        else within(net, charged, 1e-9, `line ${line} at ${level}: the worn weapon fires ${count} a shot: the reader's best hour with each row's shots at that count (the reader's own best ${game.income})`);
    }
    assert.ok(exact >= 3, `the reader's hour is met exactly on ${exact} of the six cases`);
    // A shot the anchor has no price for is no option of the hour.
    const unpriced = KitHours.gameKitHours({ snapshot: { header: snapshot.header, gearLadder: { lines: ladder(1) } }, anchor: {} });
    assert.deepEqual(unpriced.hour(fighter, 32, kitOf(fighter, bandAt(fighter, 32).level)).shots, [], 'no price at the anchor: the kit states no shot');
}

// (c) A weapon that fires more than one shot an action (Flamberge, 2; the
// table's B sword, 1) in the B band: the shots the service states an hour per
// shot the hunt's rows count (the kills' shots at a cell: the reader's kills
// and the table's shots per kill) are the ratio of the count a fight spends
// per action with that weapon over the count with the table's reference weapon.
{
    const row = bandAt(fighter, 58), bKit = kitOf(fighter, row.level), flamberge = Number(kitOf(fighter, 47)[14]), cKit = { ...bKit, 7: 0, 14: flamberge };
    const counts = [spentPerAction(fighter, row, bKit), spentPerAction(fighter, row, cKit)];
    assert.deepEqual(counts, [1, 2], 'a fight spends one a shot with the B sword and two with Flamberge');
    const perRow = kit => {
        const game = gamePass(fighter, row, kit, 'soulshot', anchor[SSC]), hour = kitHours.hour(fighter, 58, kit).shots[0];
        const refKit = { ...kitOf(fighter, Table.referenceLevel(game.spotId, Table.roleFor(stateIn(fighter, row, kit)), true)) };
        return hour.units / game.raw / (spentPerAction(fighter, row, kit) / spentPerAction(fighter, row, refKit));
    };
    within(perRow(bKit), 1, 1e-9, 'with the B sword: the units over the rows\' shots at the count ratio');
    within(perRow(cKit), 1, 1e-9, 'with Flamberge: the units over the rows\' shots at the count ratio');
}


// (3) A level-27 fighter: its D two-handed sword firing D soulshots against
// its no-grade weapon firing no-grade soulshots (8 a shot). At 7.4 a D shot
// (its inputs) the D weapon nets more; at 500 (the game's x50 price) firing D
// shots nets less, and the main fires none with it then.
{
    const dKit = kitOf(fighter, 27), plain = kitOf(fighter, 19), hand = kit => (kit[14] ? 14 : 7), ngKit = { ...dKit, 7: 0, 14: 0, [hand(plain)]: plain[hand(plain)] };
    const d = kitHours.hour(fighter, 27, dKit), ng = kitHours.hour(fighter, 27, ngKit);
    assert.deepEqual([d.shots[0].id, ng.shots[0].id], [SSD, SSNG], 'D and no-grade soulshots');
    const ngNet = Worth.firing(ng, () => 8), dShots = price => d.shots[0].gross - d.shots[0].units * price;
    assert.equal(ngNet.id, SSNG, 'the no-grade weapon fires its shots');
    assert.ok(dShots(7.4) > ngNet.net, `at 7.4: ${dShots(7.4)} against ${ngNet.net}`);
    assert.ok(dShots(500) < ngNet.net, `at 500: ${dShots(500)} against ${ngNet.net}`);
    assert.equal(Worth.firing(d, id => (id === SSD ? 500 : 8)).id, 0, 'at 500 it fires none');
}

// (4) A caster (line 12 at 47 in its Paradia staff): Blessed Spiritshot C or
// Spiritshot C by what nets more at the prices given; its worth is the most
// a shot of that kind may cost and stay chosen; a kit row's net (the worth
// of a piece reads it) is the same answer's.
{
    const hour = kitHours.hour(mage, 47, kitOf(mage, 47)), [spirit, blessed] = hour.shots;
    const at = (plainPrice, blessedPrice) => Worth.firing(hour, id => (id === SPSC ? plainPrice : id === BSPSC ? blessedPrice : null));
    const cheap = at(29.5, 81), dear = at(29.5, 2 * cheap.worth);
    assert.deepEqual([cheap.id, dear.id], [BSPSC, SPSC], `blessed at 81, plain at ${2 * cheap.worth}`);
    near(cheap.net, blessed.gross - blessed.units * 81, 'the blessed net');
    near(cheap.worth, (blessed.gross - Math.max(hour.none, spirit.gross - spirit.units * 29.5)) / blessed.units, 'its worth against the plain kind');
    assert.ok(at(29.5, cheap.worth - 1).id === BSPSC && at(29.5, cheap.worth + 1).id === SPSC, 'at its worth the choice turns');
    assert.equal(Worth.netRow({ hour, gear: 0 }, id => (id === SPSC ? 29.5 : 2 * cheap.worth)).hour, dear.net, 'a kit row nets the same answer');
    // The hunt's count of each kind is the hour's: at the kind's cell the
    // row's shots times the weapon's scale (the blessed row's own reference
    // count for Blessed Spiritshots) are the units the hour states.
    const row = bandAt(mage, 47), kit = kitOf(mage, row.level), weapon = weaponOf(kit);
    for (const shot of hour.shots) {
        const game = gamePass(mage, row, kit, shot.kind, anchor[shot.id]);
        near(game.raw * kitHours.shotScale(mage, 47, game.spotId, weapon, shot.kind === 'blessedSpiritshot'), shot.units, `${shot.kind}: the hunt's count at the cell`);
    }
}

// (5) A kit's hour carries no shot price: a price that changes moves the
// decision's net, not the hour.
{
    const read = kitHours.swaps(fighter, 47, kitOf(fighter, 47), [{ slot: 6, selfId: kitOf(fighter, 44)[6] }]);
    const nets = [11.8, 150].map(price => Worth.firing(read.hour, () => price).net);
    assert.ok(nets[0] > nets[1], `the net at 11.8 ${nets[0]}, at 150 ${nets[1]}`);
    assert.deepEqual(kitHours.hour(fighter, 47, kitOf(fighter, 47)), read.hour, 'the same hour');
}

// (6) A main of line 46 at 46 in the kit of 39 still earns.
const late = kitOf(fighter, 39);
assert.ok(kitHours.hour(fighter, 46, late).none > 0, 'the kit of 39 at 46 earns');

// (7) A full armour takes off chest and legs; a two-handed weapon the shield.
const reference = kitOf(fighter, 47), fullPlate = 356, shield = 625;
assert.equal(Number(reference[14]) > 0, true, 'the fighter\'s kit of 47 holds a two-handed weapon');
const { 10: chest, 11: legs, ...bare } = reference;
assert.ok(chest && legs, 'and a chest and legs');
assert.deepEqual(kitHours.hour(fighter, 47, { ...reference, 15: fullPlate }), kitHours.hour(fighter, 47, { ...bare, 15: fullPlate }), 'chest and legs under a full armour');
assert.deepEqual(kitHours.hour(fighter, 47, { ...reference, 8: shield }), kitHours.hour(fighter, 47, reference), 'a shield beside a two-handed weapon');
// Bare hands fire no shots.
assert.deepEqual(kitHours.hour(fighter, 47, { ...reference, 14: 0 }).shots, [], 'no weapon, no shots');

// (8) swaps reads the kit with each piece put on as hour() reads that kit:
// another weapon (the shield comes off under a two-handed one), a chest of
// another armour kind, a helmet into an empty slot (valued against the kit
// without one), an earring into the second ear, and the piece already worn.
const mixed = { ...kitOf(fighter, 44), 6: 0 }, pieces = [{ slot: 7, selfId: kitOf(fighter, 19)[7] }, { slot: 8, selfId: kitOf(fighter, 19)[8] },
    { slot: 10, selfId: kitOf(mage, 44)[10] }, { slot: 6, selfId: kitOf(fighter, 47)[6] }, { slot: 2, selfId: kitOf(fighter, 19)[1] }, { slot: 14, selfId: mixed[14] }];
const read = kitHours.swaps(fighter, 46, mixed, pieces);
assert.deepEqual(read.hour, kitHours.hour(fighter, 46, mixed), 'the worn kit');
pieces.forEach(({ slot, selfId }, at) => {
    const next = Object.fromEntries([...KitHours.wornKit(mixed).filter(([worn]) => !Worth.slotsConflict(slot, worn)), [slot, selfId]]);
    assert.deepEqual(read.swaps[at].hour, kitHours.hour(fighter, 46, next), `${selfId} in slot ${slot}`);
});
assert.equal(read.swaps[5].hour, read.hour, 'the piece worn: the worn kit\'s hour');

// (9) A level-30 fighter in a no-grade weapon and shield and D armour values
// the D two-handed sword by what it adds to that kit, not to the grade's
// entry kit (all no-grade), each firing what nets most at the anchor prices.
{
    const entry = kitOf(fighter, 19), dKit = kitOf(fighter, 30), worn = { ...dKit, 14: 0, 7: entry[7], 8: entry[8] }, sword = [{ slot: 14, selfId: dKit[14] }];
    const net = hour => Worth.firing(hour, id => anchor[id]).net;
    const gain = kit => { const out = kitHours.swaps(fighter, 30, kit, sword); return net(out.swaps[0].hour) - net(out.hour); };
    const own = gain(worn), atEntry = gain(entry);
    assert.ok(own > 0 && atEntry > 0 && Math.abs(own - atEntry) > 0.03 * atEntry, `over its kit ${own}, over the entry kit ${atEntry}`);
}

// (10) A robe wearer at 39 (the Knowledge robes of its kit) loses its hour
// to a heavy breastplate: its robe passives end with the robe, though the
// plate's P.Def alone suggests a gain (its gear gain times the worn hour).
{
    const robes = kitOf(mage, 39), read = kitHours.swaps(mage, 39, robes, [{ slot: 10, selfId: 58 }]), rows = Worth.swapRows(read), priceOf = id => anchor[id];
    const worn = Worth.netRow(rows.worn, priceOf), plate = Worth.netRow(rows.rows[0], priceOf);
    const gain = plate.hour - worn.hour, byStats = plate.gear * worn.hour;
    assert.ok(gain < 0 && byStats > 0, `the plate on robes: ${gain} an hour, its P.Def alone ${byStats}`);
}

// (11) A piece above the band's grade: no hour stated, alone or put on.
assert.equal(kitHours.hour(fighter, 32, { ...firstKit, 15: fullPlate }), null, 'a C full armour in the D band');
assert.equal(kitHours.hour(fighter, 32, { ...firstKit, 9: 999999 }), null, 'an item without a template');
assert.equal(kitHours.swaps(fighter, 32, firstKit, [{ slot: 15, selfId: fullPlate }]).swaps[0].hour, null, 'put on over a D kit');
assert.deepEqual(kitHours.swaps(fighter, 32, { ...firstKit, 15: fullPlate }, [{ slot: 6, selfId: firstKit[6] }]).swaps.map(swap => swap.hour), [null], 'over a kit not stated');

// (12) Another game's snapshot is refused.
assert.throws(() => KitHours.gameKitHours({ snapshot: { ...snapshot, header: { ...snapshot.header, fingerprint: 'other' } }, anchor }), /fingerprint other is not the live game data's/);

// (13) The anchor is required; a snapshot without the extra files stamp is refused.
assert.throws(() => KitHours.gameKitHours({ snapshot }), /anchor .* required/);
assert.throws(() => KitHours.gameKitHours({ snapshot: { ...snapshot, header: { ...snapshot.header, extraFiles: undefined } }, anchor }), /no extraFiles stamp/);
assert.throws(() => KitHours.gameKitHours({ snapshot: { ...snapshot, header: { ...snapshot.header, extraFiles: 'other' } }, anchor }), /extraFiles other is not the live/);

// (14) A band's best spot must be the live one.
const wrongBest = { ...snapshot, gearLadder: { lines: { ...snapshot.gearLadder.lines, [fighter]: snapshot.gearLadder.lines[fighter].map(row => ({ ...row, best: '1' })) } } };
assert.throws(() => KitHours.gameKitHours({ snapshot: wrongBest, anchor }).hour(fighter, 32, firstKit), new RegExp(`line ${fighter} band 1 .*best spot 1 in the snapshot`));

// (15) The cell is chosen at the anchor price: at x1 a line 8 body at level 27
// fires fewer shots at a spot that nets more once the shot costs its price.
// Last: it boots x1.
{
    const line = '8', level = 27, x1 = { header: { preset: 'x1' }, gearLadder: { lines: {} } };
    Boot.boot('x1');
    Object.assign(x1.header, Boot.dataStamp());
    x1.gearLadder.lines[line] = [band(line, 25, 29, 1, false)];
    const classId = Table.roleClass(line, level);
    const kit = Object.fromEntries(BotGear.planFor({ classId, level, characterId: HuntCycle.referenceId(classId, Number(line)) }).items.map(row => [row.slot, row.selfId]));
    const priced = KitHours.gameKitHours({ snapshot: x1, anchor }).hour(line, level, kit).shots[0];
    const free = KitHours.gameKitHours({ snapshot: x1, anchor: Object.fromEntries(Object.keys(anchor).map(id => [id, 0])) }).hour(line, level, kit).shots[0];
    assert.ok(priced.units < free.units && priced.gross < free.gross, 'priced shots choose a cell that fires fewer shots');
}
console.log('PASS economy model kit hours');
