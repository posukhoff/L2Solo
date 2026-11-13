'use strict';

// One economy model run over a game-data snapshot (inputs.js) and a cohort.
//
//   node scripts/economy-model/run.js [--preset x50] [--snapshot <file>] [--hours 100] [--seed 1]
//       [--cohort <economy ledger JSON>: its start save's accounts | --accounts 1700 --levels 20-39]
//       [--mode plain|today|design] [--fit <economy ledger JSON>] [--hunt-share 1] [--visits 2] [--json <out file>]
//       [--start late|fresh] [--design '{"field": value}'] [--fit-preset x50: the preset of the --fit run] (design mode;
//       --hunt-share sets every band's hunting share there too)
//
// plain: NPC trade only, one hunting share and visit rate for every band.
// today: today's fixed stores and NPC prices (today.js), the hunting share
// and visits per band fitted on --fit (default: the --cohort ledger).
// design: the economy design (design.js, mains.js): crafter twins with
// their workshop and lines, and the mains' market (path, acquire, trip,
// visit, occupation), NPC prices at x1 and the design's rates; --start late
// is the --cohort ledger's start save, fresh the seeder's start levels
// (--accounts, default 1700); the hunting share is fitted on --fit as in
// today mode, and a main comes to town at its trip's situations.
//
// Prints per stage band (by start level) the faucets and sinks per bot-hour,
// the money stock, the bands over the hours, town visits and the run's
// counters; progress goes to stderr every 10 simulated hours.
const fs = require('node:fs');
const path = require('node:path');
const Boot = require('./boot');
const Cohort = require('./cohort');
const Engine = require('./engine');
const Today = require('./today');
const Design = require('./design');
const KitHours = require('./kit-hours');
const PersonaTypes = require('../../src/GameServer/Bot/AI/BotPersonaTypes');
const { levelForGrade } = require('../../src/GameServer/Bot/AI/GearGradeRule');
// The stage bands are the real ledger's (grade bands, D split at 30), so both ledgers group alike.
const { STAGE_BANDS } = require('../economy/ledger-rules');

// What version 1 of the model leaves out; each number it prints omits these.
const LEFT_OUT = Object.freeze([
    'parties: a party member\'s exp is its share by the game\'s party rule (PartyRewardMath) in the party the save holds, membership and the other members\' levels held at the save\'s for the run; its adena and drops, and a party spoiler\'s spoil, are a solo bot\'s',
    'travel time and deaths: folded into the hunting share; the Scroll of Escape a trip reads is not bought',
    'occupation does not answer prices: a main hunts the spot its bot stood at in the save (else the one its travel or stay names there) while the snapshot has that spot\'s hour (inputs.js --spots), else its line\'s best spot for its level',
    'per-kill item yields at the kill mix: the spawn-mix yields scaled per spot row by its drop and spoil loot (Engine.killMixCorrection)',
    'potions, enchanting, augments, henna, quests, clans, the player, sessions, entry and retirement (a closed cohort)',
    'bot-to-bot trade, crafting, crafter twins, seller twins and field deals',
    'hot bodies near a player (the real ledger\'s hotUnlabeled flow)',
    'the bag a main holds at the start (it starts empty) and what today\'s bots keep instead of selling',
    'today\'s gear improvement (crystallizing, enchanting: the gear bots buy at the NPC for it) and the funding limits of today\'s purchases (PurchaseFunding)'
]);

function snapshotFile(preset, file) {
    if (file) return path.resolve(file);
    const folder = path.join(Boot.root, 'tmp', 'economy-model');
    const found = fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.startsWith(`inputs-${preset}-`) && name.endsWith('.json'))
        .map(name => path.join(folder, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
    if (!found.length) throw new Error(`no snapshot for ${preset} in ${folder}: run node scripts/economy-model/inputs.js --preset ${preset}`);
    return found[0];
}

function loadSnapshot(preset, file) {
    const where = snapshotFile(preset, file);
    const snapshot = JSON.parse(fs.readFileSync(where, 'utf8'));
    if (!snapshot.fares) throw new Error(`${where} has no gatekeeper fares: write it again with inputs.js`);
    return { snapshot, file: where };
}

function cohortOf(argv, snapshot) {
    const baseline = Boot.option(argv, 'cohort', null);
    if (baseline) {
        const real = JSON.parse(fs.readFileSync(baseline, 'utf8'));
        return Cohort.fromSave(real.inputs.start.db, snapshot);
    }
    const [low, high] = String(Boot.option(argv, 'levels', '20-39')).split('-').map(Number);
    return Cohort.synthetic({ count: Number(Boot.option(argv, 'accounts', 1700)), low, high, seed: Number(Boot.option(argv, 'seed', 1)) }, snapshot);
}

const k = value => `${(value / 1000).toFixed(1)}k`;
const pad = (text, width) => String(text).padStart(width);

function progress(label) {
    return ({ hour, hours, events, seconds }) => process.stderr.write(`[${label}] h=${hour}/${hours} events=${Math.round(events / 1000)}k ${(events / Math.max(seconds, 1e-3) / 1000).toFixed(1)}k ev/s\n`);
}

// fresh: a fresh start's money stock begins near zero, so net / mean stock
// reads 2 / hours by construction: the growth rate is not printed.
function printRun(out, { rates, fresh = false }) {
    const flows = out.flows.perBotHour;
    console.log(`RATES per band (hunting share, visits per bot-hour): ${Object.entries(rates).map(([band, rate]) => `${band} ${rate.huntShare.toFixed(3)}/${rate.visitsPerBotHour.toFixed(2)}`).join(' | ')}`);
    console.log(`POPULATION ${out.population.bots} accounts, ${out.population.botHours} bot-h over ${out.window.hours} h; start bands ${Object.entries(out.population.stageBands).map(([band, n]) => `${band} ${n}`).join(' | ')}`);
    console.log(`FLOWS per bot-hour: ${Object.entries(flows).map(([kind, adena]) => `${kind} ${k(adena)}`).join(' | ')}; faucets ${(out.flows.faucets / 1e6).toFixed(1)}M sinks ${(out.flows.sinks / 1e6).toFixed(1)}M net ${(out.flows.net / 1e6).toFixed(1)}M; fixed buyers ${(out.flows.fixedBuyerShareOfFaucets * 100).toFixed(1)} % of faucets`);
    if (fresh) console.log(`MONEY ${(out.money.stockStart / 1e6).toFixed(1)}M -> ${(out.money.stockEnd / 1e6).toFixed(1)}M, net per bot-hour ${k(out.flows.net / Math.max(1, out.population.botHours))}, sinks / faucets ${(-out.flows.sinks / Math.max(1, out.flows.faucets)).toFixed(3)}, closure gap ${out.money.closureGap}`);
    else console.log(`MONEY ${(out.money.stockStart / 1e6).toFixed(1)}M -> ${(out.money.stockEnd / 1e6).toFixed(1)}M, growth ${(out.money.growthPerHour * 100).toFixed(2)} %/h, closure gap ${out.money.closureGap}`);
    console.log('BANDS by start level, per bot-hour:');
    console.log(`  ${'band'.padEnd(8)}${pad('bots', 6)}${pad('huntAdena', 11)}${pad('npcSales', 10)}${pad('fixedBuy', 10)}${pad('npcBuys', 10)}${pad('fixedSell', 10)}${pad('fares', 9)}${pad('moneyΔ', 10)}${pad('exp', 10)}${pad('lvUps', 7)}`);
    for (const [band, row] of Object.entries(out.progress.stageBands)) {
        const f = row.modelFlowsPerBotHour;
        console.log(`  ${band.padEnd(8)}${pad(row.bots, 6)}${pad(k(f.huntCold), 11)}${pad(k(f.npcSales), 10)}${pad(k(f.fixedBuyers), 10)}${pad(k(f.npcBuys), 10)}${pad(k(f.fixedSellers), 10)}${pad(k(f.fares), 9)}${pad(k(row.money.deltaPerBotHour), 10)}${pad(k(row.expPerBotHour), 10)}${pad(row.levelUps, 7)}`);
    }
    const marks = out.hourly.filter(row => row.hour % 10 === 0 || row.hour === out.window.hours);
    if (marks.length) {
        console.log('OVER THE HOURS (money stock, mains per current band):');
        for (const row of marks) console.log(`  h${pad(row.hour, 4)} ${pad((row.money / 1e6).toFixed(0), 8)}M  ${Object.entries(row.bands).map(([band, n]) => `${band} ${n}`).join(' | ')}`);
    }
    console.log(`SHOTS used ${out.shots.used} of ${out.shots.wanted} wanted (${(out.shots.usedShareOfWanted * 100).toFixed(1)} %), bought fixed ${out.shots.boughtFixed} npc ${out.shots.boughtNpc}, sold to NPC ${out.shots.soldNpc}`);
    console.log(`GEAR to NPC ${out.gear.toNpcUnits}, bought ${out.gear.boughtNpcUnits}; RECIPES dropped ${out.recipes.droppedTotal} (${Object.entries(out.recipes.dropped).map(([grade, n]) => `${grade} ${n}`).join(' | ')})`);
    console.log(`VISITS ${out.visits.perHour}/h: ${out.visits.towns.slice(0, 10).map(row => `${row.town} ${row.perHour} (${row.bots})`).join(' | ')}`);
    console.log(`HUNTING HOURS at the mains' own spots ${out.huntHours.ownSpot}, at their line's best ${out.huntHours.bestSpot}`);
    console.log(`COUNTERS ${Object.entries(out.counters).map(([name, n]) => `${name} ${n}`).join(' | ')}`);
}

function printFooter() {
    console.log('LEFT OUT of these numbers:');
    for (const line of LEFT_OUT) console.log(`  - ${line}`);
}

// The view and rates of the run's mode.
function modeOf(argv, snapshot, cohort) {
    const mode = Boot.option(argv, 'mode', 'plain');
    if (mode === 'plain') {
        return { view: Engine.viewOf(snapshot),
            rates: { default: { huntShare: Number(Boot.option(argv, 'hunt-share', 1)), visitsPerBotHour: Number(Boot.option(argv, 'visits', 2)) } } };
    }
    if (mode !== 'today') throw new Error(`unknown mode ${mode} (plain, today or design)`);
    const fitFile = Boot.option(argv, 'fit', Boot.option(argv, 'cohort', null));
    if (!fitFile) throw new Error('today mode needs --fit <economy ledger JSON> (or --cohort)');
    const view = Engine.viewOf(snapshot, { market: Today.marketOf(snapshot), npcPrices: Today.TODAY.npcPrices });
    const { rates, basis } = Today.fit(JSON.parse(fs.readFileSync(fitFile, 'utf8')), cohort.accounts, view, STAGE_BANDS);
    console.log(`TODAY ${JSON.stringify(Today.TODAY)}; fitted on ${fitFile}`);
    printFit(basis);
    return { view, rates };
}

function printFit(basis) {
    console.log('FIT per stage band: real exp/bot-h, mean exp per hunting hour at the mains\' spots, the hunting share fitted; beside it (not fitted): the share at the best spots and the end snapshot\'s hunting, grouped and resting fractions');
    const share = value => (value === null ? '-' : value.toFixed(3));
    for (const [band, row] of Object.entries(basis)) {
        console.log(`  ${band.padEnd(8)} ${pad(k(row.realExp), 10)} ${pad(k(row.meanExp), 10)} share ${row.huntShare.toFixed(3)}${row.huntShare > 1 ? ' (ABOVE 1)' : ''}  at best ${row.bestShare.toFixed(3)}  hunting ${share(row.activityHunting)} grouped ${share(row.activityGrouped)} resting ${share(row.activityResting)}  (${row.bots} mains, ${row.atOwnSpot} at their own spot)`);
    }
}

// The design mode's view, rates, cohort and plane.
function designOf(argv, snapshot) {
    const start = Boot.option(argv, 'start', 'late'), seed = Number(Boot.option(argv, 'seed', 1));
    if (!['late', 'fresh'].includes(start)) throw new Error(`unknown start ${start} (late or fresh)`);
    const fitFile = Boot.option(argv, 'fit', Boot.option(argv, 'cohort', null));
    if (!fitFile) throw new Error('design mode needs --fit <economy ledger JSON> (or --cohort): its start save and its fitted rates');
    const baseline = JSON.parse(fs.readFileSync(fitFile, 'utf8')), late = Cohort.fromSave(baseline.inputs.start.db, snapshot);
    const cohort = start === 'late' ? late : Cohort.fresh({ count: Number(Boot.option(argv, 'accounts', 1700)), seed }, snapshot);
    const view = Engine.viewOf(snapshot, { npcPrices: 'x1' });
    if (!view.yieldsDesign) throw new Error('the snapshot has no design yields: write it again with inputs.js');
    // The hunting share is a share of time, fitted at the ledger's own preset (the late run's x50):
    // a snapshot of another preset is not divided into that run's exp.
    const fitPreset = Boot.option(argv, 'fit-preset', 'x50'), fitSnapshot = snapshot.header.preset === fitPreset ? snapshot : loadSnapshot(fitPreset, null).snapshot;
    const fitView = fitSnapshot === snapshot ? view : Engine.viewOf(fitSnapshot);
    const { rates: fitted, basis } = Today.fit(baseline, fitSnapshot === snapshot ? late.accounts : Cohort.fromSave(baseline.inputs.start.db, fitSnapshot).accounts, fitView, STAGE_BANDS);
    console.log(`DESIGN start ${start}; rates fitted on ${fitFile} at ${fitPreset}`);
    printFit(basis);
    const grades = ['d', 'c', 'b', 'a', 's'].map(grade => [grade, levelForGrade(grade)]);
    const overrides = JSON.parse(Boot.option(argv, 'design', '{}')), shared = huntShares(fitted, overrides.huntShare, Boot.option(argv, 'hunt-share', null));
    const rates = shared.rates, config = Object.freeze({ ...Design.DESIGN, ...overrides, huntShare: shared.huntShare });
    const began = Date.now(), game = Design.gameOf(snapshot, view, config);
    console.log(`DESIGN game tables in ${((Date.now() - began) / 1000).toFixed(1)} s: ${Object.keys(game.firstPrice).length} first prices; `
        + `SSD ${fmt(game.firstPrice[1463])}, SSC ${fmt(game.firstPrice[1464])}, D crystal ${fmt(game.firstPrice[1458])}, Soul Ore ${fmt(game.firstPrice[1785])}`);
    console.log(`DESIGN config (fields unsaid in the design are ours; restockLine and crystalStock are high-sensitivity): ${JSON.stringify(config)}`);
    console.log(`DESIGN readings: ${Object.entries(Design.READINGS).map(([field, r]) => `${field} ${JSON.stringify(config[field])} (${config[field] === r.text ? 'the design\'s text' : [].concat(r.ours).includes(config[field]) ? 'ours' : 'other'})`).join(' | ')}; mpStartValue ${config.mpStartValue}`);
    const personaShares = Object.fromEntries(PersonaTypes.TYPE_IDS.map(id => [id, PersonaTypes.TYPES[id].share]));
    const booted = Date.now(), kitHours = KitHours.gameKitHours({ snapshot, anchor: game.firstPrice });
    kitHours.warm();
    console.log(`DESIGN kit hours: the game's hunt cycle booted and every band's body built in ${((Date.now() - booted) / 1000).toFixed(1)} s`);
    return { view, rates, cohort, fresh: start === 'fresh', real: baseline.visits || null, design: Design.plane({ snapshot, game, config, start, grades, personaShares, kitHours }) };
}

// The design mode's hunting share per band (the design world's share is
// unknown): the share fitted on today's world, a config's huntShare row over
// it, --hunt-share (cli) over every band. Returns { rates (the fitted rates
// with those shares; default follows its band), huntShare { band: share } }.
function huntShares(fitted, rows, cli) {
    const defaultBand = Object.keys(fitted).find(band => band !== 'default' && fitted[band] === fitted.default);
    const huntShare = Object.fromEntries(Object.keys(fitted).filter(band => band !== 'default')
        .map(band => [band, cli !== null && cli !== undefined ? Number(cli) : rows?.[band] ?? fitted[band].huntShare]));
    const rates = Object.fromEntries(Object.entries(huntShare).map(([band, share]) => [band, { ...fitted[band], huntShare: share }]));
    rates.default = defaultBand ? rates[defaultBand] : fitted.default;
    return { rates, huntShare };
}

const fmt = value => (value === null || value === undefined || !Number.isFinite(value) ? '-' : Math.abs(value) >= 1e4 ? k(value) : Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(2));
const pct = (value, base) => (base > 0 ? `${(100 * value / base).toFixed(1)} %` : '-');

function printDesign(design, hours, { visits = null, real = null } = {}) {
    const c = design.crafters;
    console.log(`CRAFTERS ${c.crafterAccounts} of ${c.accounts} accounts (${pct(c.crafterAccounts, c.accounts)}): Bounty Hunter pairs ${c.bountyHunterPairs}, other pairs ${c.otherPairs}; `
        + `twins by band ${Object.entries(c.byBand).map(([b, n]) => `${b} ${n}`).join(' | ')}; by class ${Object.entries(c.byClass).map(([b, n]) => `${b} ${n}`).join(' | ')}`);
    console.log(`  twins by town: ${Object.entries(c.byTown).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' | ')}`);
    console.log('SHOTS per grade (fired / wanted over the run, by current band; top towns by shots wanted):');
    for (const [grade, row] of Object.entries(design.shots.byGrade)) {
        console.log(`  ${grade.padEnd(5)} wanted ${k(row.wanted)} fired ${k(row.fired)} coverage ${pct(row.fired, row.wanted)}; `
            + `${Object.entries(row.byBand).map(([band, b]) => `${band} ${pct(b.fired, b.wanted)}`).join(' | ')}`);
        console.log(`        towns: ${row.byTown.slice(0, 10).map(t => `${t.town} ${pct(t.fired, t.wanted)}`).join(' | ')}`);
    }
    console.log('SHOT COVERAGE over the hours (each 10-hour window, fired / wanted):');
    for (let from = 0; from < design.hourly.length; from += 10) {
        const window = design.hourly.slice(from, from + 10), sum = {};
        for (const row of window) for (const [grade, s] of Object.entries(row.shots)) { const t = sum[grade] ||= { wanted: 0, fired: 0 }; t.wanted += s.wanted; t.fired += s.fired; }
        console.log(`  h${pad(window[window.length - 1].hour, 4)} ${Object.entries(sum).map(([grade, t]) => `${grade} ${pct(t.fired, t.wanted)}`).join(' | ')}`);
    }
    const s = design.shots.supply;
    console.log(`SHOT SUPPLY units: from the own twin ${s.own}, bought on twin lines ${s.lines}, NPC ${s.npc}`);
    const last10 = design.hourly.slice(-10), lastKind = {};
    for (const row of last10) for (const [grade, r] of Object.entries(row.shots)) {
        const e = lastKind[grade] ||= { pairWanted: 0, pairFired: 0, wanted: 0, fired: 0 };
        e.pairWanted += r.pairWanted || 0; e.pairFired += r.pairFired || 0; e.wanted += r.wanted; e.fired += r.fired;
    }
    console.log(`SHOT COVERAGE by account kind (run | last 10 h): ${Object.keys(design.shots.byGrade).map(grade => {
        const pair = design.shotsKind.pair[grade] || { wanted: 0, fired: 0 }, other = design.shotsKind.other[grade] || { wanted: 0, fired: 0 }, l = lastKind[grade] || { pairWanted: 0, pairFired: 0, wanted: 0, fired: 0 };
        return `${grade} pair mains ${pct(pair.fired, pair.wanted)} | ${pct(l.pairFired, l.pairWanted)}, others ${pct(other.fired, other.wanted)} | ${pct(l.fired - l.pairFired, l.wanted - l.pairWanted)}`;
    }).join('; ')}`);
    const cr0 = design.crafts, craftsAll = cr0.own.crafts + cr0.shelf.crafts, mpAll = cr0.own.mp + cr0.shelf.mp;
    console.log(`TWIN CRAFTS by whom they serve (batches, crafts, share of MP): ${['own', 'shelf'].map(use => `${use} ${cr0[use].batches} / ${cr0[use].crafts} (${pct(cr0[use].mp, mpAll)})`).join(' | ')}; ${craftsAll} crafts`);
    console.log(`LOOT value at the NPC's buy price (picked up; sold at visits; kept for the account): ${['pair', 'other'].map(kind => {
        const l = design.loot[kind];
        return `${kind} ${k(l.dropped)}; sold ${k(l.sold)} (${pct(l.sold, l.dropped)}); kept ${k(l.kept)} (${pct(l.kept, l.dropped)})`;
    }).join(' | ')}`);
    console.log(`SHOT WORTH at the start against the first price a twin asks: ${Object.entries(design.shots.worthAtStart).map(([grade, w]) => `${grade} ${pct(w.worthAtOrAboveFirstPrice, w.mains)} of ${w.mains}`).join(' | ')}`);
    console.log(`MP used ${k(design.mp.used)} of ${k(design.mp.available)} available (${pct(design.mp.used, design.mp.available)}); a full shot use would take ${k(design.mp.neededForFullShots)} (${pct(design.mp.neededForFullShots, design.mp.available)} of available); idle MP lost at max ${k(design.mp.lost)}`);
    const t = design.twins.seat, twinHours = t.sell + t.buy + t.idleSell + t.idleBuy;
    console.log(`TWINS without a seat yet (their main cannot craft): ${fmt(t.unseated)} twin-hours`);
    console.log(`TWINS seat-hours: selling (sell lines shown) ${fmt(t.sell)} (${pct(t.sell, twinHours)}), buying (buy lines shown) ${fmt(t.buy)} (${pct(t.buy, twinHours)}), `
        + `idle (store empty) ${fmt(t.idleSell + t.idleBuy)} (${pct(t.idleSell + t.idleBuy, twinHours)}: in sell mode ${fmt(t.idleSell)}, in buy mode ${fmt(t.idleBuy)}); `
        + `crafting (a batch running, beside the store) ${fmt(design.twins.batchHours)} (${pct(design.twins.batchHours, twinHours)})`);
    const b = design.twins.buyerSeat || { buy: 0, idleBuy: 0 };
    console.log(`BUYER TWINS ${design.twins.buyers || 0} (buyerTwin ${design.config.buyerTwin}): seat-hours buying (buy lines shown) ${fmt(b.buy)} (${pct(b.buy, b.buy + b.idleBuy)}), idle ${fmt(b.idleBuy)}`);
    const mk = design.money, money = row => `${row.accounts} accounts ${(row.money / 1e6).toFixed(1)}M`;
    console.log(`ACCOUNT MONEY (main + twin wallet) start -> end: crafter accounts ${money(mk.start.crafters)} -> ${(mk.end.crafters.money / 1e6).toFixed(1)}M `
        + `(${k((mk.end.crafters.money - mk.start.crafters.money) / Math.max(1, mk.start.crafters.accounts) / hours)} per account-hour); `
        + `others ${money(mk.start.others)} -> ${(mk.end.others.money / 1e6).toFixed(1)}M (${k((mk.end.others.money - mk.start.others.money) / Math.max(1, mk.start.others.accounts) / hours)} per account-hour)`);
    const f = design.firsts;
    console.log(`FIRSTS (hour): crystal ${Object.entries(f.crystal).map(([g, h]) => `${g} ${h.toFixed(1)}`).join(' | ') || '-'}; shot ${Object.entries(f.shot).map(([g, h]) => `${g} ${h.toFixed(1)}`).join(' | ') || '-'}; `
        + `crafted piece ${Object.entries(f.piece).map(([g, p]) => `${g} ${p.h.toFixed(1)} (${p.selfId})`).join(' | ') || '-'}`);
    console.log(`PIECES per grade (crafted gear per hour / mains entering the grade per hour): ${Object.entries(design.pieces).map(([g, p]) => `${g} ${p.craftedPerHour.toFixed(2)}/${p.entriesPerHour.toFixed(2)}`).join(' | ')}`);
    const m = design.materials, mTotal = m.own + m.bought + m.npc;
    console.log(`MATERIALS twins got: from their own main ${m.own} (${pct(m.own, mTotal)}), bought on their lines ${m.bought} (${pct(m.bought, mTotal)}), NPC ${m.npc} (${pct(m.npc, mTotal)})`);
    const cr = design.crystals;
    console.log(`CRYSTALS made: from pieces bought on bids ${cr.bids}, from own pieces ${cr.own}, through NPC gear ${cr.npcRoute}; used in crafts ${cr.used}`);
    console.log(`CRYSTALS per grade (made from bids / own pieces / NPC gear; used in crafts; sold to mains on twin lines): ${Object.entries(cr.byGrade || {}).map(([g, r]) => `${g} ${r.bids} / ${r.own} / ${r.npcRoute}; used ${r.used}; sold ${r.sold}`).join(' | ') || '-'}`);
    console.log(`SHOTS per grade (wanted; crafted; drawn by own mains; sold on twin lines): ${Object.entries(design.shotGrades || {}).map(([g, r]) => `${g} ${k(design.shots.byGrade[g]?.wanted || 0)}; ${k(r.crafted)}; ${k(r.own)}; ${k(r.sold)}`).join(' | ') || '-'}`);
    console.log(`SHOTS on twin shelves at the end (units per grade): ${Object.entries(design.market.stock.shotsOnShelves || {}).map(([g, n]) => `${g} ${k(n)}`).join(' | ') || '-'}`);
    console.log(`SHOTS on no twin line at the end (units per grade): ${Object.entries(design.market.stock.shotsOffLines || {}).map(([g, n]) => `${g} ${k(n)}`).join(' | ') || '-'}; `
        + `shot trips that bought no shot ${design.market.shotReport.bareTrips}; shot recipes forgotten (per grade): ${Object.entries(design.market.shotReport.forgets).map(([g, n]) => `${g} ${n}`).join(' | ') || '-'}`);
    console.log('MARGIN per MP on each grade\'s shots (median of the hourly medians in each 10-hour window, batches started):');
    for (let from = 0; from < design.hourly.length; from += 10) {
        const window = design.hourly.slice(from, from + 10), byGrade = {};
        for (const row of window) for (const [grade, mg] of Object.entries(row.margin)) { const e = byGrade[grade] ||= { medians: [], crafts: 0 }; if (mg.median !== null) e.medians.push(mg.median); e.crafts += mg.crafts; }
        const med = values => { const v = [...values].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
        console.log(`  h${pad(window[window.length - 1].hour, 4)} ${Object.entries(byGrade).map(([g, e]) => `${g} ${fmt(med(e.medians))} (${e.crafts})`).join(' | ') || '-'}`);
    }
    console.log(`RECIPES per grade: ${Object.entries(design.recipes).map(([g, r]) => `${g} dropped ${r.dropped} sold to twins ${r.soldToTwins} kept ${r.kept} learned ${r.learned} to NPC ${r.toNpc}`).join(' | ')}`);
    console.log('WAITS (opened / done / withdrawn / failed / deadline / open at the end):');
    for (const [kind, w] of Object.entries(design.liveness.waits)) console.log(`  ${kind.padEnd(9)} ${w.opened} / ${w.done} / ${w.withdrawn} / ${w.failed} / ${w.deadline} / ${w.open}`);
    console.log(`  lines open at the end ${design.liveness.linesOpen}, at a bound ${design.liveness.linesAtBound} (${pct(design.liveness.linesAtBound, design.liveness.linesOpen)}), `
        + `at a bound for 3 looks or more ${design.liveness.linesAtBoundThreeLooks}, parked at the input cost ${design.liveness.linesAtCost}`);
    console.log(`GOODS ${design.goods.items} items moved; closure (start + produced - destroyed - to NPC = end) fails for ${design.goods.failing}${design.goods.failing ? ` ${JSON.stringify(design.goods.worst)}` : ''}; `
        + `${Object.entries(design.goods.totals).map(([field, n]) => `${field} ${k(n)}`).join(' | ')}`);
    console.log(`BOT-TO-BOT adena ${k(design.botToBot)} (${(design.botToBot / hours / 1e6).toFixed(2)}M per hour); COUNTERS ${Object.entries(design.counters).map(([name, n]) => `${name} ${n}`).join(' | ')}`);
    printMarket(design, hours);
    printTowns(design, hours, visits, real);
}

// Towns and visits: visits per bot-hour by their trip's situation, overall
// and per current band; those in a town other than the nearest; visits per
// town as shares beside the --fit ledger's; twins per town by kind; stock
// sold to lines in the nearest town and in hubs against the NPC.
const CAUSES = Object.freeze(['bag_full', 'stock_low:shots', 'shots_out', 'goal_affordable', 'offer_posted', 'bid_posted', 'death', 'start']);
function printTowns(design, hours, visits, real) {
    const v = design.market.visits, botHours = Object.values(v.botHours).reduce((a, b) => a + b, 0);
    const total = cause => Object.values(v.byBand).reduce((sum, row) => sum + (row[cause] || 0), 0);
    const all = CAUSES.reduce((sum, cause) => sum + total(cause), 0);
    const per = (n, h) => (h > 0 ? (n / h).toFixed(3) : '-');
    console.log(`VISITS per bot-hour by cause (${all} visits, ${per(all, botHours)}/bot-h): ${CAUSES.map(cause => `${cause} ${per(total(cause), botHours)}`).join(' | ')}`);
    for (const [band, h] of Object.entries(v.botHours)) {
        const row = v.byBand[band] || {}, n = CAUSES.reduce((sum, cause) => sum + (row[cause] || 0), 0);
        console.log(`  ${band.padEnd(8)} ${per(n, h)}/bot-h over ${fmt(h)} bot-h: ${CAUSES.filter(cause => row[cause]).map(cause => `${cause} ${per(row[cause], h)}`).join(' | ') || '-'}`);
    }
    const hub = Object.values(v.hub).reduce((a, b) => a + b, 0);
    console.log(`VISITS in a town other than the nearest (shot trips): ${hub} (${pct(hub, all)}): ${Object.entries(v.hub).sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${cause} ${n}`).join(' | ') || '-'}`);
    if (visits) {
        const shares = rows => { const sum = rows.reduce((a, row) => a + row.perHour, 0); return new Map(rows.map(row => [row.town, sum > 0 ? row.perHour / sum : 0])); };
        const model = shares(visits.towns), seen = real ? shares(real.towns) : new Map();
        const towns = [...new Set([...model.keys(), ...seen.keys()])].sort((a, b) => (model.get(b) || 0) + (seen.get(b) || 0) - (model.get(a) || 0) - (seen.get(a) || 0));
        console.log(`VISITS per town, share of visits (model${real ? ' | the --fit run' : ''}; ${visits.perHour}/h${real ? ` | ${real.perHour}/h` : ''}): ${towns.slice(0, 16).map(town => `${town} ${pct(model.get(town) || 0, 1)}${real ? ` | ${pct(seen.get(town) || 0, 1)}` : ''}`).join(', ')}`);
    }
    const c = design.crafters, kinds = [...new Set([...Object.keys(c.byTown), ...Object.keys(c.buyersByTown || {})])].sort((a, b) => (c.byTown[b] || 0) - (c.byTown[a] || 0));
    console.log(`TWINS per town at the end (crafter | buyer): ${kinds.map(town => `${town} ${c.byTown[town] || 0} | ${c.buyersByTown?.[town] || 0}`).join(', ') || '-'}`);
    const st = design.market.stock, sold = st.nearLines + st.hubLines + st.npc;
    console.log(`STOCK sold to lines in the nearest town ${k(st.nearLines)} (${pct(st.nearLines, sold)}), in hubs ${k(st.hubLines)} (${pct(st.hubLines, sold)}), to the NPC ${k(st.npc)} (${pct(st.npc, sold)})`);
}

// The market of mains: how kit pieces came, the wants left open, trips,
// meetings, caps against floors, velocity, Gini, the shot margin's spread.
function printMarket(design, hours) {
    const m = design.market, g = design.gates, h = (table, grade) => (table[grade] === undefined ? '-' : (typeof table[grade] === 'number' ? table[grade] : table[grade].h).toFixed(1));
    console.log('GATES of each grade\'s soulshot (hour; - never): crafter main in the grade -> its shot recipe\'s scroll reaches a twin (how) -> a twin holds the recipe -> first crystal (from) -> first shots crafted -> first drawn by a pair\'s own main -> first sold to a main on a line -> 10 % / 50 % of the grade\'s shooters see a line at or under their shot worth:');
    for (const [grade] of [['d'], ['c'], ['b'], ['a'], ['s']]) {
        const deals = design.scrollDeals[grade];
        const at = g.scroll[grade]?.where, where = at ? ` at ${at.spot} lv${at.level} line ${at.line} class ${at.classId}${at.npcs.length ? ` from ${at.npcs.join(', ')}` : ''}` : '';
        console.log(`  ${grade.padEnd(5)} ${h(g.crafter, grade)} -> ${h(g.scroll, grade)}${g.scroll[grade] ? ` (${g.scroll[grade].from}${where})` : ''} -> ${h(g.recipe, grade)} -> ${h(g.crystal, grade)}${g.crystal[grade] ? ` (${g.crystal[grade].from})` : ''} `
            + `-> ${h(design.firsts.shot, grade)} -> ${h(g.own, grade)} -> ${h(g.sold, grade)} -> ${h(g.reach10, grade)} / ${h(g.reach50, grade)}`
            + `${deals ? `; shot scroll deals ${deals.deals}: first ${fmt(deals.first.price)} at h${deals.first.h.toFixed(1)}, last ${fmt(deals.last.price)} at h${deals.last.h.toFixed(1)} (NPC buys at ${fmt(deals.npcBuy)})` : ''}`);
    }
    const towns = design.townsAt, pick = [towns[0], towns[Math.floor((towns.length - 1) / 2)], towns[towns.length - 1]].filter(Boolean);
    console.log('TWINS by town (start, middle, end):');
    for (const row of pick) console.log(`  h${pad(row.hour, 4)} ${Object.entries(row.byTown).sort((a, b) => b[1] - a[1]).map(([town, n]) => `${town} ${n}`).join(' | ')}`);
    const own = design.ownTownLine, at = [own[0], own[Math.floor((own.length - 1) / 2)], own[own.length - 1]].filter(Boolean);
    console.log(`SHOOTERS whose own town's book holds a line of their shot (start, middle, end): ${at.map(row => `h${row.hour} ${Object.entries(row.byGrade).map(([grade, share]) => `${grade} ${pct(share, 1)}`).join(' ')}`).join(' | ')}`);
    console.log('KIT PIECES obtained per grade (buy: a player\'s line or ad, twin: the own twin\'s shelf or craft, npc, exchange, drop: its own drop), wants failed as outgrown (the main left the grade without the piece) and wants open at the end:');
    for (const grade of [...new Set([...Object.keys(m.obtained), ...Object.keys(m.openWants), ...Object.keys(m.outgrown)])].sort()) {
        const row = m.obtained[grade] || {}, total = Object.values(row).reduce((a, b) => a + b, 0), open = m.openWants[grade] || {};
        console.log(`  ${grade.padEnd(5)} ${total} pieces: ${Object.entries(row).sort((a, b) => b[1] - a[1]).map(([route, n]) => `${route} ${n} (${pct(n, total)})`).join(' | ') || '-'}; `
            + `outgrown ${m.outgrown[grade] || 0}; open ${Object.entries(open).map(([state, n]) => `${state} ${n}`).join(' | ') || '-'}`);
    }
    const w = design.liveness.waits;
    console.log(`WTBS posted ${w.wtb.opened} filled ${w.wtb.done} failed ${w.wtb.failed} (unfunded at the meeting ${m.unfunded.wtb}, outgrown ${w.wtb.outgrown}) withdrawn ${w.wtb.withdrawn} open ${w.wtb.open}; `
        + `pieces parked at the cap ${w.parkedWant.opened}; sales to twin lines unfunded ${m.unfunded.line}, to bids ${m.unfunded.bid}`);
    console.log(`ROUTES priced ${m.routes.priced}, the cap's own route at 0 adena ${m.routes.zero} (${pct(m.routes.zero, m.routes.priced)}), a piece with no worth row ${m.routes.noWorth} (${pct(m.routes.noWorth, m.routes.priced)})`);
    const tripsTotal = Object.values(m.trips).reduce((sum, n) => sum + n, 0);
    console.log(`TRIPS by situation (${tripsTotal}, ${(tripsTotal / hours).toFixed(0)}/h): ${Object.entries(m.trips).sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${reason} ${n}`).join(' | ')}`);
    console.log(`MEETINGS ${m.meetings}; offers raised ${m.events.offerPosted}, bids raised ${m.events.bidPosted}; twin-to-twin units ${m.twinToTwin}, twin units to the NPC at the floor ${m.twinToNpc}; paths ${m.paths}; spot changes ${Object.entries(m.occupation).map(([why, n]) => `${why} ${n}`).join(' | ')}`);
    const occ = m.occupation, moves = ['grade_changed', 'spot_left', 'recipe_wanted', 'arrived_town'].reduce((sum, why) => sum + (occ[why] || 0), 0);
    console.log(`SPOT CHANGES ${moves} (${(moves / hours).toFixed(1)}/h): ${['grade_changed', 'spot_left', 'recipe_wanted', 'arrived_town'].map(why => `${why} ${occ[why] || 0}`).join(' | ')}; `
        + `caused by a bid seen for what the new spot yields ${occ.forBid || 0} (${pct(occ.forBid || 0, moves)}), by its workshop's scroll want ${occ.forScroll || 0} (${pct(occ.forScroll || 0, moves)}); back to the spot held before ${occ.returned || 0}; `
        + `a move back to the spot left at the last arrival refused ${occ.refusedBack || 0}`);
    console.log('KIT HOUR (the hunt hour of the kit a main wears over the reference kit\'s at the level, by the game\'s hunt cycle; mains crossing each grade\'s middle level and leaving the grade at its last level; the >=0.9 share of those with a ratio):');
    for (const [point, row] of Object.entries(m.kitHour || {}).sort((a, b) => a[1].level - b[1].level)) {
        const ratio = value => (value === null ? '-' : value.toFixed(2));
        console.log(`  ${point.padEnd(11)} lv${row.level}: sampled ${row.sampled}, >=0.9 ${row.atLeast90} (${pct(row.atLeast90, row.sampled - row.none)}), median ${ratio(row.median)}, p10 ${ratio(row.p10)}, no ratio ${row.none}, unarmed ${row.unarmed}`);
    }
    const kh = m.kitHours || {}, kt = m.kitTables;
    console.log(`KIT TABLES taken ${kt.taken} (a main's line, band or worn kit changed): read ${kt.read}, shared from another main's ${kt.shared} (${pct(kt.shared, kt.taken)}), let go past the bound ${kt.evicted}, worn hours ${kt.wornEvicted}; `
        + `kit hours: swaps ${kh.swaps}, of them by the formula over the worn kit ${kh.fast}, whole profile passes ${kh.fresh}, cell builds ${kh.builds}`);
    console.log(`PATH pieces no route prices ${m.unpriced || 0}`);
    console.log('CAP>=FLOOR per grade: static (the best buyer among the lines entering the grade, path kit pieces; floors npc | npc + D crystals at the NPC gear route) under gear_gain / hunt_cycle; dynamic over pieces offered (a WTB in reach whose cap reaches the WTS floor):');
    for (const [grade, row] of Object.entries(m.capFloorStatic)) {
        const dyn = m.capFloor[grade];
        console.log(`  ${grade.padEnd(5)} ${row.pieces} pieces: gear_gain ${pct(row.gear_gain.npc, 1)} | ${pct(row.gear_gain.withD, 1)}; hunt_cycle ${pct(row.hunt_cycle.npc, 1)} | ${pct(row.hunt_cycle.withD, 1)}; `
            + `hunt-cycle rows at the bound ${pct(row.bounded, 1)}; offered ${dyn ? `${dyn.offered}: gear_gain ${pct(dyn.gear_gain, dyn.offered)}, hunt_cycle ${pct(dyn.hunt_cycle, dyn.offered)}` : '0'}`);
    }
    console.log(`WORTH caps held at the hunt cycle's bound: ${m.worthBounded}`);
    const windows = [];
    for (let from = 0; from < m.velocity.length; from += 10) {
        const rows = m.velocity.slice(from, from + 10), moved = rows.reduce((sum, row) => sum + row.moved, 0), stock = rows.reduce((sum, row) => sum + row.stock, 0) / rows.length;
        windows.push(`h${rows[rows.length - 1].hour} ${(100 * moved / rows.length / Math.max(1, stock)).toFixed(2)} %`);
    }
    console.log(`VELOCITY (bot-to-bot adena per hour / money stock, each 10 h): ${windows.join(' | ')}`);
    console.log(`GINI of account money: start ${m.gini.start.toFixed(3)} -> end ${m.gini.end.toFixed(3)}`);
    const last = design.hourly.slice(-10), spread = {}, batches = {};
    for (const row of last) for (const [grade, mg] of Object.entries(row.margin)) {
        batches[grade] = (batches[grade] || 0) + mg.crafts;
        if (mg.median !== null && mg.crafts >= 5) (spread[grade] ||= []).push(mg.median);
    }
    console.log(`SHOT MARGIN over the last 10 hours (hours with >= 5 batches; (max - min) / mean of the hourly medians; batches in the 10 hours): ${Object.entries(spread).map(([grade, values]) => {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return `${grade} ${values.length} h, mean ${fmt(mean)}, spread ${mean ? (100 * (Math.max(...values) - Math.min(...values)) / Math.abs(mean)).toFixed(1) : '-'} %, ${batches[grade]} batches`;
    }).join(' | ') || '-'}`);
    console.log('PRICES (median of the hourly median deal prices in each 10-hour window, deals): shots by grade on twin lines | materials as a multiple of the NPC buy price:');
    const med = values => { const v = [...values].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
    for (let from = 0; from < design.hourly.length; from += 10) {
        const rows = design.hourly.slice(from, from + 10), shots = {};
        for (const row of rows) for (const [grade, p] of Object.entries(row.prices.shots)) { const e = shots[grade] ||= { medians: [], deals: 0 }; if (p.median !== null) e.medians.push(p.median); e.deals += p.deals; }
        const mats = rows.map(row => row.prices.materials).filter(p => p.median !== null);
        console.log(`  h${pad(rows[rows.length - 1].hour, 4)} ${Object.entries(shots).map(([g, e]) => `${g} ${fmt(med(e.medians))} (${e.deals})`).join(' | ') || '-'} | materials x${fmt(med(mats.map(p => p.median)))} (${mats.reduce((sum, p) => sum + p.deals, 0)})`);
    }
    const lastPrices = {}, lastDeals = {};
    for (const row of design.hourly.slice(-10)) for (const [grade, p] of Object.entries(row.prices.shots)) {
        lastDeals[grade] = (lastDeals[grade] || 0) + p.deals;
        if (p.median !== null && p.deals >= 5) (lastPrices[grade] ||= []).push(p.median);
    }
    console.log(`SHOT PRICE over the last 10 hours (hours with >= 5 deals; (max - min) / mean; deals in the 10 hours): ${Object.entries(lastPrices).map(([grade, values]) => {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return `${grade} ${values.length} h, mean ${fmt(mean)}, spread ${(100 * (Math.max(...values) - Math.min(...values)) / mean).toFixed(1)} %, ${lastDeals[grade]} deals`;
    }).join(' | ') || `- (${Object.entries(lastDeals).map(([grade, n]) => `${grade} ${n} deals`).join(' | ') || 'no deals'})`}`);
    console.log('WHAT THE MODEL GETS WRONG (solo, closed cohort, no travel time, no crowding, global ads):');
    for (const line of design.biases) console.log(`  - ${line}`);
}

function main(argv) {
    const preset = Boot.option(argv, 'preset', 'x50'), hours = Number(Boot.option(argv, 'hours', 100)), seed = Number(Boot.option(argv, 'seed', 1));
    const { snapshot, file } = loadSnapshot(preset, Boot.option(argv, 'snapshot', null));
    const designMode = Boot.option(argv, 'mode', 'plain') === 'design';
    const picked = designMode ? designOf(argv, snapshot) : null;
    const cohort = picked ? picked.cohort : cohortOf(argv, snapshot);
    const { view, rates } = picked || modeOf(argv, snapshot, cohort);
    console.log(`SNAPSHOT ${file} (revision ${snapshot.header.revision}, fingerprint ${snapshot.header.fingerprint}, rates ${JSON.stringify(snapshot.header.rates)})`);
    console.log(`COHORT ${cohort.source}: ${cohort.accounts.length} accounts; lines exact ${cohort.lines.exact}, drawn by class weights ${cohort.lines.drawn}, no line ${cohort.lines.noLine}, stations ${cohort.lines.stations}`);
    const began = Date.now();
    const out = Engine.simulate({ view, accounts: cohort.accounts, bands: STAGE_BANDS, rates, hours, seed, nextArrival: picked ? null : Today.nextArrival,
        onProgress: progress(`${preset} seed=${seed}`), inputs: { snapshot: file, preset, seed, cohort: cohort.source, rates }, design: picked ? picked.design : null });
    printRun(out, { rates, fresh: !!picked?.fresh });
    console.log(`MONEY per start band, mean per bot start -> end: ${Object.entries(out.progress.stageBands).map(([band, row]) => `${band} ${k(row.money.meanStart)} -> ${k(row.money.meanEnd)}`).join(' | ')}`);
    if (out.design) console.log(`MONEY per start band, net per bot-hour: ${Object.entries(out.progress.stageBands).map(([band, row]) => `${band} ${k(row.money.deltaPerBotHour)}`).join(' | ')}`);
    if (out.design) printDesign(out.design, hours, { visits: out.visits, real: picked.real });
    console.log(`RUN ${out.counters.events} events in ${((Date.now() - began) / 1000).toFixed(1)} s, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
    if (!out.design) printFooter();
    const json = Boot.option(argv, 'json', null);
    if (json) fs.writeFileSync(json, `${JSON.stringify(out, null, 1)}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { loadSnapshot, cohortOf, designOf, huntShares, printRun, printDesign, printFit, printFooter, progress, LEFT_OUT, STAGE_BANDS };
