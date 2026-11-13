'use strict';

// The design mode of the economy model: the account plane with crafter twins
// beside today's engine. The pure rules decide (rules/workshop, ownLines,
// knowledge, bounds, priceStep); this module builds their views from the
// run's state, commits their answers, keeps the town books (books.js) and
// counts what the design asks the model to print.
//
// Crafter accounts: every Bounty Hunter main and DESIGN.crafterShare of all
// accounts among the other mains (seeded per account). A twin is never
// stepped: an Artisan below 40 and a Warsmith from 40 at its main's highest
// level (ours), seated in a town, its MP a function of time. It acts at its
// account's wakes: its main's arrival in a town, a fill of one of its lines,
// the end of its craft batch (the one deadline the engine holds besides the
// mains' situations).
//
// The mains' side (mains.js) runs the character plane's rules: a main comes
// to town at its trip's situations, sells and buys at its visit through the
// twins' lines, the ads and its caps' own routes, and re-chooses its spot at
// its occupation's situations.
const Engine = require('./engine');
const Ledger = require('./ledger');
const Books = require('./books');
const Bounds = require('./rules/bounds');
const Knowledge = require('./rules/knowledge');
const Workshop = require('./rules/workshop');
const { ownLines } = require('./rules/ownLines');
const { hash, mulberry } = require('../hunt-tables/common');
const Weights = require('./weights');
const Worth = require('./rules/worth');
const Mains = require('./mains');
const StoreLimits = require('../../src/GameServer/PrivateStoreLimits');

// What the design leaves unsaid, and four readings of its text, at the
// values the model runs with. Every field is read by the code and printed
// with the run; a sweep varies them without code changes.
const DESIGN = Object.freeze({
    // Unsaid in the design: ours. The share of all accounts, among the mains
    // other than Bounty Hunters, whose twin is a crafter.
    crafterShare: Weights.PATIENT_CRAFTER_SHARE,
    // Unsaid in the design: ours. A craft batch is the crafts of one recipe
    // that this many hours of seated regen cover, at least one.
    batchHours: 1,
    // Unsaid in the design: ours (high sensitivity). An applied batch's units
    // start a new sell line at the known price with its step reset, the
    // unsold remainder keeps its step ('new_line'); or they join the unsold
    // line and its step ('continue').
    restockLine: 'new_line',
    // Unsaid in the design: ours (high sensitivity). The crystals a twin
    // keeps and its crystallizer bid (one standing bid per grade, P per
    // crystal for any gear piece of the grade, the only form built) asks for:
    // 'queued' (ours): what its queued batches take (the next batch and one
    // batch of each recipe it holds with a positive margin or decided to
    // add); the rest it lists. 'hours' (the model before): what
    // crystalStockHours of its best crystal recipe use.
    crystalStock: 'queued',
    crystalStockHours: 10,
    // A dropped item's first price. 'band_hour' (the design's text): the
    // hours to farm one at the best row that drops it x that row's hour, so
    // a whole hour lands on each by-product. 'npc_floor': the NPC buy price.
    // 'hour_share' (ours, pending the maintainer): its NPC buy price x (the
    // row's hour / the NPC value of that hour's loot): the hour spread over
    // its loot by value, so one hour's drops at first prices sum to its income.
    firstPriceDrop: 'hour_share',
    // A crafted good's first price. 'inputs' (the design's text): its inputs'
    // cheapest routes with no MP term, so a new good's margin is at most
    // zero. 'inputs_plus_mp' (ours, pending the maintainer): the inputs plus
    // the chain's MP x a value per MP: for the twin that crafts it, the best
    // margin per MP among the goods it has sold, else mpStartValue; in the
    // game's table, mpStartValue.
    firstPriceCraft: 'inputs_plus_mp',
    // Adena per MP before a twin has sold anything (ours): Soulshot D's
    // margin per MP when it sells at the median D hunter's shot worth at x1
    // (12.5 a shot) against its inputs in Giran (3 Soul Ore at 275 and a D
    // crystal at ~600 through NPC gear: 9.1 a shot): (12.5 - 9.1) x 156 / 40.
    mpStartValue: 13,
    // What a look does to a seller's ask. 'every_look' (the design's text):
    // an arrival, a filled or an undercut line each step the ask down, and a
    // restocked line starts at the last deal. 'unsold_look' (ours, pending
    // the maintainer): the ask steps down only at a look where its stock
    // stayed unsold since the previous look; a fill holds it; a line that
    // sold out restarts one step up toward its starting price.
    sellerLook: 'unsold_look',
    // A crafter's floor. false (the design's text): max(npcBuy, the best
    // crystallizer bid in reach), and a negative margin stops the recipe.
    // true (ours, pending the maintainer): its ask never goes under its input
    // cost at its own unit costs; the line parks there, counted.
    askFloorAtCost: true,
    // Unsaid in the design: ours. A crafter account prices as the patient
    // crafter it stands for: the floor at the 5th look, the buyer starting at
    // 0.7 of its known price or cap.
    crafterPersona: Object.freeze({ looksToFloor: 5, buyerStart: 0.7 }),
    // Unsaid in the design: ours. The other accounts by their persona type
    // (drawn by the types' shares, seeded): the look a seller's ask reaches
    // its floor and a buyer's start; types not named take 'other'.
    personas: Object.freeze({ patient_crafter: Object.freeze({ looksToFloor: 5, buyerStart: 0.7 }), speculator: Object.freeze({ looksToFloor: 5, buyerStart: 0.7 }),
        pragmatic_earner: Object.freeze({ looksToFloor: 3, buyerStart: 0.8 }), steady_achiever: Object.freeze({ looksToFloor: 3, buyerStart: 0.8 }),
        other: Object.freeze({ looksToFloor: 2, buyerStart: 0.9 }) }),
    // A piece's worth to a buyer (its cap): its gain an hour over the kit
    // the main wears, over the hours it is worn, plus its resale.
    // 'gear_gain' (the design's text): today's gear gain of the piece over the
    // worn kit carried over, times the own hour. 'hunt_cycle' (ours, pending the
    // maintainer): the hunt hour of the worn kit with the piece minus the
    // worn kit's, in adena, each at the best spot for its kit (kit-hours.js).
    worth: 'hunt_cycle',
    // The hours a piece's worth counts over. 'grade_stage' (the design's
    // text): its gain over the hunting hours to the end of the grade stage.
    // 'use_plus_resale' (ours): its gain over the hours the main wears it (to
    // its grade's end, and on through each next grade whose ladder for the
    // slot holds no rung an NPC or Luxury sells it), plus the least it sells
    // for then (the NPC's buy price or the best crystallizer bid it knows), so
    // a piece bought late in its grade is still worth its resale.
    worthHorizon: 'use_plus_resale',
    // Which rung path aims at in a slot. Its candidates are the class's gear
    // ladder (the hunt tables' per-slot rungs without dominated pieces) of
    // the main's grade and below whose hunt hour beats the piece it wears.
    // 'best_priced' (the model before): the best one a route prices.
    // 'affordable' (ours; the design does not say what path does when the
    // best piece costs more than the main holds): the priced one of the
    // greatest net gain, counting the wait for its money: its gain an hour
    // over the worn piece x (its use hours less the hunting hours its
    // missing money takes at what the main nets an hour now, its own hour
    // less its shots) + its resale - its cost; the money a slot waits on is
    // the main's less the aims taken for the slots before it; none with a
    // net gain, no aim; while it wears a rung of its grade, a better one only
    // when its gain over the worn rung, over its use, beats its cost less the
    // worn rung's resale.
    pathAim: 'affordable',
    // A crafted good's price at the workshop. 'bid_first' (the reading "read
    // from open bids" as written): the best open bid in reach, else its last
    // deal or first price. 'bid_or_own' (ours, pending the maintainer): the
    // dearer of the bid and its own price (a WTB starts under what its buyer
    // pays and steps up at its looks).
    productPrice: 'bid_or_own',
    // Where a twin sits; a twin re-seats only at its main's arrival in town
    // and only when its best store there, weighed on that town's book, beats
    // its best store here by more than the gatekeeper fare (the mode rule).
    // 'starter_then_pays' (the design's text: it "starts in its main's
    // starter region and re-seats at its main's arrival in another hub when
    // that pays"): it starts in its main's starter village (fresh) or its
    // main's spot town (late) and weighs the town its main arrives in.
    // 'main_town' (ours): no seat before it can craft (Create Item 1); its
    // first seat is the town its main resupplies in then; it weighs the town
    // its main arrives in. 'hub' (ours): no seat before it can craft; it sits
    // in a hub, its first seat without a fare (the hub its main stands in,
    // else the first); with hubTowns 'by_grade' its hubs are the trade towns
    // of what it sells (its sell lines and its recipes' products, the game's
    // rule by grade), with a list of hubs those; it weighs every hub other
    // than its own. A buyer twin sits with its crafter twin either way.
    twinSeat: 'hub',
    // The hub towns: 'by_grade' (ours; the game's MarketTownPolicy, a fact
    // every account knows): a lot's trade towns by its grade, a no-grade lot
    // in the starter-village market nearest the spot, D in the policy's D
    // markets (Gludio, Dion: weighed by the account's own rule), C and above
    // in Giran; or a list of towns in order (the
    // model before: ['Giran'], the design's notes naming Giran the hub).
    // A twin sits in one with twinSeat 'hub'.
    hubTowns: 'by_grade',
    // A scroll the account's own workshop decided to add counts in its main's
    // occupation at the workshop's cap for it, and occupation is re-chosen
    // when that decision changes (recipe_wanted). false (the plan's wakes
    // only) | true (ours: in C4 a dwarf's first aim was its shot recipe).
    occupationRecipeWant: true,
    // Unsaid: ours. The hunt cycle's gain is held to this many own hours an
    // hour (a piece at most doubles the hour); counted where it binds.
    huntCycleGainBound: 1,
    // A route's hours (acquire). 'literal' (the design's text): hours x own
    // hour. 'opportunity' (ours): hours x (own hour - the hour of the farm
    // spot, one the main can hunt at its own level) + hours x the piece's
    // use per hour (its worth over the hours to the grade's end), the use
    // lost while it waits for the drop, so farming at its own spot costs too.
    hourCost: 'opportunity',
    // What a seller's known price is. false (the design's text): rival lines
    // and its own deals. true (ours): a standing WTB above its ask too: its
    // line starts there and restarts there at a look.
    sellerSeesBids: true,
    // A buyer's WTB ladder. 'looks' (the design's text): start at
    // min(known, cap) x the persona's start, the cap at the 3rd look, two
    // looks at the cap. 'paced' (ours): the same ladder, but a buyer whose
    // expected visits left in its grade are fewer than the looks the ladder
    // still needs starts that many steps up (one visit left: its cap).
    buyerLadder: 'paced',
    // A want no account, twin or NPC supplies in the towns the main knows (no
    // line, ad, NPC, Luxury or own twin). 'ladder' (the design's text): the
    // WTB ladder as for any want, a look at each visit. 'standing' (ours: the
    // ladder at a refill's few visits takes most of the grade): one WTB at
    // its cap that stands unstepped (a seller who appears finds it).
    buyerNoSeller: 'standing',
    // Unsaid: ours. An own-twin wait still unmet after this many
    // visits fails, its route stalled for the piece (source_stalled).
    waitVisits: 2,
    // Unsaid: ours. stock_low:shots at this many minutes of shots left.
    stockLowMinutes: 10,
    // The hours of hunting a refill (the kit rule's: shots) carries for;
    // unsaid in the design. 'outing' (ours): outingHours of hunting, the
    // outing a C4 player sets out on (it ends when shots, potions or buffs
    // run out, typically 1 to 3 hours); stock_low and shots_out end it.
    // 'last_outing' (the model before): the hunting hours of the outing that
    // just ended, at least refillMinHours (an outing's length copies itself).
    refill: 'outing',
    // Ours, to be swept (1, 2, 4).
    outingHours: 2,
    refillMinHours: 1,
    // Unsaid: ours. bag_full at no free slot or at this share of the max
    // load (C4 weight penalty beyond it).
    loadShare: 2 / 3,
    // What a main keeps at its visit. 'sell_all_but_kit' (the model before
    // the keep rule): what it wears, the shots it fires and every material
    // of its twin's held and decided recipes; the rest is sold.
    // 'account_needs' (ours): what an answer its account holds needs: the
    // next grade's kit pieces path names, the inputs its workshop's last answer needs (one
    // batch of each recipe), gear worth more as crystals to its own twin
    // (to the warehouse); the rest is surplus and sold at that visit, as is
    // what the warehouse holds that no recipe of the workshop uses any more.
    keepRule: 'account_needs',
    // Its own main first (ours): at its wakes the workshop crafts its main's
    // shortfall of the shot it fires and of path pieces it can craft, at no
    // price, before the shelf, while the main's worth of the unit
    // reaches the best bid in reach. false: the shelf alone (its main draws
    // what the shelf holds).
    ownUseFirst: true,
    // Where the workshop's input money stands in the money order.
    // 'after_path' (the design's order, the kit's refill reserve then path
    // pieces, has no place for it): after the next piece. 'with_reserve'
    // (ours): beside the reserve, before path pieces.
    workshopMoney: 'with_reserve',
    // How much of a liquid good a twin makes ahead. 'unbounded' (the
    // design's text: liquid goods are made ahead while their margin holds).
    // 'by_sales' (ours): a shelf batch of a liquid good waits while its
    // unsold units exceed shelfStockFactor times what left its shelf (sold or
    // drawn by its own main) since its last batch of it.
    shelfStock: 'by_sales',
    shelfStockFactor: 1,
    // Luxury (Lisvus multisell) sells C gear for C or D crystals, and the
    // data crystallizes that gear back to more crystals than it cost (a
    // Flamberge: 573 C in, 916 C out), an NPC faucet of crystals and adena.
    // true: the data as it is. false (ours until a second C4 source confirms
    // the counts): gear Luxury sells does not crystallize.
    luxuryCrystallizes: false,
    // When a main re-chooses its spot. false (the design's text: hunters
    // re-choose rarely): at grade_changed and when its spot leaves its levels.
    // true (ours): also at its arrival in a town, where it moves only when
    // the gain per hunting hour times the hours it expects to stay there
    // beats the move's fare and extra walk hours at its own hour.
    occupationAtTown: true,
    // Unsaid: ours. The hours of one gatekeeper hop between two towns (the
    // walk to the gatekeeper and through the town: teleports are instant and
    // the snapshot holds no walk inside a town).
    hopHours: 0.1,
    // A buyer twin. The design defers a second twin (it comes back with the
    // seller twins); true is ours, pending the maintainer: a crafter account
    // opens a second seated character, of a race other than the dwarf (its
    // buy slots: PrivateStoreLimits, 4 in C4), holding the workshop's buy
    // lines when it has buy lines and its crafter twin has goods to sell; the
    // crafter twin then only sells. It sits with its crafter
    // twin and pays a second fare when they move. false (the design's
    // first version): one twin, one store mode.
    buyerTwin: true,
    // A death is an arrival (ours; the model before folded deaths into the
    // hunting share): a main dies at its spot's deaths per hunting hour (the
    // spot table's hour row), drawn by the arrival's seeded roll, and arrives
    // in the respawn town of its spot, where it visits as at any arrival.
    deathArrival: true,
    // Unsaid: ours. The share of wall time a main hunts, per stage band
    // ({ band: share }); null: the shares fitted on today's world (run.js
    // --fit), which the design world need not keep; --hunt-share sets every band.
    huntShare: null
});
// The readings of the design's text and ours, by field (printed with the run).
const READINGS = Object.freeze({
    firstPriceDrop: Object.freeze({ text: 'band_hour', ours: 'hour_share' }),
    firstPriceCraft: Object.freeze({ text: 'inputs', ours: 'inputs_plus_mp' }),
    sellerLook: Object.freeze({ text: 'every_look', ours: 'unsold_look' }),
    askFloorAtCost: Object.freeze({ text: false, ours: true }),
    worth: Object.freeze({ text: 'gear_gain', ours: 'hunt_cycle' }),
    worthHorizon: Object.freeze({ text: 'grade_stage', ours: 'use_plus_resale' }),
    hourCost: Object.freeze({ text: 'literal', ours: 'opportunity' }),
    productPrice: Object.freeze({ text: 'bid_first', ours: 'bid_or_own' }),
    twinSeat: Object.freeze({ text: 'starter_then_pays', ours: Object.freeze(['hub', 'main_town']) }),
    occupationRecipeWant: Object.freeze({ text: false, ours: true }),
    sellerSeesBids: Object.freeze({ text: false, ours: true }),
    buyerLadder: Object.freeze({ text: 'looks', ours: 'paced' }),
    buyerNoSeller: Object.freeze({ text: 'ladder', ours: 'standing' }),
    // text: the model before these rules (the design's text says nothing of them).
    keepRule: Object.freeze({ text: 'sell_all_but_kit', ours: 'account_needs' }),
    ownUseFirst: Object.freeze({ text: false, ours: true }),
    workshopMoney: Object.freeze({ text: 'after_path', ours: 'with_reserve' }),
    shelfStock: Object.freeze({ text: 'unbounded', ours: 'by_sales' }),
    // text: the data as it is.
    luxuryCrystallizes: Object.freeze({ text: true, ours: false }),
    occupationAtTown: Object.freeze({ text: false, ours: true }),
    // text: the model before (the design does not say how long a refill lasts).
    refill: Object.freeze({ text: 'last_outing', ours: 'outing' }),
    buyerTwin: Object.freeze({ text: false, ours: true }),
    deathArrival: Object.freeze({ text: false, ours: true }),
    pathAim: Object.freeze({ text: 'best_priced', ours: 'affordable' }),
    crystalStock: Object.freeze({ text: 'hours', ours: 'queued' })
});
// C4 warehouse deposit fee per stack (Lisvus SendWareHouseDepositList).
const DEPOSIT_FEE = 30;
// A race's starter village (C4 newbie towns), by the template's race id.
const STARTER_VILLAGE = Object.freeze({ 0: 'Talking Island', 1: 'Elven Village', 2: 'Dark Elven Village', 3: 'Orc Village', 4: 'Dwarven Village' });
const BOUNTY_HUNTER = String(Weights.BOUNTY_HUNTER);
// A buyer twin's buy slots: a character of a race other than the dwarf
// (human) without Expand Trade (PrivateStoreLimits; C4: 4).
const BUYER_SLOTS = StoreLimits.tradeLimit(0, 0, 3);
// What the model gets wrong, printed with every design run: it is solo,
// with a closed cohort, no travel time, no crowding and global ads.
const BIASES = Object.freeze([
    'shot coverage reads high: trips cost no time, the ads are global (no regional chat), no party shares shots',
    'the share of crafter accounts needed reads high (conservative): no clan dwarf crafts at cost for its members',
    'first crystal and crafted piece read late for B and above (no clan pools materials to one dwarf) and early through free trips',
    'pieces per hour against grade entries read high: solo yields, no party split, no crowding at a spot',
    'the share of materials a pair gathers itself reads high: its spoil reaches its twin through the warehouse at once',
    'recipes learned read high: global ads and meetings that cost nothing',
    'faucets net of sinks and money per band read high (inflation reads high): no clan levels, unsealing, enchanting, no adena lost walking back after a death',
    'the share of pieces whose buyer cap reaches the floor reads high: a solo own hour is above a party member\'s',
    'markets go quiet early: a closed cohort with no entry or retirement, no enchant breaking',
    'looks come faster without travel: a price settles or oscillates earlier than it would',
    'a main hunts the spot its occupation chose alone: a spot is never full',
    'a trip to a town other than the nearest pays its fares, but its hop hours only delay the arrival: the hunting share does not fall (hub trips read cheap)',
    'left out as in today mode: potions, enchanting, augments, henna, quests, clans, the player, sessions, hot bodies near a player'
]);

const isMaterial = item => !Engine.isGear(item) && item?.kind !== 'Other.Recipe' && item?.kind !== 'Other.Shot';
const gradeOf = item => String(item?.grade || 'NONE').toLowerCase();
const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
// Per sampling point: mains sampled, those at 90 % of the reference kit's
// hour or more, the median and 10th percentile ratio (nearest rank), mains
// with no ratio and mains with no weapon in hand.
function kitHourSummary(points) {
    return Object.fromEntries(Object.entries(points).map(([key, { level, ratios, none, unarmed }]) => {
        const sorted = [...ratios].sort((a, b) => a - b);
        return [key, { level, sampled: ratios.length + none, atLeast90: ratios.filter(ratio => ratio >= 0.9).length, median: median(ratios),
            p10: sorted.length ? sorted[Math.max(0, Math.ceil(0.1 * sorted.length) - 1)] : null, none, unarmed }];
    }));
}

// The game data the rules read, built once per run from the snapshot and
// the design view: recipes indexed, NPC prices and the NPC gear route per
// town (x1), from each town the cheapest gear route it reaches with the
// gatekeeper fare (one piece: (fare + price) / crystals, the nearest seller
// as Engine.sellerOf finds it, or any town), the items something drops, and
// every item's first price.
function gameOf(snapshot, view, config = DESIGN) {
    // luxuryCrystallizes false: gear Luxury sells for crystals gives none back.
    const items = config.luxuryCrystallizes === false ? { ...snapshot.items } : snapshot.items;
    if (config.luxuryCrystallizes === false) for (const id of Object.keys(snapshot.luxuryOptions || {})) if (items[id]) items[id] = { ...items[id], crystals: 0 };
    const recipes = {}, byProduct = {}, byScroll = {}, dwarven = [], questRecipes = [];
    for (const row of snapshot.recipes) {
        recipes[row.recipeId] = row;
        (byProduct[row.productId] ||= []).push(row.recipeId);
        if (row.type !== 'dwarven') continue;
        if (row.quest) questRecipes.push(row.recipeId);
        else { dwarven.push(row.recipeId); byScroll[row.recipeItemId] = row.recipeId; }
    }
    const crystalIds = snapshot.crystalIds, crystalGrade = Object.fromEntries(Object.entries(crystalIds).map(([grade, id]) => [id, grade.toLowerCase()]));
    const sourced = Object.fromEntries(Object.entries(snapshot.sources || {}).filter(([, row]) => row.drop.length || row.spoil.length).map(([id]) => [id, true]));
    const npcByTown = {}, routeByTown = {}, npcMin = {}, routeMin = {};
    for (const [key, rows] of Object.entries(snapshot.npcOffers.x1)) {
        const id = Number(key), item = items[id], grade = gradeOf(item);
        for (const { town, price } of rows) {
            (npcByTown[town] ||= {})[id] = Math.min(npcByTown[town][id] ?? Infinity, price);
            npcMin[id] = Math.min(npcMin[id] ?? Infinity, price);
            if (!Engine.isGear(item) || !(item.crystals > 0) || !crystalIds[grade.toUpperCase()]) continue;
            const perCrystal = price / item.crystals, held = (routeByTown[town] ||= {})[grade];
            if (!held || perCrystal < held.perCrystal) routeByTown[town][grade] = { perCrystal, gearId: id, price, crystals: item.crystals };
            routeMin[grade] = Math.min(routeMin[grade] ?? Infinity, perCrystal);
        }
    }
    const reachByTown = {};
    for (const from of Object.keys(view.fares)) {
        for (const [to, routes] of Object.entries(routeByTown)) {
            const fare = from === to ? 0 : view.fares[from]?.[to];
            if (fare === null || fare === undefined) continue;
            for (const [grade, route] of Object.entries(routes)) {
                const perCrystal = (fare + route.price) / route.crystals, held = (reachByTown[from] ||= {})[grade];
                if (!held || perCrystal < held.perCrystal) reachByTown[from][grade] = { perCrystal, town: to, fare };
            }
        }
    }
    return { recipes, byProduct, byScroll, dwarven, questRecipes, items, crystalIds, crystalGrade, sourced, npcByTown, routeByTown, reachByTown,
        firstPrice: firstPrices(snapshot, view, { recipes, byProduct, crystalGrade, npcMin, routeMin, sourced, config, items }) };
}

// The first price of every item (bounds.firstPrice): its cheapest supplying
// route among farming it (config.firstPriceDrop, at the best line-level row
// that drops it), crafting it (its inputs at their first prices over the
// expected units, plus the MP at mpStartValue with firstPriceCraft
// 'inputs_plus_mp') and the NPC (x1); for a crystal also the NPC gear route.
function firstPrices(snapshot, view, { recipes, byProduct, crystalGrade, npcMin, routeMin, sourced, config, items = snapshot.items }) {
    const farm = {}, dropAt = config.firstPriceDrop;
    if (dropAt === 'npc_floor') for (const id of Object.keys(sourced)) farm[id] = { farmHours: 1, bandHour: snapshot.items[id]?.npcBuy || 0 };
    for (const [line, byLevel] of dropAt === 'band_hour' || dropAt === 'hour_share' ? Object.entries(view.hours) : []) {
        for (const [key, hour] of Object.entries(byLevel)) {
            const row = hour.best, level = Number(key);
            if (!row || !(row.kills > 0)) continue;
            const per = Engine.designYieldRows(view, line, level, row, 'shots').map(([id, perKill]) => [id, perKill * row.kills]);
            const loot = per.reduce((sum, [id, count]) => sum + count * (view.items[id]?.npcBuy || 0), 0);
            const income = row.adena * Engine.designAdenaFactor(view, row, level) + loot;
            for (const [id, count] of per) {
                // band_hour: 1 / count hours each; hour_share: the item's share of the loot's value per unit.
                const hours = dropAt === 'band_hour' ? 1 / count : loot > 0 ? (view.items[id]?.npcBuy || 0) / loot : 0;
                if (count > 0 && hours > 0 && (!farm[id] || income * hours < farm[id].bandHour * farm[id].farmHours)) farm[id] = { farmHours: hours, bandHour: income };
            }
        }
    }
    const mpWorth = config.firstPriceCraft === 'inputs_plus_mp' ? config.mpStartValue : 0;
    const gearByGrade = {};
    for (const [key, item] of Object.entries(items)) {
        if (Engine.isGear(item) && item.crystals > 0) (gearByGrade[gradeOf(item)] ||= []).push({ id: Number(key), crystals: item.crystals });
    }
    const memo = {}, busy = new Set();
    const priceOf = id => {
        if (id in memo) return memo[id];
        if (busy.has(id)) return null;
        busy.add(id);
        let craft = null;
        for (const recipeId of byProduct[id] || []) {
            const recipe = recipes[recipeId];
            let cost = recipe.mpCost * mpWorth;
            for (const material of recipe.materials) {
                const price = priceOf(material.selfId);
                if (price === null) { cost = null; break; }
                cost += material.amount * price;
            }
            if (cost !== null) craft = Math.min(craft ?? Infinity, cost / (recipe.productCount * recipe.successRate / 100));
        }
        // A crystal also comes from crystallizing any gear piece of its grade.
        let route = crystalGrade[id] ? routeMin[crystalGrade[id]] ?? null : null;
        for (const piece of crystalGrade[id] ? gearByGrade[crystalGrade[id]] || [] : []) {
            const price = priceOf(piece.id);
            if (price !== null) route = Math.min(route ?? Infinity, price / piece.crystals);
        }
        busy.delete(id);
        const craftCost = craft === null ? route : route === null ? craft : Math.min(craft, route);
        memo[id] = Bounds.firstPrice({ farmHours: farm[id]?.farmHours ?? null, bandHour: farm[id]?.bandHour ?? null, craftCost, npcSell: npcMin[id] ?? null }).price;
        return memo[id];
    };
    const out = {};
    for (const id of Object.keys(snapshot.items)) { const price = priceOf(Number(id)); if (price !== null) out[id] = price; }
    return out;
}

// A twin's numbers at a level (the snapshot's twins row).
function twinStats(snapshot, level) {
    const row = snapshot.twins[Math.max(1, Math.min(level, Object.keys(snapshot.twins).length))];
    return { level, classId: row.classId, createItem: row.createItem, crystallize: row.crystallize, maxMp: row.maxMp, regen: row.mp, storeSlots: { ...row.storeSlots, buyer: BUYER_SLOTS } };
}

// The Gini of a list of money amounts (negatives counted as 0).
function gini(values) {
    const sorted = values.filter(value => Number.isFinite(value)).map(value => Math.max(0, value)).sort((a, b) => a - b), n = sorted.length, sum = sorted.reduce((a, b) => a + b, 0);
    return n && sum ? sorted.reduce((acc, value, i) => acc + (2 * (i + 1) - n - 1) * value, 0) / (n * sum) : 0;
}

// Does second-hand gear have a buyer whose cap reaches the seller's floor?
// Per grade, over the gear ladder's rungs of the grade, the best buyer among
// the lines (a line's reference bot entering the grade in the kit of the
// level before: its own hour at its best spot at the design's yields, the
// NPC's prices, the net hour of that kit with the rung put on over the
// kit's, read through kitHours, each firing what nets most at the shots'
// first prices (what a main knows before any deal: Worth.firing), over its
// hunting hours to the next grade) against
// the floor, under both worth formulas: the NPC's buy price alone, and for D
// also the D crystals a crystallizer gets at the cheapest NPC gear route per
// crystal (the most a crystallizer bids: an upper bound of the floor).
// bounded: the share of line-rung rows whose hunt-cycle gain is held at the
// bound.
function staticCapFloor(snapshot, view, game, grades, config, kitHours) {
    const npcMin = {}, out = {};
    for (const prices of Object.values(game.npcByTown)) for (const [id, price] of Object.entries(prices)) npcMin[id] = Math.min(npcMin[id] ?? Infinity, price);
    const dRoute = Math.min(...Object.values(game.routeByTown).map(routes => routes.d?.perCrystal ?? Infinity));
    const firstPrice = id => game.firstPrice[id] ?? null;
    for (const [at, [grade, from]] of grades.entries()) {
        const best = {}, rows = { all: 0, bounded: 0 };
        for (const line of Object.keys(Weights.CLASS_WEIGHTS)) {
            const ladder = (snapshot.gearLadder?.lines?.[line] || []).find(band => from >= band.from && from <= band.to), hour = view.hours[line]?.[from]?.best;
            if (!ladder || !hour || !(hour.exp > 0)) continue;
            const ownHour = hour.adena * Engine.designAdenaFactor(view, hour, from)
                + Engine.designYieldRows(view, line, from, hour, 'shots').reduce((sum, [id, perKill]) => sum + perKill * hour.kills * (view.items[id]?.npcBuy || 0), 0);
            const next = at + 1 < grades.length ? grades[at + 1][1] : view.maxLevel;
            const horizon = Math.max(0, Engine.expAt(view, Math.min(next, view.maxLevel)) - Engine.expAt(view, from)) / hour.exp;
            const entry = Object.fromEntries((view.kits[line]?.[Math.max(1, from - 1)] || []).map(piece => [piece.slot, piece.selfId]));
            const pieces = Object.entries(ladder.rungs).flatMap(([group, ids]) => ids.filter(id => String(view.items[id]?.grade || 'NONE').toLowerCase() === grade)
                .map(selfId => ({ selfId, slot: group === 'weapon' ? snapshot.gearLadder.slots?.[selfId] || 7 : Number(group) })));
            const read = Worth.swapRows(kitHours.swaps(line, from, entry, pieces)), worn = Worth.netRow(read.worn, firstPrice);
            pieces.forEach(({ selfId: id }, index) => {
                rows.all++;
                const rung = Worth.netRow(read.rows[index] ?? null, firstPrice);
                for (const formula of ['gear_gain', 'hunt_cycle']) {
                    const worth = Worth.rungWorth({ formula, rung, worn, useHours: horizon, ownHour, gainBound: config.huntCycleGainBound });
                    if (formula === 'hunt_cycle' && worth.bounded) rows.bounded++;
                    const cap = Bounds.cap({ worth: worth.adena ?? 0, npcSell: npcMin[id] ?? null }).cap;
                    const held = (best[id] ||= {});
                    held[formula] = Math.max(held[formula] ?? 0, cap);
                }
            });
        }
        const ids = Object.keys(best), share = (formula, floorOf) => (ids.length ? ids.filter(id => best[id][formula] >= floorOf(id)).length / ids.length : null);
        const npcFloor = id => view.items[id]?.npcBuy || 0, dFloor = id => Math.max(npcFloor(id), grade === 'd' && Number.isFinite(dRoute) ? (view.items[id]?.crystals || 0) * dRoute : 0);
        out[grade] = { pieces: ids.length, bounded: rows.all ? rows.bounded / rows.all : 0,
            gear_gain: { npc: share('gear_gain', npcFloor), withD: share('gear_gain', dFloor) }, hunt_cycle: { npc: share('hunt_cycle', npcFloor), withD: share('hunt_cycle', dFloor) } };
    }
    return out;
}

// The waits the design counts (liveness): each opened wait ends done,
// withdrawn by its owner, failed, or at its one deadline, or is open at the end.
const WAITS = ['sellLine', 'buyLine', 'bid', 'batch', 'shotless', 'wts', 'wtb', 'route', 'twin', 'parkedWant'];
// outgrown: of the failed, those its owner's main left the piece's grade without.
const wait = () => ({ opened: 0, done: 0, withdrawn: 0, failed: 0, deadline: 0, outgrown: 0 });

// The design plane for Engine.simulate. options: { snapshot, game, config,
// start: 'late' | 'fresh', grades: [[grade, fromLevel]] (D..S),
// personaShares: { type: share } (the persona types' shares; without them
// every main prices as 'other'; kitHours: the kit hour source (kit-hours.js
// gameKitHours, or one with the same seam) }.
function plane({ snapshot, game, config = DESIGN, start = 'late', grades, personaShares = null, kitHours }) {
    return { sinks: ['warehouseFees'], start: context => startPlane({ snapshot, game, config, start, grades, personaShares, kitHours, ...context }) };
}

// A main's persona type: drawn by the types' shares (seeded per account),
// a crafter account is the patient crafter it stands for.
function personaOf(config, personaShares, seed, main, crafter) {
    if (crafter) return config.crafterPersona;
    const types = Object.entries(personaShares || {}).filter(([type]) => type !== 'patient_crafter');
    const total = types.reduce((sum, [, share]) => sum + share, 0);
    let roll = mulberry(hash(`persona:${seed}:${main.id}`))() * total;
    for (const [type, share] of types) { roll -= share; if (roll < 0) return config.personas[type] || config.personas.other; }
    return config.personas.other;
}

function startPlane({ snapshot, game, config, start, grades, personaShares, view, mains, ledger, push, seed, rateOf, rearrive, commit, kitHours }) {
    const books = Books.create(), accounts = [];
    const gradeOfLevel = level => grades.reduce((name, [grade, from]) => (level >= from ? grade : name), 'none');
    // The game's trade towns of a lot of items for an account's main
    // (Knowledge.tradeTowns): its main's spot for a no-grade lot's market.
    const tradeTownsOf = (index, items, andAbove = false) => Knowledge.tradeTowns(snapshot.tradeTowns, { items, andAbove, spotId: String(Engine.spotRowOf(view, mains[index])?.spotId ?? '') });
    // twinSeat 'hub': the hubs a twin may sit in. hubTowns 'by_grade': the
    // trade towns of what it sells (its sell lines, its recipes' products;
    // nothing yet: a no-grade lot), else the town given; a list: the hubs.
    const byGrade = config.hubTowns === 'by_grade';
    const hubsOf = (town, index, twin) => {
        if (!byGrade) return [...config.hubTowns];
        const sells = twin.lines.filter(line => line.side === 'sell').map(line => line.item), products = [...Workshop.heldRecipes(twin, game)].map(id => game.recipes[id].productId);
        const towns = tradeTownsOf(index, [...new Set([...sells, ...products])]);
        return towns.length ? towns : [town];
    };
    // A twin's first hub seat (no fare): the town its main stands in when it
    // is a hub, else the first.
    const firstHub = (town, index, twin) => { const hubs = hubsOf(town, index, twin); return hubs.includes(town) ? town : hubs[0]; };
    // A shot's grade is its column in the shot families (shot items carry no grade).
    const shotGrade = id => {
        const family = view.shotFamilies?.ids.find(ids => ids.includes(Number(id)));
        return family ? view.shotFamilies.grades[family.indexOf(Number(id))].toLowerCase() : 'none';
    };
    const stats = {
        goods: {}, shots: {}, shotsByTown: {}, shotWanted: {}, hourly: [], hour: {}, mp: { used: 0, available: 0, lost: 0 },
        seat: { sell: 0, buy: 0, idleSell: 0, idleBuy: 0, unseated: 0 }, buyerSeat: { buy: 0, idleBuy: 0 }, townsAt: [], batchHours: 0, firsts: { crystal: {}, shot: {}, piece: {} },
        // The gate chain of each grade's soulshot: a crafter main entering the
        // grade, a twin holding a recipe of the grade's shots (and where its
        // scroll came from), the first crystal (and its source), the first
        // shots crafted, the first sold to a main on a line, and the hours by
        // which 10 % and 50 % of the mains firing the grade's shots saw a line
        // at or under their shot's worth at their last visit.
        gates: { crafter: {}, scroll: {}, recipe: {}, crystal: {}, own: {}, sold: {}, reach10: {}, reach50: {} },
        pieces: {}, entries: {}, materials: { own: 0, bought: 0, npc: 0 }, crystals: { bids: 0, own: 0, npcRoute: 0, used: 0 },
        recipes: {}, margins: {}, marginHour: {}, waits: Object.fromEntries(WAITS.map(kind => [kind, wait()])), counters: { wakes: 0, reseats: 0, failedCrafts: 0,
            gearCapped: 0, shelfFull: 0, shotsOwn: 0, shotsLine: 0, shotsNpc: 0, deposits: 0, stintsKept: 0, stintsUnfilled: 0, twinToTwin: 0, twinToNpc: 0, unseatedWakes: 0, firstSeats: 0, buyerTwins: 0 },
        stopped: new Set(), botToBot: 0, botToBotHour: 0,
        // The market of mains: pieces obtained by route and grade, trips by
        // their situation, meetings, the cap-against-floor count over
        // pieces offered, hunt-cycle worths held at the bound, spot changes.
        pieces_: {}, trips: {}, meetings: 0,
        // Visits by their trip's situation per current band, those in a town
        // other than the nearest by situation, and wall hours per current band.
        visits: { byBand: {}, hub: {}, botHours: {} },
        // Stock its mains sold (adena) to lines in the town nearest their
        // spot, to lines in another town (where a shot trip took them), and
        // to the NPC.
        stock: { nearLines: 0, hubLines: 0, npc: 0 }, paths: 0, capFloor: {}, worthBounded: 0,
        // Shot trips that bought no shot, and shot recipes forgotten per grade.
        shotReport: { bareTrips: 0, forgets: {} },
        occupation: { grade_changed: 0, spot_left: 0, recipe_wanted: 0, arrived_town: 0, forScroll: 0, forBid: 0, returned: 0, refusedBack: 0, scrollSpot: 0, rowMissing: 0 }, events: { offerPosted: 0, bidPosted: 0 }, velocity: [],
        // Path pieces no route priced (source_stalled); per sampling point
        // (a grade's middle level crossed, a grade left at its last level)
        // the mains' worn kit hour over the reference kit's (mains.kitRatio):
        // { level, ratios, none: no ratio, unarmed: no weapon in hand }; kit
        // tables (mains.kitTableOf) taken as a main's line, band or kit
        // changed, read through kitHours, shared from another main's and
        // let go past the bound.
        unpriced: 0, kitHour: {}, kitTables: { taken: 0, read: 0, shared: 0, evicted: 0, wornEvicted: 0 },
        // Routes acquire priced, and those whose cap's own route cost 0; sales
        // whose buyer could not pay at the meeting; failed waits outgrown, by grade.
        routes: { priced: 0, zero: 0, noWorth: 0 }, unfunded: { wtb: 0, line: 0, bid: 0 }, outgrown: {},
        // Deal prices this hour: shots by grade, materials as a multiple of the NPC's buy price.
        priceHour: { shots: {}, materials: [] }, ownTownLine: [], scrollDeals: {}, scrollMains: new Set(),
        // A twin's batches by whom they serve; shots by account kind (a
        // pair's main or another) and grade; loot value (NPC buy) picked up,
        // sold at visits and kept for the account, by kind.
        crafts: { own: { batches: 0, crafts: 0, mp: 0 }, shelf: { batches: 0, crafts: 0, mp: 0 } },
        shotsKind: { pair: {}, other: {} }, loot: { pair: { dropped: 0, sold: 0, kept: 0 }, other: { dropped: 0, sold: 0, kept: 0 } },
        // Crystals per grade by source, used in crafts and sold to mains on
        // twin lines; shots per grade crafted, drawn by own mains, sold on lines.
        crystalGrades: {}, shotGrades: {}
    };
    const shotRow = grade => (stats.shotGrades[grade] ||= { crafted: 0, own: 0, sold: 0 });
    stats.obtained = (grade, route) => { const row = stats.pieces_[grade] ||= {}; row[route] = (row[route] || 0) + 1; };
    const goods = (field, id, count) => { if (count) { const row = stats.goods[id] ||= {}; row[field] = (row[field] || 0) + count; } };
    const recipeRow = id => stats.recipes[view.recipeGrade[id] || 'none'] ||= { dropped: 0, soldToTwins: 0, kept: 0, learned: 0, toNpc: 0 };
    const isRecipe = id => view.items[id]?.kind === 'Other.Recipe';

    // An account is replaced, never edited: the plane owns the slot, put
    // writes the new object there and every reader takes accounts[index] afresh.
    const put = (index, patch) => (accounts[index] = { ...accounts[index], ...patch });
    const counterOf = index => put(index, { counter: accounts[index].counter + 1 }).counter;
    // The store's seat state of a twin: its mode while its store shows a
    // line, idle (by mode) while it shows none. Seat-hours accrue per state.
    // A buyer twin's (buyerTwin) are counted apart: buying while it shows a
    // buy line, idle while it shows none; its crafter twin's store is then
    // its sell lines.
    const seatOf = twin => {
        if (!twin.town) return 'unseated';
        const shows = twin.buyer ? twin.lines.some(line => line.side === 'sell') : twin.lines.length > 0;
        return shows ? twin.mode : twin.mode === 'sell' ? 'idleSell' : 'idleBuy';
    };
    const buyerSeatOf = twin => (!twin.buyer || !twin.town ? null : twin.lines.some(line => line.side === 'buy') ? 'buy' : 'idleBuy');
    const putTwin = (index, twin, now) => {
        const before = accounts[index].twin, key = seatOf(twin), buyerKey = buyerSeatOf(twin);
        let seat = before ? before.seat : { key, since: now }, buyerSeat = before?.buyerSeat || null;
        if (seat.key !== key) { stats.seat[seat.key] += now - seat.since; seat = { key, since: now }; }
        if ((buyerSeat?.key ?? null) !== buyerKey) {
            if (buyerSeat) stats.buyerSeat[buyerSeat.key] += now - buyerSeat.since;
            buyerSeat = buyerKey ? { key: buyerKey, since: now } : null;
        }
        return put(index, { twin: { ...twin, seat, buyerSeat } });
    };

    // Crafter accounts: every Bounty Hunter, and crafterShare of all accounts among the others by a seeded order.
    const hunting = mains.filter(main => !main.station);
    const others = hunting.filter(main => main.line !== BOUNTY_HUNTER).sort((a, b) => hash(`crafter:${seed}:${a.id}`) - hash(`crafter:${seed}:${b.id}`) || a.id - b.id);
    const chosen = new Set(others.slice(0, Math.round(config.crafterShare * hunting.length)).map(main => main.index));
    for (const main of mains) {
        const crafter = !main.station && (main.line === BOUNTY_HUNTER || chosen.has(main.index));
        let twin = null;
        if (crafter) {
            const row = Engine.spotRowOf(view, main), spotTown = row ? view.yields[`${row.spotId}@${main.level}`]?.town : null;
            const starter = start === 'fresh' ? STARTER_VILLAGE[snapshot.races?.[main.line]] || spotTown : spotTown || STARTER_VILLAGE[snapshot.races?.[main.line]];
            const crafts = twinStats(snapshot, main.level).createItem >= 1;
            twin = { ...twinStats(snapshot, main.level), town: null, mode: 'sell', stint: { since: 0, units: 0, goods: '' }, stints: {}, lines: [], bids: [], mp: 0, mpAt: 0,
                recipes: [], decided: [], stock: {}, paid: {}, wallet: 0, batch: null, parked: {}, soldOut: {}, sinceBatch: {}, mpFrom: 0, highest: main.level, seat: { key: 'idleSell', since: 0 },
                needs: {}, surplus: {}, inputMoney: 0 };
            twin.town = config.twinSeat === 'main_town' ? (crafts ? spotTown : null) : config.twinSeat === 'hub' ? (crafts ? firstHub(spotTown, main.index, twin) : null) : starter;
        }
        accounts.push({ index: main.index, crafter, persona: personaOf(config, personaShares, seed, main, crafter), memory: [], twin, counter: 0, lastTown: null, wake: null,
            shotless: false, level: main.level, market: { ...Mains.marketStart(), spotHeld: !!main.spot } });
    }
    // Items held at the start (the goods ledger's opening stock).
    const holdings = () => {
        const out = {};
        const add = (id, count) => { if (Number(id) > 0 && count > 0) out[id] = (out[id] || 0) + count; };
        for (const main of mains) {
            if (main.station) continue;
            for (const [id, count] of Object.entries(main.bag)) add(id, count);
            for (const [id, count] of Object.entries(main.shots)) add(id, count);
            for (const id of Object.values(main.kit)) add(id, 1);
            if (main.weapon && !Object.values(main.kit).includes(main.weapon)) add(main.weapon, 1);
        }
        for (const account of accounts) if (account.twin) for (const [id, count] of Object.entries(account.twin.stock)) add(id, count);
        return out;
    };
    const opening = holdings();
    // The design plane's money: the twins' wallets.
    let side = null;
    const walletSum = () => accounts.reduce((sum, account) => sum + (account.twin ? account.twin.wallet : 0), 0);
    const moneyStart = walletSum();
    // Money of crafter accounts (main and twin) and of the others at the start.
    const moneyByKind = list => {
        const out = { crafters: { accounts: 0, money: 0 }, others: { accounts: 0, money: 0 } };
        for (const main of list) {
            if (main.station) continue;
            const account = accounts[main.index], row = account.twin ? out.crafters : out.others;
            row.accounts++; row.money += main.money + (account.twin ? account.twin.wallet : 0);
        }
        return out;
    };
    const moneyAtStart = moneyByKind(mains);
    // Account money (main + twin wallet), for its Gini.
    const wealth = list => list.filter(main => !main.station).map(main => main.money + (accounts[main.index].twin ? accounts[main.index].twin.wallet : 0));
    const giniStart = gini(wealth(mains));
    const capFloorStatic = staticCapFloor(snapshot, view, game, grades, config, kitHours);

    const wakeAt = (index, now, reason) => {
        const account = accounts[index];
        if (!account.twin) return;
        if (account.wake && account.wake.at === now) { put(index, { wake: { at: now, reasons: [...account.wake.reasons, reason] } }); return; }
        put(index, { wake: { at: now, reasons: [reason] } });
        push({ at: now, kind: 'account_wake', who: index });
    };
    const placeLines = index => { const twin = accounts[index].twin; if (twin.town) Books.place(books, index, twin.town, twin.lines, twin.bids); else Books.remove(books, index); };
    // A twin's sell lines never list more than it holds.
    const clampLines = (lines, stock) => {
        const left = { ...stock };
        return lines.map(line => {
            if (line.side !== 'sell') return line;
            const qty = Math.min(line.qty, Math.max(0, left[line.item] || 0));
            left[line.item] = (left[line.item] || 0) - qty;
            return qty === line.qty ? line : { ...line, qty };
        }).filter(line => line.side !== 'sell' || line.qty > 0);
    };
    const firstAt = (table, key, now, extra) => { if (!(key in table)) table[key] = extra ? { h: now, ...extra } : now; };
    // The grade of the shots a recipe scroll makes (null for any other scroll).
    const shotScrollGrade = id => { const recipe = game.byScroll[id] ? game.recipes[game.byScroll[id]] : null; return recipe && view.items[recipe.productId]?.kind === 'Other.Shot' ? shotGrade(recipe.productId) : null; };
    // The first scroll of a grade's shot recipe that reaches a twin, how, and where its main got it.
    const scrollReached = (id, from, now, where = null) => { const grade = shotScrollGrade(id); if (grade) firstAt(stats.gates.scroll, grade, now, where ? { from, where } : { from }); };
    // Crafter mains already in a grade at the start opened its first gate at hour 0.
    for (const account of accounts) if (account.twin) for (const [grade, from] of grades) if (account.level >= from) firstAt(stats.gates.crafter, grade, 0);
    const hoursToGrade = main => {
        const next = grades.find(([, from]) => from > main.level), row = Engine.spotRowOf(view, main), share = rateOf(main.band).huntShare;
        const exp = row ? Engine.huntExp(main, row, 1) : 0;
        if (!next || !(exp > 0) || !(share > 0)) return 0;
        return Math.max(0, Engine.expAt(view, Math.min(next[1], view.maxLevel)) - main.exp) / (exp * share);
    };
    const markMp = (twin, now) => { stats.mp.available += twin.regen * Math.max(0, now - twin.mpFrom); return { ...twin, mpFrom: now }; };

    // The rules' view of an account's twin at a wake.
    // seatAt: weigh the twin seated in that town, from that town's book alone.
    const viewOf = (index, now, applied = null, rankRecipes = false, seatAt = null) => {
        const account = accounts[index], twin = seatAt ? { ...account.twin, town: seatAt } : account.twin, main = mains[index];
        return { now, self: index, place: seatAt ? { town: null, twinTown: seatAt } : { town: account.lastTown, twinTown: twin.town }, books: books.towns, memory: account.memory, persona: account.persona,
            config, twin, game, npcSell: game.npcByTown[twin.town] || {}, crystalRoute: game.routeByTown[twin.town] || {}, crystalReach: game.reachByTown[twin.town] || {},
            applied, hoursToGrade: hoursToGrade(main), fares: view.fares, rankRecipes, ads: side.adsBook(seatAt),
            own: config.ownUseFirst ? side.ownNeeds(index) : null };
    };

    // A twin's money moves: its account's flows go to its main's start band.
    const flow = (index, kind, adena) => { if (adena) Ledger.recordFlows(ledger, index, { [kind]: adena }); };

    // One wake of an account: the workshop decides, the engine commits.
    function wake(index, now, reason, applied = null) {
        stats.counters.wakes++;
        let twin = accounts[index].twin;
        const arrivedIn = accounts[index].lastTown;
        // main_town, hub: no seat before it can craft; its first seat is where its main resupplies (hub: that hub, else the first).
        if (!twin.town) {
            if (reason !== 'main_arrived' || !arrivedIn || !(twin.createItem >= 1)) { stats.counters.unseatedWakes++; return; }
            twin = putTwin(index, { ...twin, town: config.twinSeat === 'hub' ? firstHub(arrivedIn, index, twin) : arrivedIn }, now).twin;
            stats.counters.firstSeats++;
        }
        // A re-seat, at its main's arrival only: the towns it may move to
        // (starter_then_pays, main_town: the town its main arrived in; hub: the
        // hubs of what it sells) each weighed by the mode rule (its best store
        // there against here, each on its own town's book) and taken only when
        // the gain beats the fare (a buyer twin moves with it: a second fare).
        if (reason === 'main_arrived') {
            const towns = config.twinSeat === 'hub' ? hubsOf(twin.town, index, twin) : arrivedIn ? [arrivedIn] : [];
            let here = null, best = null;
            // The town whose gain net of its fare is the greatest, among those
            // whose gain beats its fare (the hubs' order breaks a tie).
            for (const town of towns) {
                const hop = town === twin.town ? null : view.fares[twin.town]?.[town], fare = hop === null || hop === undefined ? null : hop * (twin.buyer ? 2 : 1);
                if (fare === null || twin.wallet < fare) continue;
                here ||= Workshop.workshop(viewOf(index, now, applied, true, twin.town)).modeValues;
                const there = Workshop.workshop(viewOf(index, now, applied, true, town)).modeValues;
                const net = Workshop.seatGain({ here, there, fare, buyer: !!twin.buyer });
                if (net > 0 && (!best || net > best.net)) best = { town, fare, net };
            }
            if (best) {
                flow(index, 'fares', -best.fare);
                twin = putTwin(index, { ...twin, town: best.town, wallet: twin.wallet - best.fare }, now).twin;
                stats.counters.reseats++;
            }
        }
        const decision = Workshop.workshop(viewOf(index, now, applied, reason === 'main_arrived'));
        stats.counters.gearCapped += decision.counters.gearCapped;
        stats.counters.shelfFull += decision.counters.shelfFull || 0;
        for (const id of decision.counters.stopped) stats.stopped.add(`${index}:${id}`);
        const stock = { ...twin.stock }, paid = { ...twin.paid };
        let wallet = twin.wallet;
        // Inputs bought from other twins' sell lines in its town, first come.
        for (const claim of decision.claims) {
            const live = accounts[claim.owner].twin.lines.find(line => line.id === claim.id && line.side === 'sell');
            const units = Math.min(claim.units, live?.qty || 0, Math.floor(wallet / claim.price));
            if (units <= 0) continue;
            const adena = deal(index, claim.owner, { id: claim.id }, 'sell', claim.item, units, claim.price, now);
            wakeAt(claim.owner, now, 'fill');
            wallet -= adena;
            stock[claim.item] = (stock[claim.item] || 0) + units;
            paid[claim.item] = claim.price;
            stats.counters.twinToTwin += units;
            if (isMaterial(view.items[claim.item])) stats.materials.bought += units;
        }
        const recipes = twin.recipes.filter(id => !decision.forget.includes(id));
        for (const id of decision.forget) {
            const product = game.recipes[id].productId;
            if (view.items[product]?.kind === 'Other.Shot') stats.shotReport.forgets[shotGrade(product)] = (stats.shotReport.forgets[shotGrade(product)] || 0) + 1;
        }
        for (const id of decision.learn) {
            const scroll = game.recipes[id].recipeItemId;
            if (view.items[game.recipes[id].productId]?.kind === 'Other.Shot') firstAt(stats.gates.recipe, shotGrade(game.recipes[id].productId), now, { from: twin.scrollFrom?.[scroll] || 'held at the start' });
            stock[scroll]--;
            goods('learned', scroll, 1);
            recipeRow(scroll).learned++;
            recipes.push(id);
        }
        const crystallize = (piece, count, perPiecePaid, source) => {
            const item = game.items[piece], grade = gradeOf(item), crystal = game.crystalIds[grade.toUpperCase()], made = count * item.crystals;
            goods('crystalIn', piece, count);
            goods('crystalOut', crystal, made);
            stats.crystals[source] += made;
            const byGrade = stats.crystalGrades[grade] ||= { bids: 0, own: 0, npcRoute: 0, used: 0, sold: 0 };
            byGrade[source] += made;
            const before = (stock[crystal] || 0) * (paid[crystal] ?? 0);
            stock[crystal] = (stock[crystal] || 0) + made;
            paid[crystal] = (before + count * perPiecePaid) / stock[crystal];
            firstAt(stats.firsts.crystal, grade, now);
            firstAt(stats.gates.crystal, grade, now, { from: source });
        };
        for (const piece of decision.crystallize) {
            stock[piece.selfId] -= piece.count;
            const source = (twin.bought?.[piece.selfId] || 0) > 0 ? 'bids' : 'own';
            crystallize(piece.selfId, piece.count, paid[piece.selfId] ?? view.items[piece.selfId].npcBuy, source);
        }
        for (const buy of decision.npcBuys) {
            const cost = buy.count * buy.price;
            wallet -= cost;
            flow(index, 'npcBuys', -cost);
            goods('fromNpc', buy.selfId, buy.count);
            stock[buy.selfId] = (stock[buy.selfId] || 0) + buy.count;
            paid[buy.selfId] = buy.price;
            if (isMaterial(view.items[buy.selfId])) stats.materials.npc += buy.count;
        }
        for (const buy of decision.routeBuys) {
            wallet -= buy.count * buy.price;
            flow(index, 'npcBuys', -buy.count * buy.price);
            goods('fromNpc', buy.selfId, buy.count);
            crystallize(buy.selfId, buy.count, buy.price, 'npcRoute');
            stats.materials.npc += buy.count * buy.crystals;
        }
        let batch = twin.batch;
        if (decision.batch) {
            const recipe = game.recipes[decision.batch.recipeId];
            for (const material of recipe.materials) {
                const used = decision.batch.crafts * material.amount;
                stock[material.selfId] -= used;
                goods('craftIn', material.selfId, used);
                if (game.crystalGrade[material.selfId]) {
                    stats.crystals.used += used;
                    (stats.crystalGrades[game.crystalGrade[material.selfId]] ||= { bids: 0, own: 0, npcRoute: 0, used: 0, sold: 0 }).used += used;
                }
            }
            stats.mp.lost += Math.max(0, twin.regen * (now - twin.mpAt) - (twin.maxMp - twin.mp));
            stats.mp.used += decision.batch.crafts * recipe.mpCost;
            const use = stats.crafts[decision.batch.use || 'shelf'];
            use.batches++; use.crafts += decision.batch.crafts; use.mp += decision.batch.crafts * recipe.mpCost;
            batch = { ...decision.batch, start: now };
            stats.waits.batch.opened++;
            push({ at: batch.deadline, kind: 'batch_done', who: index });
            const product = view.items[recipe.productId];
            if (product?.kind === 'Other.Shot') (stats.marginHour[shotGrade(recipe.productId)] ||= []).push(decision.batch.perMp);
        }
        if (decision.stintEnded === 'kept') stats.counters.stintsKept++; else if (decision.stintEnded === 'unfilled') stats.counters.stintsUnfilled++;
        const roll = mulberry(hash(`${seed}:wake:${index}:${counterOf(index)}`))();
        const linesReason = reason === 'batch_done' ? 'batch_applied' : reason;
        const persona = accounts[index].persona;
        const priced = ownLines(twin.lines, { wanted: decision.wanted, prices: decision.prices, persona, sellerLook: config.sellerLook, roll }, linesReason);
        const bids = ownLines(twin.bids, { wanted: decision.bidWanted, prices: decision.bidPrices, persona, sellerLook: config.sellerLook, roll: roll + 0.5 }, linesReason);
        const parked = { ...twin.parked };
        const known = new Set([...twin.lines, ...twin.bids].map(line => line.id));
        for (const [result, kindOf] of [[priced, line => (line.side === 'sell' ? 'sellLine' : 'buyLine')], [bids, () => 'bid']]) {
            for (const line of result.lines) if (!known.has(line.id)) stats.waits[kindOf(line)].opened++;
            for (const { line, why } of result.closed) {
                if (!known.has(line.id)) continue;
                stats.waits[kindOf(line)][why === 'withdrawn' ? 'withdrawn' : why === 'floor' ? 'done' : 'failed']++;
                if (why === 'parked' || why === 'own_route') parked[line.item] = true;
                // An ask at its market floor: the units go to the NPC.
                if (why === 'floor') {
                    const units = Math.min(line.qty, stock[line.item] || 0), value = Math.round(units * (view.items[line.item]?.npcBuy || 0));
                    if (units > 0 && value > 0) { stock[line.item] -= units; wallet += value; flow(index, 'npcSales', value); goods('toNpc', line.item, units); stats.counters.twinToNpc += units; }
                }
            }
        }
        // Its last ask per good it still holds (the price the workshop reads for unsold goods).
        const asks = {};
        for (const [item, price] of Object.entries(twin.asks || {})) if ((stock[item] || 0) > 0) asks[item] = price;
        for (const line of priced.lines) if (line.side === 'sell') asks[line.item] = Math.min(line.price, asks[line.item] ?? Infinity);
        // A sold-out line's step is remembered until a line of the good opens again.
        const soldOut = { ...twin.soldOut };
        for (const line of priced.lines) if (line.side === 'sell') delete soldOut[line.item];
        // A sell line its stock no longer covers is withdrawn.
        const lines = clampLines(priced.lines, stock);
        stats.waits.sellLine.withdrawn += priced.lines.length - lines.length;
        // The workshop's decision to add a recipe changed: its main's occupation re-chooses.
        const wantedBefore = (twin.wants || []).map(row => row.id).sort().join(','), wantedNow = (decision.wants || []).map(row => row.id).sort().join(',');
        if (config.occupationRecipeWant && wantedBefore !== wantedNow) wantChanged.push(index);
        if (decision.buyer && !twin.buyer) stats.counters.buyerTwins++;
        putTwin(index, { ...twin, stock, paid, wallet, recipes, decided: decision.want, wants: decision.wants, batch, mode: decision.mode, buyer: !!decision.buyer, stint: decision.stint, stints: decision.stints, parked, asks, soldOut,
            lines, bids: bids.lines, bought: {}, needs: decision.needs, surplus: decision.surplus, inputMoney: decision.inputMoney }, now);
        placeLines(index);
        // A new sell line in its town is an offer for the mains that want its good.
        for (const line of accounts[index].twin.lines) if (line.side === 'sell' && !known.has(line.id)) side.offerPosted(line.item, accounts[index].twin.town, line.price, index, now);
        while (wantChanged.length) side.recipeWanted(wantChanged.pop(), now);
    }
    const wantChanged = [];

    // The end of a craft batch at its MP deadline: products by a seeded roll
    // per craft (a failed craft destroys its inputs, which the batch's start took).
    function batchDone(index, now) {
        const twin = accounts[index].twin, batch = twin.batch;
        if (!batch || batch.deadline !== now) return;
        const recipe = game.recipes[batch.recipeId], random = mulberry(hash(`${seed}:batch:${index}:${counterOf(index)}`));
        let made = 0;
        for (let i = 0; i < batch.crafts; i++) if (recipe.successRate >= 100 || random() * 100 < recipe.successRate) made++;
        stats.counters.failedCrafts += batch.crafts - made;
        const units = made * recipe.productCount, product = view.items[recipe.productId], grade = gradeOf(product);
        goods('crafted', recipe.productId, units);
        if (units && product?.kind === 'Other.Shot') { firstAt(stats.firsts.shot, shotGrade(recipe.productId), now); shotRow(shotGrade(recipe.productId)).crafted += units; }
        if (units && Engine.isGear(product)) { firstAt(stats.firsts.piece, grade, now, { selfId: recipe.productId }); stats.pieces[grade] = (stats.pieces[grade] || 0) + made; }
        stats.batchHours += now - batch.start;
        stats.waits.batch.deadline++;
        const mp = Math.max(0, batch.mpAtStart + twin.regen * (now - batch.start) - batch.crafts * recipe.mpCost);
        const kept = units;
        putTwin(index, { ...twin, batch: null, mp: Math.min(twin.maxMp, mp), mpAt: now, stock: { ...twin.stock, [recipe.productId]: (twin.stock[recipe.productId] || 0) + kept },
            sinceBatch: kept > 0 ? { ...twin.sinceBatch, [recipe.productId]: 0 } : twin.sinceBatch }, now);
        wake(index, now, 'batch_done', { item: recipe.productId, units: kept });
    }

    // A main takes units from a twin's line (sell) or fills its buy line or
    // bid: money and goods move between the two accounts, both remember the
    // price, the twin's line shrinks (its units sold since its last look
    // grow) and its account wakes on the fill.
    function deal(buyerOrSeller, owner, entry, side, item, count, price, now) {
        const twin = accounts[owner].twin;
        const lines = side === 'bids' ? twin.bids : twin.lines;
        const line = lines.find(row => row.id === entry.id);
        // A bid's units are crystals: a piece fills its crystals at the price per crystal.
        const units = side === 'bids' ? count * game.items[item].crystals : count, adena = units * price;
        const next = lines.map(row => (row === line ? { ...row, qty: row.qty - units, sold: (row.sold || 0) + units } : row)).filter(row => row.qty > 0);
        const stock = { ...twin.stock }, paid = { ...twin.paid };
        let wallet = twin.wallet, bought = twin.bought || {}, soldOut = twin.soldOut, sinceBatch = twin.sinceBatch;
        if (side === 'sell') {
            stock[item] -= count; wallet += adena;
            sinceBatch = { ...sinceBatch, [item]: (sinceBatch?.[item] || 0) + count };
            if (line && line.qty - units <= 0) soldOut = { ...soldOut, [item]: { start: line.start, look: line.look } };
        } else {
            stock[item] = (stock[item] || 0) + count;
            paid[item] = adena / count;
            wallet -= adena;
            bought = { ...bought, [item]: (bought[item] || 0) + count };
        }
        const crystalId = side === 'bids' ? game.crystalIds[gradeOf(view.items[item]).toUpperCase()] : item;
        put(owner, { memory: Knowledge.remember(accounts[owner].memory, { item: crystalId, price }) });
        put(buyerOrSeller, { memory: Knowledge.remember(accounts[buyerOrSeller].memory, { item, price: adena / count }) });
        if (line && line.qty - units <= 0) stats.waits[side === 'sell' ? 'sellLine' : side === 'buy' ? 'buyLine' : 'bid'].done++;
        // A stint counts the fills of its own store's lines, not of its bids.
        const stint = side === twin.mode ? { ...twin.stint, units: twin.stint.units + count } : twin.stint;
        const kept = side === 'bids' ? twin.lines : clampLines(next, stock);
        if (side !== 'bids') stats.waits.sellLine.withdrawn += next.length - kept.length;
        putTwin(owner, { ...twin, stock, paid, wallet, bought, stint, soldOut, sinceBatch, lines: kept, bids: side === 'bids' ? next : twin.bids }, now);
        placeLines(owner);
        stats.botToBot += adena;
        const dealt = view.items[item];
        if (side === 'sell' && dealt?.kind === 'Other.Shot') (stats.priceHour.shots[shotGrade(item)] ||= []).push(price);
        else if (side !== 'bids' && isMaterial(dealt) && dealt.npcBuy > 0) stats.priceHour.materials.push(price / dealt.npcBuy);
        return adena;
    }

    // A visit's commit on the account plane: what the main left its twin, the
    // pooled wallet, and the goods it sold to or bought from the NPC.
    function commitVisit(index, now, out) {
        const twin = accounts[index].twin, loot = stats.loot[twin ? 'pair' : 'other'], at = id => view.items[id]?.npcBuy || 0;
        // Units the main took out of the warehouse's surplus were counted kept
        // when they went in: their sale is not loot sold again.
        const fromSurplus = {};
        for (const claim of out.claims) if (claim.kind === 'own_stock' && claim.surplus) fromSurplus[claim.item] = (fromSurplus[claim.item] || 0) + claim.units;
        const sold = (id, units) => { const known = Math.min(units, fromSurplus[id] || 0); fromSurplus[id] = (fromSurplus[id] || 0) - known; loot.sold += (units - known) * at(id); };
        for (const claim of out.claims) {
            if (claim.kind === 'sell_line' || claim.kind === 'sell_wtb' || claim.kind === 'sell_bid') sold(claim.item, claim.units);
            else if (claim.kind === 'own_bid') loot.kept += at(claim.item);
        }
        for (const stop of out.stops) for (const { selfId: id, count } of stop.items) {
            if (stop.kind === 'npc_sell') sold(id, count);
            else if (stop.kind === 'warehouse' && stop.target === 'deposit') loot.kept += count * at(id);
        }
        if (twin) {
            const stock = { ...twin.stock }, paid = { ...twin.paid }, scrollFrom = { ...twin.scrollFrom };
            for (const stop of out.stops) {
                if (stop.kind !== 'warehouse' || stop.target !== 'deposit') continue;
                for (const { selfId: id, count } of stop.items) {
                    stock[id] = (stock[id] || 0) + count;
                    paid[id] = paid[id] ?? view.items[id]?.npcBuy ?? 0;
                    stats.counters.deposits++;
                    if (isRecipe(id)) {
                        recipeRow(id).kept += count;
                        const route = side.scrollRoute(index, id);
                        scrollFrom[id] = scrollFrom[id] || route.from;
                        scrollReached(id, scrollFrom[id], now, route.where);
                    } else if (isMaterial(view.items[id])) stats.materials.own += count;
                }
            }
            putTwin(index, { ...twin, stock, paid, wallet: out.wallet, scrollFrom }, now);
        }
        for (const stop of out.stops) {
            for (const { selfId: id, count } of stop.items) {
                if (stop.kind === 'npc_sell') { goods('toNpc', id, count); if (isRecipe(id)) recipeRow(id).toNpc += count; }
                if (stop.kind === 'npc_buy') { goods('fromNpc', id, count); if (view.items[id]?.kind === 'Other.Shot') stats.counters.shotsNpc += count; }
            }
            if (stop.kind === 'exchange') { goods('exchangeIn', stop.items[0].selfId, stop.items[0].count); goods('fromNpc', stop.items[1].selfId, 1); }
        }
    }

    // A main's claim on a twin's line or bid (or its own twin's shelf or
    // bid), first come. A sale to a buy line or a bid whose owner's wallet
    // cannot pay fails: no deal, the line is withdrawn, counted (C4: a buy
    // store holds no money beyond the check at its setup). Returns the adena
    // a sale moved, null when it failed.
    function claimOnTwin(index, claim, now) {
        const item = view.items[claim.item], shot = item?.kind === 'Other.Shot';
        if (claim.kind === 'sell_line' || claim.kind === 'buy_line' || claim.kind === 'sell_bid') {
            const side = claim.kind === 'sell_line' ? 'buy' : claim.kind === 'buy_line' ? 'sell' : 'bids';
            const owner = accounts[claim.owner].twin;
            if (claim.adena !== undefined && owner.wallet < claim.adena) {
                const bids = side === 'bids', lines = (bids ? owner.bids : owner.lines).filter(line => line.id !== claim.id);
                if (lines.length < (bids ? owner.bids : owner.lines).length) stats.waits[bids ? 'bid' : 'buyLine'].failed++;
                putTwin(claim.owner, { ...owner, ...(bids ? { bids: lines } : { lines }) }, now);
                placeLines(claim.owner);
                stats.unfunded[bids ? 'bid' : 'line']++;
                return null;
            }
            const adena = deal(index, claim.owner, { id: claim.id }, side, claim.item, claim.units, claim.price, now);
            wakeAt(claim.owner, now, 'fill');
            if (claim.kind === 'sell_line') {
                if (isRecipe(claim.item)) {
                    recipeRow(claim.item).soldToTwins += claim.units;
                    const seller = accounts[claim.owner].twin;
                    if (!seller.scrollFrom?.[claim.item]) put(claim.owner, { twin: { ...seller, scrollFrom: { ...seller.scrollFrom, [claim.item]: 'bought on its buy line' } } });
                    scrollReached(claim.item, 'bought on its buy line', now);
                    const grade = shotScrollGrade(claim.item);
                    if (grade) { const row = stats.scrollDeals[grade] ||= { first: null, last: null, deals: 0, npcBuy: item.npcBuy || 0 }; const deal = { h: now, price: claim.price }; row.first ||= deal; row.last = deal; row.deals++; }
                } else if (isMaterial(item)) stats.materials.bought += claim.units;
            }
            if (claim.kind === 'buy_line' && shot) { stats.counters.shotsLine += claim.units; firstAt(stats.gates.sold, shotGrade(claim.item), now); shotRow(shotGrade(claim.item)).sold += claim.units; }
            if (claim.kind === 'buy_line' && game.crystalGrade[claim.item]) (stats.crystalGrades[game.crystalGrade[claim.item]] ||= { bids: 0, own: 0, npcRoute: 0, used: 0, sold: 0 }).sold += claim.units;
            return adena;
        }
        const twin = accounts[index].twin;
        if (claim.kind === 'own_bid') {
            const crystals = game.items[claim.item].crystals, bids = twin.bids.map(bid => (bid.id === claim.id ? { ...bid, qty: bid.qty - crystals } : bid)).filter(bid => bid.qty > 0);
            stats.waits.bid.done += twin.bids.length - bids.length;
            putTwin(index, { ...twin, bids, stock: { ...twin.stock, [claim.item]: (twin.stock[claim.item] || 0) + 1 }, paid: { ...twin.paid, [claim.item]: item.npcBuy || 0 } }, now);
            placeLines(index);
            return 0;
        }
        if (claim.kind === 'own_stock') {
            const stock = { ...twin.stock, [claim.item]: twin.stock[claim.item] - claim.units }, lines = clampLines(twin.lines, stock);
            // A sell line its main emptied through the warehouse is withdrawn.
            stats.waits.sellLine.withdrawn += twin.lines.length - lines.length;
            putTwin(index, { ...twin, stock, lines, sinceBatch: { ...twin.sinceBatch, [claim.item]: (twin.sinceBatch?.[claim.item] || 0) + claim.units } }, now);
            placeLines(index);
            if (shot) { stats.counters.shotsOwn += claim.units; firstAt(stats.gates.own, shotGrade(claim.item), now); shotRow(shotGrade(claim.item)).own += claim.units; }
        }
        return 0;
    }

    // What its own twin's craft of a piece costs the account, from the twin's town's prices.
    const ownCraft = (index, selfId) => {
        const twin = accounts[index].twin;
        return twin ? Workshop.ownCraft({ twin, game, npcSell: game.npcByTown[twin.town] || {}, crystalReach: game.reachByTown[twin.town] || {}, memory: accounts[index].memory, books: books.towns, self: index }, selfId) : null;
    };
    side = Mains.mainsSide({ snapshot, game, config, view, mains, accounts, books, stats, put, wakeAt, seed, rateOf, gradeOfLevel, grades, shotGrade, hoursToGrade,
        depositFee: DEPOSIT_FEE, kitHours, rearrive, commit, commitVisit, claimOnTwin, wait, ownCraft, tradeTownsOf });

    // At the start: the share of mains, per grade of the shot their spot row
    // fires, who fire it at its first price (the price a twin asks before
    // any deal; a main knows no other at the start: firingOf).
    const worthAtStart = {};
    for (const main of hunting) {
        const hour = Engine.hourOf(view, main), row = Engine.spotRowOf(view, main);
        if (!hour?.shotId || !(row?.shots > 0)) continue;
        const entry = worthAtStart[shotGrade(Engine.shotOf(view, main, hour))] ||= { mains: 0, worthAtOrAboveFirstPrice: 0 };
        entry.mains++;
        if (side.firingOf(main)) entry.worthAtOrAboveFirstPrice++;
    }

    return {
        hunt(main, delta) {
            const kind = accounts[main.index].twin ? 'pair' : 'other';
            for (const [id, count] of delta.drops) { goods('drop', id, count); if (isRecipe(id)) recipeRow(id).dropped += count; stats.loot[kind].dropped += count * (view.items[id]?.npcBuy || 0); }
            if (!delta.shotId) return;
            goods('used', delta.shotId, delta.shotsUsed);
            stats.shotWanted[delta.shotId] = (stats.shotWanted[delta.shotId] || 0) + delta.shotsWanted;
            const grade = shotGrade(delta.shotId), band = main.band;
            const row = stats.shots[grade] ||= { wanted: 0, fired: 0, byBand: {} }, inBand = row.byBand[band] ||= { wanted: 0, fired: 0 };
            row.wanted += delta.shotsWanted; row.fired += delta.shotsUsed; inBand.wanted += delta.shotsWanted; inBand.fired += delta.shotsUsed;
            const spot = Engine.spotRowOf(view, main), town = spot ? view.yields[`${spot.spotId}@${main.level}`]?.town || '?' : '?';
            const byTown = (stats.shotsByTown[grade] ||= {})[town] ||= { wanted: 0, fired: 0 };
            byTown.wanted += delta.shotsWanted; byTown.fired += delta.shotsUsed;
            const hourRow = stats.hour[grade] ||= { wanted: 0, fired: 0, pairWanted: 0, pairFired: 0 };
            hourRow.wanted += delta.shotsWanted; hourRow.fired += delta.shotsUsed;
            if (kind === 'pair') { hourRow.pairWanted += delta.shotsWanted; hourRow.pairFired += delta.shotsUsed; }
            const byKind = stats.shotsKind[kind][grade] ||= { wanted: 0, fired: 0 };
            byKind.wanted += delta.shotsWanted; byKind.fired += delta.shotsUsed;
        },
        visit: (main, now, context) => side.visitMain(main, now, context),
        nextArrival: (main, context) => side.nextArrival(main, context),
        firing: main => side.firingOf(main),
        levelUp(main, now) {
            const index = main.index, account = accounts[index], seen = account.level, before = account.twin?.highest ?? seen;
            const from = gradeOfLevel(seen), to = gradeOfLevel(main.level), gradeChanged = to !== from && main.level > seen;
            put(index, { level: Math.max(seen, main.level) });
            if (gradeChanged) stats.entries[to] = (stats.entries[to] || 0) + 1;
            // The worn kit's hour over the reference kit's at the grade's middle level and as it leaves the grade (its last level).
            const sample = (key, level) => {
                const row = stats.kitHour[key] ||= { level, ratios: [], none: 0, unarmed: 0 }, { ratio, unarmed } = side.kitRatio(main, level);
                if (ratio === null) row.none++; else row.ratios.push(ratio);
                if (unarmed) row.unarmed++;
            };
            const at = grades.findIndex(([name]) => name === to), middle = at >= 0 && at + 1 < grades.length ? Math.floor((grades[at][1] + grades[at + 1][1]) / 2) : null;
            if (middle !== null && seen < middle && main.level >= middle) sample(`${to} middle`, middle);
            if (gradeChanged) sample(`${from} end`, grades.find(([name]) => name === to)[1] - 1);
            if (gradeChanged && account.twin) firstAt(stats.gates.crafter, to, now);
            if (account.twin && main.level > before) {
                const twin = markMp(account.twin, now), lifted = twinStats(snapshot, main.level);
                const mp = Workshop.mpAt(twin, now);
                if (!twin.batch) stats.mp.lost += Math.max(0, twin.regen * (now - twin.mpAt) - (twin.maxMp - twin.mp));
                putTwin(index, { ...twin, ...lifted, highest: main.level, mp: twin.batch ? twin.mp : Math.min(lifted.maxMp, mp), mpAt: twin.batch ? twin.mpAt : now,
                    parked: gradeOfLevel(before) === to ? twin.parked : {} }, now);
            }
            return side.levelUp(main, now, gradeChanged);
        },
        event(event) {
            const index = event.who, account = accounts[index];
            if (event.kind === 'batch_done') return batchDone(index, event.at);
            if (!account.wake || account.wake.at !== event.at) return;
            const reasons = account.wake.reasons;
            put(index, { wake: null });
            wake(index, event.at, reasons.includes('main_arrived') ? 'main_arrived' : 'fill');
        },
        hour(now) {
            // Wall hours per current band (visits per bot-hour by band).
            for (const main of mains) if (!main.station) stats.visits.botHours[main.band] = (stats.visits.botHours[main.band] || 0) + 1;
            // Velocity: the hour's bot-to-bot adena over the money stock.
            const stock = walletSum() + mains.reduce((sum, main) => sum + main.money, 0);
            stats.velocity.push({ hour: now, moved: stats.botToBot - stats.botToBotHour, stock });
            if (now === 1 || now % 10 === 0) {
                const byTown = {};
                for (const account of accounts) if (account.twin) byTown[account.twin.town || '(no seat)'] = (byTown[account.twin.town || '(no seat)'] || 0) + 1;
                stats.townsAt.push({ hour: now, byTown });
            }
            // The share of each grade's shooters whose own town's book holds a line of their shot.
            const ownLine = {};
            for (const account of accounts) {
                const at = account.market.lineSeen, id = account.market.shotId;
                if (!at || !id) continue;
                const row = ownLine[at.grade] ||= { mains: 0, line: 0 };
                row.mains++; if (Books.rowsOf(books, account.lastTown, 'sell', id).length) row.line++;
            }
            stats.ownTownLine.push({ hour: now, byGrade: Object.fromEntries(Object.entries(ownLine).map(([grade, row]) => [grade, row.line / row.mains])) });
            const seen = {};
            for (const account of accounts) {
                const at = account.market.lineSeen;
                if (!at) continue;
                const row = seen[at.grade] ||= { mains: 0, seen: 0 };
                row.mains++; if (at.seen) row.seen++;
            }
            for (const [grade, row] of Object.entries(seen)) {
                if (row.seen >= 0.1 * row.mains) firstAt(stats.gates.reach10, grade, now);
                if (row.seen >= 0.5 * row.mains) firstAt(stats.gates.reach50, grade, now);
            }
            stats.botToBotHour = stats.botToBot;
            const row = { hour: now, shots: {}, margin: {}, prices: { shots: {}, materials: { median: median(stats.priceHour.materials), deals: stats.priceHour.materials.length } } };
            for (const [grade, values] of Object.entries(stats.priceHour.shots)) row.prices.shots[grade] = { median: median(values), deals: values.length };
            stats.priceHour = { shots: {}, materials: [] };
            for (const [grade, counts] of Object.entries(stats.hour)) row.shots[grade] = { ...counts };
            for (const [grade, values] of Object.entries(stats.marginHour)) row.margin[grade] = { median: median(values), crafts: values.length };
            stats.hourly.push(row);
            stats.hour = {}; stats.marginHour = {};
            return walletSum();
        },
        finish(hours, endMains) {
            for (const account of accounts) {
                if (!account.twin) continue;
                const twin = markMp(account.twin, hours);
                stats.seat[twin.seat.key] += hours - twin.seat.since;
                if (twin.buyerSeat) stats.buyerSeat[twin.buyerSeat.key] += hours - twin.buyerSeat.since;
                if (!twin.batch) stats.mp.lost += Math.max(0, twin.regen * (hours - twin.mpAt) - (twin.maxMp - twin.mp));
                put(account.index, { twin: { ...twin, seat: { key: twin.seat.key, since: hours }, buyerSeat: twin.buyerSeat ? { key: twin.buyerSeat.key, since: hours } : null } });
            }
            return { money: { start: moneyStart, end: walletSum() }, design: report(hours, endMains) };
        }
    };

    // The design's numbers at the end of a run.
    function report(hours, endMains) {
        // Shots left on twin shelves at the end, per grade (units).
        const shotsOnShelves = () => {
            const out = {};
            for (const account of accounts) if (account.twin) for (const [id, count] of Object.entries(account.twin.stock)) {
                if (count > 0 && view.items[id]?.kind === 'Other.Shot') { const grade = shotGrade(id); out[grade] = (out[grade] || 0) + count; }
            }
            return out;
        };
        // Of those, the units on none of its twin's sell lines, per grade.
        const shotsOffLines = () => {
            const out = {};
            for (const account of accounts) if (account.twin) for (const [id, count] of Object.entries(account.twin.stock)) {
                if (!(count > 0) || view.items[id]?.kind !== 'Other.Shot') continue;
                const listed = account.twin.lines.filter(line => line.side === 'sell' && line.item === Number(id)).reduce((sum, line) => sum + line.qty, 0);
                if (count > listed) { const grade = shotGrade(id); out[grade] = (out[grade] || 0) + count - listed; }
            }
            return out;
        };
        const closing = {};
        const add = (id, count) => { if (Number(id) > 0 && count > 0) closing[id] = (closing[id] || 0) + count; };
        for (const main of endMains) {
            if (main.station) continue;
            for (const [id, count] of Object.entries(main.bag)) add(id, count);
            for (const [id, count] of Object.entries(main.shots)) add(id, count);
            for (const id of Object.values(main.kit)) add(id, 1);
            if (main.weapon && !Object.values(main.kit).includes(main.weapon)) add(main.weapon, 1);
        }
        for (const account of accounts) if (account.twin) for (const [id, count] of Object.entries(account.twin.stock)) add(id, count);
        const totals = {}, failing = [];
        for (const id of new Set([...Object.keys(opening), ...Object.keys(closing), ...Object.keys(stats.goods)])) {
            const g = stats.goods[id] || {};
            for (const [field, count] of Object.entries(g)) totals[field] = (totals[field] || 0) + count;
            const expected = (opening[id] || 0) + (g.drop || 0) + (g.crafted || 0) + (g.crystalOut || 0) + (g.fromNpc || 0)
                - (g.used || 0) - (g.craftIn || 0) - (g.crystalIn || 0) - (g.learned || 0) - (g.toNpc || 0) - (g.exchangeIn || 0);
            if (expected !== (closing[id] || 0)) failing.push({ id: Number(id), expected, held: closing[id] || 0 });
        }
        const twins = accounts.filter(account => account.twin);
        const byBand = {}, byClass = {}, byTown = {}, buyersByTown = {};
        for (const account of twins) {
            if (account.twin.buyer) buyersByTown[account.twin.town] = (buyersByTown[account.twin.town] || 0) + 1;
            const main = endMains[account.index];
            byBand[main.band] = (byBand[main.band] || 0) + 1;
            byClass[account.twin.classId] = (byClass[account.twin.classId] || 0) + 1;
            byTown[account.twin.town] = (byTown[account.twin.town] || 0) + 1;
        }
        const lines = twins.flatMap(account => [...account.twin.lines, ...account.twin.bids]);
        const openWaits = { sellLine: twins.reduce((sum, account) => sum + account.twin.lines.filter(line => line.side === 'sell').length, 0),
            buyLine: twins.reduce((sum, account) => sum + account.twin.lines.filter(line => line.side === 'buy').length, 0),
            bid: twins.reduce((sum, account) => sum + account.twin.bids.length, 0), batch: twins.filter(account => account.twin.batch).length,
            shotless: accounts.filter(account => account.shotless).length,
            wts: accounts.reduce((sum, account) => sum + account.market.ads.wts.length, 0), wtb: accounts.reduce((sum, account) => sum + account.market.ads.wtb.length, 0) };
        // Wants open at the end, by state (route, twin, parked) and the piece's grade.
        const parkedAtEnd = {};
        for (const kind of ['route', 'twin', 'parkedWant']) openWaits[kind] = 0;
        for (const account of accounts) for (const [key, want] of Object.entries(account.market.wants)) {
            const grade = gradeOf(view.items[key]), row = parkedAtEnd[grade] ||= {};
            row[want.state] = (row[want.state] || 0) + 1;
            openWaits[want.state === 'parked' ? 'parkedWant' : want.state] = (openWaits[want.state === 'parked' ? 'parkedWant' : want.state] || 0) + (want.state === 'wtb' ? 0 : 1);
        }

        // MP a full shot use would take: the shots wanted x MP per unit of each shot's cheapest recipe.
        let mpNeeded = 0;
        for (const [id, wanted] of Object.entries(stats.shotWanted)) {
            const recipe = (game.byProduct[id] || []).map(rid => game.recipes[rid]).filter(row => !row.quest).sort((a, b) => a.mpCost / a.productCount - b.mpCost / b.productCount)[0];
            if (recipe) mpNeeded += wanted * recipe.mpCost / recipe.productCount;
        }
        return {
            config,
            biases: BIASES,
            market: { obtained: stats.pieces_, openWants: parkedAtEnd, outgrown: stats.outgrown, routes: stats.routes, unfunded: stats.unfunded,
                trips: stats.trips, visits: stats.visits, stock: { ...stats.stock, shotsOnShelves: shotsOnShelves(), shotsOffLines: shotsOffLines() }, shotReport: stats.shotReport, meetings: stats.meetings, paths: stats.paths, unpriced: stats.unpriced, kitHour: kitHourSummary(stats.kitHour), kitTables: { ...stats.kitTables }, kitHours: kitHours.stats ? { ...kitHours.stats } : null,
                capFloor: stats.capFloor, capFloorStatic, worthBounded: stats.worthBounded, occupation: { ...stats.occupation, forScrollMains: stats.scrollMains.size }, events: stats.events,
                velocity: stats.velocity, gini: { start: giniStart, end: gini(wealth(endMains)) }, twinToTwin: stats.counters.twinToTwin, twinToNpc: stats.counters.twinToNpc },
            crafters: { accounts: hunting.length, crafterAccounts: twins.length, share: twins.length / Math.max(1, hunting.length),
                bountyHunterPairs: twins.filter(account => mains[account.index].line === BOUNTY_HUNTER).length,
                otherPairs: twins.filter(account => mains[account.index].line !== BOUNTY_HUNTER).length, byBand, byClass, byTown, buyersByTown },
            crafts: stats.crafts, loot: stats.loot, shotsKind: stats.shotsKind,
            shots: { byGrade: Object.fromEntries(Object.entries(stats.shots).map(([grade, row]) => [grade, { ...row, coverage: row.wanted ? row.fired / row.wanted : null,
                byTown: Object.entries(stats.shotsByTown[grade] || {}).map(([town, t]) => ({ town, ...t, coverage: t.wanted ? t.fired / t.wanted : null })).sort((a, b) => b.wanted - a.wanted) }])),
            supply: { own: stats.counters.shotsOwn, lines: stats.counters.shotsLine, npc: stats.counters.shotsNpc },
            worthAtStart },
            mp: { ...stats.mp, neededForFullShots: mpNeeded },
            // Seat-hours by store state: selling or buying while its store shows a line, idle (by
            // the mode chosen) while it shows none; crafting overlaps them (a batch's MP wait).
            twins: { seat: { ...stats.seat }, buyerSeat: { ...stats.buyerSeat }, buyers: twins.filter(account => account.twin.buyer).length, batchHours: stats.batchHours, mpLost: stats.mp.lost },
            money: { start: moneyAtStart, end: moneyByKind(endMains) },
            firsts: stats.firsts,
            gates: stats.gates, townsAt: stats.townsAt, ownTownLine: stats.ownTownLine, scrollDeals: stats.scrollDeals,
            pieces: Object.fromEntries([...new Set([...Object.keys(stats.pieces), ...Object.keys(stats.entries)])].map(grade => [grade,
                { crafted: stats.pieces[grade] || 0, craftedPerHour: (stats.pieces[grade] || 0) / hours, entries: stats.entries[grade] || 0, entriesPerHour: (stats.entries[grade] || 0) / hours }])),
            materials: { ...stats.materials },
            crystals: { ...stats.crystals, byGrade: stats.crystalGrades },
            shotGrades: stats.shotGrades,
            recipes: stats.recipes,
            liveness: { waits: Object.fromEntries(WAITS.map(kind => [kind, { ...stats.waits[kind], open: openWaits[kind] }])),
                linesAtBound: lines.filter(line => line.bound).length, linesAtBoundThreeLooks: lines.filter(line => line.bound && line.atBound >= 3).length,
                linesAtCost: lines.filter(line => line.floorBy === 'cost').length, linesOpen: lines.length },
            botToBot: stats.botToBot,
            goods: { totals, items: Object.keys(stats.goods).length, failing: failing.length, worst: failing.slice(0, 5) },
            counters: { ...stats.counters, recipesStopped: stats.stopped.size },
            hourly: stats.hourly
        };
    }
}

module.exports = { DESIGN, READINGS, DEPOSIT_FEE, STARTER_VILLAGE, BIASES, gameOf, firstPrices, plane, twinStats, staticCapFloor };
