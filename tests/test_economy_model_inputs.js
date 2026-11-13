'use strict';
// The economy model's game-data snapshot carries the server's own numbers:
// a spot hour as the spot table gives it, and per-item yields that price to
// the spot value's drop and spoil money per kill.
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Started from another folder, the snapshot still finds the recipe data
// (read relative to the working directory).
process.chdir(os.tmpdir());
const Boot = require('../scripts/economy-model/boot');
const Inputs = require('../scripts/economy-model/inputs');
Boot.boot('x50');

const line = '55', level = 30;
const caster = '12';
const snapshot = Inputs.extract({ preset: 'x50', lines: [line, '2', caster], levels: [level, level] });
assert.equal(snapshot.header.rates.drop, 50, 'the preset\'s rates');
assert.ok(snapshot.recipes.length > 700, 'recipes are read wherever the script starts');
const ssd = snapshot.recipes.find(row => row.productId === 1463);
assert.equal(ssd.productCount / ssd.mpCost, 3.9);

const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const hour = snapshot.hours[line][level];
const best = Table.best(line, level, true, 'income');
for (const field of Inputs.HOUR_FIELDS) assert.equal(hour.best[field], best[field], `best ${field}`);
const ranked = Table.rankedIncome(line, level);
assert.equal(hour.top.length, 10, 'the ten spots an occupation ranks');
hour.top.forEach((row, i) => assert.equal(row.spotId, ranked[i].spotId, `top ${i} is the ranked income's`));
assert.equal(hour.top[0].adena, ranked[0].adena);
assert.equal(hour.shotId, 1463, 'a Bounty Hunter at 30 fires Soulshot D');
assert.ok(snapshot.kits[line][level].length > 0, 'the reference kit');

// Each spot a main may hold carries the levels the spot table has a row for
// the line there (spot_left fires outside them); the rows outside the top
// are spots it may keep or rank for a shot recipe's scroll, never a top spot.
const ranges = snapshot.spotLevels[line];
for (const row of hour.top) {
    const [low, high] = ranges[String(row.spotId)];
    assert.ok(low <= level && level <= high, `top spot ${row.spotId} in its range ${low}-${high}`);
    assert.ok(Table.value(String(row.spotId), line, low, true)?.kills > 0 && !(Table.value(String(row.spotId), line, high + 1, true)?.kills > 0), `${row.spotId}: the table's own rows bound the range`);
}
const ssdScroll = 1804;
for (const row of hour.others || []) {
    assert.ok(!hour.top.some(top => top.spotId === row.spotId), `${row.spotId} is not a top spot`);
    assert.ok(row.scrolls === undefined || row.scrolls.every(id => snapshot.recipes.some(recipe => recipe.recipeItemId === id && snapshot.items[recipe.productId]?.kind === 'Other.Shot')), 'scrolls named are shot recipes\' scrolls');
}
const low = Inputs.extract({ preset: 'x50', lines: [line], levels: [22, 22] });
assert.ok((low.hours[line][22].others || []).some(row => row.scrolls?.includes(ssdScroll)), 'at 22 a spot that yields the Soulshot D recipe is a candidate outside the top');

// Spot value (SpotRewardExpectation) against the snapshot's per-item yields at the npcBuy price.
const Rewards = invoke('GameServer/Bot/Economy/SpotRewardExpectation');
const spots = Inputs.rewardSpots();
const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} against ${b}`);
const keys = Object.keys(snapshot.yields);
assert.ok(keys.length >= 3, 'yields for the spots of the hour');
let spoiled = 0;
for (const key of keys) {
    const row = snapshot.yields[key];
    const value = Rewards.value(spots.get(row.spotId), row.level, { spoilSkillLevel: row.spoilSkill });
    const priced = yields => Object.entries(yields).reduce((sum, [id, count]) => sum + (Number(id) === 57 ? 0 : count * snapshot.items[id].npcBuy), 0);
    close(priced(row.drop), value.drop, `${key} drop money per kill`);
    close(priced(row.spoil), value.spoil, `${key} spoil money per kill`);
    if (snapshot.compositions[row.spotId].npcs.every(npc => npc.rewardId !== null)) close(row.drop[57] || 0, value.adena, `${key} adena per kill`);
    if (value.spoil > 0) spoiled++;
}
assert.ok(spoiled > 0, 'a Bounty Hunter spoils at its spots');

// Every line carries the Spoil level the spot table gives it, not the Bounty
// Hunter's alone: line 57 at level 30 spoils exactly as the table says.
const other = Inputs.extract({ preset: 'x50', lines: ['57'], levels: [30, 30] });
const owed = Table.roleSpoilLevel('57', 30);
assert.ok(owed > 0, 'the table gives line 57 a Spoil level at 30');
const spoilers = Object.values(other.yields).filter(row => row.spoilSkill === owed);
assert.ok(spoilers.length > 0, 'its spots are priced at that Spoil level');
assert.ok(spoilers.some(row => Object.keys(row.spoil).length > 0), 'and carry spoil yields');

// Rates move the yields: a group item at x50 against x1.
const x1 = Inputs.extract({ preset: 'x1', lines: [line], levels: [level, level] });
const key = keys.find(k => x1.yields[k]);
assert.ok(Object.values(snapshot.yields[key].drop).reduce((a, b) => a + b, 0)
    > Object.values(x1.yields[key].drop).reduce((a, b) => a + b, 0), 'more items per kill at x50');
assert.deepEqual(snapshot.npcOffers.x1[1785], x1.npcOffers.preset[1785], 'NPC offers at x1 in every snapshot');
assert.ok(snapshot.npcOffers.preset[1785][0].price > 2 * x1.npcOffers.preset[1785][0].price, 'and today\'s x50 NPC prices scaled up');

// The design mode's additions, each the owner's own number: the hour without
// shots, a twin's max MP and store slots, a line's race, the crystal ids and
// the per-kill yields at the design's rates.
Boot.usePreset('x50');
const bare = Table.value(String(hour.best.spotId), line, level, false);
for (const field of Inputs.SHOTLESS_FIELDS) assert.equal(hour.best.shotless[field], bare[field], `shotless ${field}`);
assert.ok(hour.best.shotless.kills < hour.best.kills, 'fewer kills without shots');
// A line that fires spiritshots carries each row's hour firing Blessed
// Spiritshots (the spot table's with shots 2); a soulshot line has none.
const rowsOf = at => [at.best, ...at.top, ...(at.others || [])].filter(Boolean);
const casterRows = rowsOf(snapshot.hours[caster][level]);
assert.ok(casterRows.length > 1, 'the caster\'s rows');
for (const row of casterRows) {
    const blessed = Table.value(String(row.spotId), caster, level, 2);
    assert.deepEqual(row.blessed, Object.fromEntries(Inputs.BLESSED_FIELDS.map(field => [field, blessed[field]])), `${row.spotId}: the blessed hour`);
}
assert.ok(casterRows.some(row => row.blessed.exp > row.exp && row.blessed.adena > row.adena), 'blessed shots earn and level faster at some spot');
for (const other of [line, '2']) assert.ok(rowsOf(snapshot.hours[other][level]).every(row => !('blessed' in row)), `line ${other} fires soulshots: no blessed hour`);
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
assert.equal(snapshot.twins[30].maxMp, Profile.profileFor({ level: 30, stats: { classId: 56 } }, 0).maxMp, 'an Artisan at 30');
assert.equal(snapshot.twins[55].classId, 57, 'a Warsmith from 40');
assert.deepEqual(snapshot.twins[30].storeSlots, { sell: 4, buy: 5 }, 'a dwarf\'s store slots');
assert.equal(snapshot.twins[10].createItem, 1, 'twins below 20 are read too');
assert.equal(snapshot.races['55'], 4, 'a Bounty Hunter is a dwarf');
assert.equal(snapshot.crystalIds.D, 1458);
const DesignIncome = require('../scripts/economy-model/design-income');
const Load = require('../scripts/economy-model/load');
const { DESIGN_RATES } = require('../scripts/economy-model/rules/dropRule');
const designKey = keys[0], designRow = snapshot.yields[designKey];
assert.deepEqual(snapshot.yieldsDesign[designKey], DesignIncome.designYields(snapshot, designRow.spotId, designRow.level, designRow.spoilSkill, DESIGN_RATES.x50, DesignIncome.gameRules()),
    'the design yields are the drop rule at the design\'s x50 rates');
const designAtX1 = DesignIncome.designYields(snapshot, designRow.spotId, designRow.level, designRow.spoilSkill, DESIGN_RATES.x1, DesignIncome.gameRules());
assert.ok(Math.abs(snapshot.yieldsDesign[designKey].drop[57] / (DESIGN_RATES.x50.adena * designAtX1.drop[57]) - 1) < 1e-9, 'design adena at x50 is the adena rate times its x1 yield');

// The market's additions, each the owner's own number: a line's bag slots
// and max load, the walk back from a spot, each top spot's hour without
// shots and the C and D crystals a Luxury row takes.
const Inventory = require('../src/GameServer/Inventory/InventoryLimits');
const Formulas = invoke('GameServer/Formulas');
assert.deepEqual(snapshot.bags[line], { race: 4, slots: Inventory.capacity(4, 0), maxLoad: Math.round(Formulas.calcMaxLoad(45)) }, 'a dwarf\'s 100 slots and the CON 45 load');
assert.equal(snapshot.walkBack[hour.best.spotId], Load.walkBackHours(hour.best.spotId, {}));
assert.ok(snapshot.walkBack[hour.best.spotId] > 0, 'a spot with a center has a walk back');

// A trip's hours are the game's cold trip (ColdTrip, no Scroll of Escape
// held): from a spot's centre into its town, from every town back to the
// centre, and from town to town; every spot and every town is present.
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip'), townRows = Object.values(invoke('GameServer/World/TownRespawn').towns);
const townPoint = town => ({ locX: town.locX, locY: town.locY, locZ: town.locZ }), planHours = plan => plan.durationMs / 3600000;
assert.ok(snapshot.tripHours && snapshot.townHours, 'the snapshot carries the game\'s trip hours');
assert.deepEqual(Object.keys(snapshot.tripHours.to).sort(), Object.keys(snapshot.compositions).sort(), 'every spot has its trip into town');
for (const id of Object.keys(snapshot.compositions)) assert.deepEqual(Object.keys(snapshot.tripHours.back[id]).sort(), townRows.map(town => town.name).sort(), `spot ${id} has a way back from every town`);
{
    const cardRows = require('../data/Bots/hunt/spots.json'), centerAt = cardRows.spotFields.indexOf('center'), cardTownAt = cardRows.spotFields.indexOf('town');
    const sampled = [String(hour.best.spotId), String(cardRows.spots.find(row => row[cardTownAt] === 'Floran Village')[0]), String(cardRows.spots[cardRows.spots.length - 1][0])];
    for (const id of sampled) {
        const row = cardRows.spots.find(card => String(card[0]) === id), center = { locX: row[centerAt][0], locY: row[centerAt][1], locZ: row[centerAt][2] };
        const into = townRows.find(town => town.name === row[cardTownAt]);
        assert.equal(snapshot.tripHours.to[id], planHours(ColdTrip.townPlan({ loc: center, stats: {}, inventory: {} }, townPoint(into))), `spot ${id}: the trip into ${into.name} is ColdTrip's`);
        for (const town of townRows) assert.equal(snapshot.tripHours.back[id][town.name], planHours(ColdTrip.spotPlan({ loc: townPoint(town), stats: {} }, center)), `spot ${id}: the way back from ${town.name} is ColdTrip's`);
    }
}
for (const from of townRows) for (const into of townRows) {
    assert.equal(snapshot.townHours[from.name][into.name], planHours(ColdTrip.townPlan({ loc: townPoint(from), stats: {}, inventory: {} }, townPoint(into))), `${from.name} to ${into.name} is ColdTrip's`);
}
assert.ok(snapshot.townHours.Dion.Giran > 0 && snapshot.tripHours.to[hour.best.spotId] > 0, 'a trip takes time');
const topBare = Table.value(String(hour.top[9].spotId), line, level, false);
assert.equal(hour.top[9].shotless?.kills ?? null, topBare && topBare.kills > 0 ? topBare.kills : null, 'the tenth spot carries its hour without shots');
assert.deepEqual(snapshot.luxuryOptions[71], { npcId: 7097, town: 'Giran', crystals: [{ selfId: 1459, amount: 573 }, { selfId: 1458, amount: 2865 }] }, 'Flamberge for 573 C and 2865 D crystals together');
assert.ok(!('luxury' in snapshot) && !('upkeep' in snapshot), 'one Luxury catalogue (luxuryOptions) and no servitor upkeep in the snapshot');

// The gear ladder: a Scavenger's (the Bounty Hunter at 30) band 30-34 holds
// the gear table's D weapon rungs and the no-grade ones below, none above D,
// its best spot, its scale to the design's money; a kit's hours are read
// through kit-hours.js, not stored.
const name = id => snapshot.items[id]?.name;
const band = snapshot.gearLadder.lines[line];
assert.deepEqual(band.map(row => [row.from, row.to, row.level, row.grade]), [[30, 34, 32, 'd']], 'the band of the levels asked, read at its middle');
const weapons = band[0].rungs.weapon, club = weapons.find(id => name(id) === 'Spiked Club');
for (const wanted of ['Hand Axe', 'Tomahawk', 'Spiked Club']) assert.ok(weapons.some(id => name(id) === wanted), `${wanted} is a rung`);
assert.ok(weapons.every(id => ['D', 'NONE'].includes(snapshot.items[id].grade)), 'no rung above the band\'s grade');
assert.equal(band[0].best, String(Table.best(line, 32, true, 'income').spotId), 'the band\'s best spot');
assert.ok(band[0].scale > 0 && band[0].scale < 1, `x50 design money under today's: ${band[0].scale}`);
assert.ok(!('hour' in band[0]) && !('gear' in band[0]), 'no kit hour stored');
assert.equal(snapshot.gearLadder.slots[club], 7, 'a rung\'s own slot');

// The trade towns are the game's own (MarketTownPolicy): C and above in
// Giran, D in either D market, a no-grade lot in the starter-village market
// nearest the spot card's centre (a Talking Island spot sells there), and
// at least four of the five villages over the spots.
const villages = ['Talking Island', 'Elven Village', 'Dark Elven Village', 'Orc Village', 'Dwarven Village'];
assert.equal(snapshot.tradeTowns.higher, 'Giran');
assert.deepEqual(snapshot.tradeTowns.d, ['Gludio', 'Dion']);
assert.equal(snapshot.tradeTowns.grade[1463], 'd');
const cards = require('../data/Bots/hunt/spots.json'), townAt = cards.spotFields.indexOf('town'), minAt = cards.spotFields.indexOf('minLevel');
const island = cards.spots.find(row => row[townAt] === 'Talking Island' && row[minAt] <= 5);
assert.equal(snapshot.tradeTowns.none[String(island[0])], 'Talking Island', `${island[0]} sells in Talking Island`);
const markets = new Set(Object.values(snapshot.tradeTowns.none));
assert.ok([...markets].every(town => villages.includes(town)) && markets.size >= 4, [...markets].join(', '));

// The arrow of each bow grade, as the game's arrow stock names it.
const ArrowStock = invoke('GameServer/Inventory/ArrowStock');
assert.deepEqual(snapshot.arrowIds, { ...ArrowStock.BY_RANK });
assert.equal(snapshot.arrowIds.d, 1341, 'Bone Arrow for a D bow');
assert.equal(snapshot.items[1341]?.name, 'Bone Arrow', 'the arrows ride in items');

// A run reads the snapshot of the live game data, never the newest file. Its
// stamp holds every tree file the extract loaded: the fares, static stores,
// craft eligibility, store slots, bags, market towns, Luxury lists, raid
// safety and inputs.js itself. An edit to one refuses the old snapshot, with
// the command that builds one, in every mode that reads a snapshot.
{
    const loaded = Boot.loadedFiles();
    for (const file of ['src/GameServer/Bot/MerchantStoreConfigs.js', 'src/GameServer/Bot/Economy/CraftEligibility.js', 'src/GameServer/PrivateStoreLimits.js',
        'src/GameServer/Inventory/InventoryLimits.js', 'src/GameServer/Bot/Economy/MarketTownPolicy.js', 'src/GameServer/Bot/Economy/MarketCounters.js',
        'src/GameServer/Bot/Travel/TravelRoutes.js', 'src/GameServer/World/Generics/NpcExchangeShopLists.js', 'src/GameServer/Bot/AI/BotRaidSafety.js',
        'scripts/economy-model/inputs.js']) assert.ok(loaded.includes(file), `the stamp holds ${file}`);
    // The fares in a temp copy inside the tree, one of the snapshot's files.
    fs.mkdirSync(path.join(Boot.root, 'tmp'), { recursive: true });
    const scratch = fs.mkdtempSync(path.join(Boot.root, 'tmp', 'economy-stamp-')), dir = path.join(scratch, 'snapshots');
    fs.mkdirSync(dir);
    const fares = path.join(scratch, 'TravelRoutes.js');
    fs.copyFileSync(path.join(Boot.root, 'src/GameServer/Bot/Travel/TravelRoutes.js'), fares);
    const files = [...loaded, path.relative(Boot.root, fares).split(path.sep).join('/')];
    const write = (name, mtime) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify({ header: { preset: 'x50', ...Boot.dataStamp(files), sourceFiles: files } }));
        fs.utimesSync(file, mtime, mtime);
        return file;
    };
    try {
        // inputs.js builds the header: the stamp of a built x1 snapshot holds
        // the files the extract read through fs, not only its modules.
        const built = childProcess.spawnSync(process.execPath, ['scripts/economy-model/inputs.js', '--preset', 'x1', '--out', path.join(scratch, 'built')], { cwd: Boot.root, encoding: 'utf8', maxBuffer: 1 << 28 });
        assert.equal(built.status, 0, built.stderr);
        const header = JSON.parse(fs.readFileSync(path.join(scratch, 'built', fs.readdirSync(path.join(scratch, 'built')).find(name => name.startsWith('inputs-x1-'))), 'utf8')).header;
        for (const file of ['config/default.ini', 'data/ExtractableItems/extractable_items.csv', 'data/Bots/hunt/gear.json', 'scripts/economy-model/inputs.js'])
            assert.ok(header.sourceFiles.includes(file), `the stamp holds ${file}`);
        assert.ok(Boot.stampMatches(header), 'a fresh header matches the live data');
        // The source gaps read data/Bots/hunt/sources.json, an input of no snapshot: no preset's stamp of one run holds it, whatever the order.
        const two = childProcess.spawnSync(process.execPath, ['scripts/economy-model/inputs.js', '--preset', 'x10,x50', '--out', path.join(scratch, 'two')], { cwd: Boot.root, encoding: 'utf8', maxBuffer: 1 << 28 });
        assert.equal(two.status, 0, two.stderr);
        const stamps = fs.readdirSync(path.join(scratch, 'two')).map(name => JSON.parse(fs.readFileSync(path.join(scratch, 'two', name), 'utf8')).header.sourceFiles);
        assert.equal(stamps.length, 2);
        for (const files of stamps) assert.ok(!files.includes('data/Bots/hunt/sources.json'), 'no stamp of the run holds the source gaps\' file');
        // Another fingerprint, or no list of source files: refused with the build command.
        const odd = (name, change) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, JSON.stringify({ header: { preset: 'x50', ...Boot.dataStamp(loaded), sourceFiles: loaded, ...change } }));
            return file;
        };
        const buildX50 = /build one: node scripts\/economy-model\/inputs\.js --preset x50/;
        odd('inputs-x50-c.json', { fingerprint: 'another' });
        assert.throws(() => Load.loadSnapshot(dir, 'x50'), buildX50, 'a header with another fingerprint: refused');
        fs.rmSync(path.join(dir, 'inputs-x50-c.json'));
        odd('inputs-x50-d.json', { sourceFiles: undefined });
        assert.throws(() => Load.loadSnapshot(dir, 'x50'), buildX50, 'a header with no sourceFiles: refused');
        fs.rmSync(path.join(dir, 'inputs-x50-d.json'));
        // The stale one is the newest file and first by name.
        const stale = write('inputs-x50-a.json', new Date(2026, 0, 2));
        fs.appendFileSync(fares, '\n// a fare edited\n');
        const live = write('inputs-x50-b.json', new Date(2026, 0, 1));
        assert.equal(Load.loadSnapshot(dir, 'x50').file, live, 'the snapshot whose stamp is the live one, not the newest file');
        fs.rmSync(live);
        const build = /build one: node scripts\/economy-model\/inputs\.js --preset x50/;
        assert.throws(() => Load.loadSnapshot(dir, 'x50'), build, 'no snapshot of the live data: refused');
        assert.throws(() => Load.loadSnapshot(dir, 'x50', stale), build, 'a stale snapshot named on the command line: refused');
        const baseline = path.join(scratch, 'baseline.json');
        fs.writeFileSync(baseline, '{}');
        const node = args => childProcess.spawnSync(process.execPath, args, { cwd: Boot.root, encoding: 'utf8' });
        for (const mode of ['design', 'today', 'plain']) {
            const run = node(['scripts/economy-model/run.js', '--preset', 'x50', '--mode', mode, '--snapshot', stale, '--fit', baseline, '--cohort', baseline]);
            assert.ok(run.status !== 0 && build.test(run.stderr), `${mode} mode refuses the stale snapshot: ${run.stderr.split('\n').find(text => /Error/.test(text))}`);
        }
        const compare = node(['scripts/economy-model/compare.js', '--preset', 'x50', '--baseline', baseline, '--snapshot', stale]);
        assert.ok(compare.status !== 0 && build.test(compare.stderr), `compare refuses the stale snapshot: ${compare.stderr.split('\n').find(text => /Error/.test(text))}`);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

// The snapshot names every fallback it took: the spots with no no-grade
// market near their centre (they get the C town) and the spots whose walk
// back is 0.
const Policy = invoke('GameServer/Bot/Economy/MarketTownPolicy'), centreAt = cards.spotFields.indexOf('center');
const unmarketed = cards.spots.filter(row => !Policy.nearestNoGradeMarket({ locX: row[centreAt][0], locY: row[centreAt][1] })).map(row => String(row[0]));
assert.deepEqual(snapshot.fallbacks.noMarketToC, unmarketed, 'every spot with no no-grade market is named');
for (const id of unmarketed) assert.equal(snapshot.tradeTowns.none[id], snapshot.tradeTowns.higher, `spot ${id} falls back to the C town`);
assert.deepEqual(snapshot.fallbacks.walkBackZero, Object.keys(snapshot.walkBack).filter(id => !(snapshot.walkBack[id] > 0)), 'every spot with walk back 0 is named');
console.log(`  fallbacks: no no-grade market ${unmarketed.length} spots, walk back 0 ${snapshot.fallbacks.walkBackZero.length} spots`);

// The real cards take neither fallback today, so each is taken here: the
// first card's centre has no market, and one other spot has walk back 0. The
// snapshot names exactly those spots, and the no-market one gets the C town.
const noMarketCentre = cards.spots[0][centreAt], sharing = cards.spots.filter(row => row[centreAt][0] === noMarketCentre[0] && row[centreAt][1] === noMarketCentre[1]).map(row => String(row[0]));
const zeroId = Object.keys(snapshot.walkBack).find(id => snapshot.walkBack[id] > 0 && !sharing.includes(id));
const nearestMarket = Policy.nearestNoGradeMarket, walkBackHours = Load.walkBackHours;
let taken;
try {
    Policy.nearestNoGradeMarket = spot => (spot.locX === noMarketCentre[0] && spot.locY === noMarketCentre[1] ? null : nearestMarket(spot));
    Load.walkBackHours = (id, ...rest) => (id === zeroId ? 0 : walkBackHours(id, ...rest));
    taken = Inputs.extract({ preset: 'x50', lines: [line, '2', caster], levels: [level, level] });
} finally {
    Policy.nearestNoGradeMarket = nearestMarket;
    Load.walkBackHours = walkBackHours;
}
assert.deepEqual(taken.fallbacks.noMarketToC, sharing, 'the spots whose centre has no no-grade market are named');
for (const id of sharing) assert.equal(taken.tradeTowns.none[id], taken.tradeTowns.higher, `spot ${id} gets the C town`);
assert.deepEqual(taken.fallbacks.walkBackZero, [zeroId], 'the one spot with walk back 0 is named');
assert.equal(taken.walkBack[zeroId], 0);
console.log(`  fallbacks taken: no market ${sharing.join(' ')}, walk back 0 ${zeroId}`);

console.log('PASS economy model inputs snapshot');
