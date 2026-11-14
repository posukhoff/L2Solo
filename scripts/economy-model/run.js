'use strict';

// One economy model run over a game-data snapshot (inputs.js) and a cohort.
//
//   node scripts/economy-model/run.js [--preset x50] [--snapshot <file>: else the one of the live game data] [--hours 100] [--seed 1]
//       [--cohort <economy ledger JSON>: its start save's accounts | --accounts 1700 --levels 20-39]
//       [--mode plain|today] [--fit <economy ledger JSON>] [--hunt-share 1] [--visits 2] [--json <out file>]
//
// plain: NPC trade only, one hunting share and visit rate for every band.
// today: today's fixed stores and NPC prices (today.js), the hunting share
// and visits per band fitted on --fit (default: the --cohort ledger).
// There is no design mode here: it is written again from the model's own rows in a later step.
//
// Prints per stage band (by start level) the faucets and sinks per bot-hour,
// the money stock, the bands over the hours, town visits and the run's
// counters; progress goes to stderr every 10 simulated hours.
const fs = require('node:fs');
const Boot = require('./boot');
const Cohort = require('./cohort');
const Engine = require('./engine');
const Today = require('./today');
const Load = require('./load');
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

function printRun(out, { rates }) {
    const flows = out.flows.perBotHour;
    console.log(`RATES per band (hunting share, visits per bot-hour): ${Object.entries(rates).map(([band, rate]) => `${band} ${rate.huntShare.toFixed(3)}/${rate.visitsPerBotHour.toFixed(2)}`).join(' | ')}`);
    console.log(`POPULATION ${out.population.bots} accounts, ${out.population.botHours} bot-h over ${out.window.hours} h; start bands ${Object.entries(out.population.stageBands).map(([band, n]) => `${band} ${n}`).join(' | ')}`);
    console.log(`FLOWS per bot-hour: ${Object.entries(flows).map(([kind, adena]) => `${kind} ${k(adena)}`).join(' | ')}; faucets ${(out.flows.faucets / 1e6).toFixed(1)}M sinks ${(out.flows.sinks / 1e6).toFixed(1)}M net ${(out.flows.net / 1e6).toFixed(1)}M; fixed buyers ${(out.flows.fixedBuyerShareOfFaucets * 100).toFixed(1)} % of faucets`);
    console.log(`MONEY ${(out.money.stockStart / 1e6).toFixed(1)}M -> ${(out.money.stockEnd / 1e6).toFixed(1)}M, growth ${(out.money.growthPerHour * 100).toFixed(2)} %/h, closure gap ${out.money.closureGap}`);
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

// The view, rates and plane of the run's mode.
function modeOf(argv, snapshot, cohort) {
    const mode = Boot.option(argv, 'mode', 'plain');
    if (mode === 'plain') {
        const view = Engine.viewOf(snapshot);
        return { view, plane: Today.plane({ view, hunter: Today.hunter(view) }),
            rates: { default: { huntShare: Number(Boot.option(argv, 'hunt-share', 1)), visitsPerBotHour: Number(Boot.option(argv, 'visits', 2)) } } };
    }
    if (mode === 'design') throw new Error('design mode is deleted until build F step 1 writes it from the spec; modes: plain, today');
    if (mode !== 'today') throw new Error(`unknown mode ${mode} (plain or today; design is deleted until build F step 1 writes it from the spec)`);
    const fitFile = Boot.option(argv, 'fit', Boot.option(argv, 'cohort', null));
    if (!fitFile) throw new Error('today mode needs --fit <economy ledger JSON> (or --cohort)');
    const booted = Date.now(), { view, rates, basis, hunter } = Today.setup(snapshot, JSON.parse(fs.readFileSync(fitFile, 'utf8')), cohort.accounts);
    console.log(`TODAY ${JSON.stringify(Today.TODAY)}; fitted on ${fitFile}; kit hours booted in ${((Date.now() - booted) / 1000).toFixed(1)} s`);
    printFit(basis);
    return { view, rates, plane: Today.plane({ view, hunter }) };
}

function printFit(basis) {
    console.log('FIT per stage band: real exp/bot-h, mean exp per hunting hour at the mains\' spots, the hunting share fitted; beside it (not fitted): the share at the best spots and the end snapshot\'s hunting, grouped and resting fractions');
    const share = value => (value === null ? '-' : value.toFixed(3));
    for (const [band, row] of Object.entries(basis)) {
        console.log(`  ${band.padEnd(8)} ${pad(k(row.realExp), 10)} ${pad(k(row.meanExp), 10)} share ${row.huntShare.toFixed(3)}${row.huntShare > 1 ? ' (ABOVE 1)' : ''}${row.kitFactor === undefined ? '' : `  kit factor ${row.kitFactor.toFixed(3)}`}  at best ${row.bestShare.toFixed(3)}  hunting ${share(row.activityHunting)} grouped ${share(row.activityGrouped)} resting ${share(row.activityResting)}  (${row.bots} mains, ${row.atOwnSpot} at their own spot)`);
    }
}

// The options main reads (the header names them): any other --name is refused by name.
const OPTIONS = Object.freeze(['preset', 'snapshot', 'hours', 'seed', 'cohort', 'accounts', 'levels', 'mode', 'fit', 'hunt-share', 'visits', 'json']);

function refuseUnknownOptions(argv) {
    for (const word of argv) {
        const name = word.startsWith('--') ? word.slice(2).split('=')[0] : null;
        if (name !== null && !OPTIONS.includes(name)) throw new Error(`unknown option --${name} (run.js reads: ${OPTIONS.map(option => `--${option}`).join(' ')})`);
    }
}

function main(argv) {
    refuseUnknownOptions(argv);
    const preset = Boot.option(argv, 'preset', 'x50'), hours = Number(Boot.option(argv, 'hours', 100)), seed = Number(Boot.option(argv, 'seed', 1));
    const { snapshot, file } = Load.loadSnapshot(Load.SNAPSHOT_DIR, preset, Boot.option(argv, 'snapshot', null));
    const cohort = cohortOf(argv, snapshot);
    const { view, rates, plane } = modeOf(argv, snapshot, cohort);
    const fallbacks = snapshot.fallbacks;
    console.log(`SNAPSHOT ${file} (revision ${snapshot.header.revision}, fingerprint ${snapshot.header.fingerprint}, rates ${JSON.stringify(snapshot.header.rates)}); fallbacks: `
        + `no no-grade market (the C town) ${fallbacks.noMarketToC.length} spots`);
    console.log(`COHORT ${cohort.source}: ${cohort.accounts.length} accounts; lines exact ${cohort.lines.exact}, drawn by class weights ${cohort.lines.drawn}, no line ${cohort.lines.noLine}, stations ${cohort.lines.stations}`);
    const began = Date.now();
    const out = Engine.simulate({ view, accounts: cohort.accounts, bands: STAGE_BANDS, rates, hours, seed, plane,
        onProgress: progress(`${preset} seed=${seed}`), inputs: { snapshot: file, preset, seed, cohort: cohort.source, rates } });
    printRun(out, { rates });
    console.log(`MONEY per start band, mean per bot start -> end: ${Object.entries(out.progress.stageBands).map(([band, row]) => `${band} ${k(row.money.meanStart)} -> ${k(row.money.meanEnd)}`).join(' | ')}`);
    console.log(`RUN ${out.counters.events} events in ${((Date.now() - began) / 1000).toFixed(1)} s, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
    printFooter();
    const json = Boot.option(argv, 'json', null);
    if (json) fs.writeFileSync(json, `${JSON.stringify(out, null, 1)}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { cohortOf, printRun, printFit, printFooter, progress, LEFT_OUT, STAGE_BANDS };
