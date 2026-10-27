'use strict';
// The bot's twin cluster: where a far bot trades and what a far crafter
// offers the market from its own place, decided in the worker. Its town (every
// bot: the one town of its sell shop and its buy store, read through townOf)
// and a crafter's workshop (the recipes it lists and the fee of each).
// Proposed by a worker build (EconomyContext.forState), saved in the bot's
// mind (SavedStats.MIND_KEYS twin), the workshop applied on main as the
// board's w: rows (CraftWorkshopService.indexState) and read at execution
// through entriesOf (CraftWorkshopService.quote, Database craftForCustomer).
const Eligibility = require('./CraftEligibility');
const Profit = require('./CraftProfitPolicy');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Shop = invoke('GameServer/Bot/Economy/CraftShopService');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Karma = require('../../Karma');
const { SELL } = require('../../AfkTrade/BoardIndex');

// The town the bot trades in, the one reader: its twin's town, Floran while
// karma closes the towns. packet: the build that proposed it (its stats
// packet), read before the state's mind it has not reached yet. null: no
// town proposed yet (the caller waits for one).
function townOf(state, packet = null) {
    const town = (packet?.twin || state?.stats?.twin)?.town;
    return town ? Karma.townFor(state?.stats?.karma, town) : null;
}

// The bot's standing sell shop line on a board (worker: the build's board;
// main: AfkTradeService.boardIndex()), the one scan: null when none stands.
function shopLine(state, board) {
    if (typeof board?.ownerLines !== 'function') return null;
    for (const line of board.ownerLines(Number(state?.characterId)) || []) {
        if (line.kind === 'shop' && line.storeType === SELL && line.town) return line;
    }
    return null;
}

// Where the bot's store stands, the one reader (the worker's plan, main's
// listing, the sale trip): the town of its standing shop (a shop never moves,
// N51, so karma does not move it: main refreshes it there), else the town the
// worker's plan carries for it (planned: main applying that plan), else its
// twin's town (townOf: Floran while karma closes the towns). shop: the
// caller's standing shop (shopLine, or main's owner projection); packet:
// as townOf. null: no shop and no twin yet (a station, a bot before its first
// worker build; the caller's grade town follows).
function storeTown(state, shop = null, { packet = null, planned = null } = {}) {
    return shop?.town || planned || townOf(state, packet);
}

// The twin's town at this build: the town of the record that stands (its
// sell shop, else its oldest escrow buy store line), else the held town while
// the bot is on its market trip (stats.marketReturn: the trip goes there) or
// while none of the town's sections moved since the held build (keepTown,
// DecisionSections.COMPUTED.town), else the grade town of what it sells or,
// selling nothing, of what it watches to buy (MarketTownPolicy
// .targetTownForItems: deterministic, no roll). A held workshop holds the
// town like a record: it stands at the twin's place (placeOf).
function townAt(state, { board, watchList = [], findSpot = null, keepTown = false } = {}) {
    const shop = shopLine(state, board);
    if (shop) return shop.town;
    let buy = null;
    for (const line of board.ownerLines(Number(state.characterId)) || []) {
        if (line.kind === 'buy_ad' && line.storeType !== SELL && Number(line.custodyPolicy || 0) === 0 && line.town
            && (!buy || line.recordId < buy.recordId)) buy = line;
    }
    if (buy) return buy.town;
    const held = state.stats?.twin?.town;
    if (held && (keepTown || state.stats?.marketReturn || entriesOf(state)?.length)) return held;
    // Read by a build: the focus part of the held reader (the network splits
    // held stock itself; the state's claims are the previous decision's).
    const sale = Disposition.saleCandidates(state, { preparedReservations: Disposition.reservedEquipmentAmounts(state) });
    const items = sale.length ? sale : watchList.map(row => ({ selfId: Number(row.itemId) }));
    // lazy: cycle MarketTownPolicy reads the twin's town (townOf)
    return invoke('GameServer/Bot/Economy/MarketTownPolicy').targetTownForItems(state, items, findSpot ? { findSpot } : {});
}

// Where the twin's workshop stands, the one reader: in its town (townOf), at
// its sell shop's place when that shop stands there, else at the town's own
// centre (ColdMarketListingService.townCenter exact). Main only: shop = the
// bot's standing store (AfkTradeService.findOwnerProjection, the owner of a
// shop's place; a buy store or a shop in another town is not the workshop's).
// null: no town proposed yet, or a town with no centre of its own (no
// workshop rather than one under a wrong town's name).
function placeOf(state, shop = null) {
    const town = townOf(state);
    if (!town) return null;
    // lazy: worker AfkTradeService is main-thread; placeOf runs on main only
    const stands = shop && invoke('GameServer/AfkTrade/AfkTradeService').kindOf(shop) === 'shop'
        && Number(shop.storeType) === SELL && shop.town === town
        && [shop.locX, shop.locY, shop.locZ].every(value => value != null && Number.isFinite(Number(value)));
    const loc = stands ? { locX: Number(shop.locX), locY: Number(shop.locY), locZ: Number(shop.locZ) }
        // lazy: cycle ColdMarketListingService loads back into TwinCluster
        : invoke('GameServer/Bot/Economy/ColdMarketListingService').townCenter(town, { exact: true });
    return loc ? { town, loc } : null;
}

// What a workshop offers, the one reader: a bot crafter's twin (the worker's
// decision). A Giran station is the player's shop only and proposes none.
// null: no offer saved.
function entriesOf(state) {
    return state?.stats?.twin?.workshop ?? null;
}

// The workshop a fresh build proposes: every known recipe the bot can craft
// (no ranking and no cut until craft-to-order goes through the board; the
// books are small, ~1100 rows over all bots), the fee of each its MP labour
// at the bot's hour (CraftProfitPolicy.labour). The held offer (the bot's twin)
// keeps its order while its recipes are the same, and a recipe keeps its fee
// while the new fee moves by no more than old x error. Returns the twin to
// save, or null: no proposal (no hour value, a station, held offer
// unchanged, nothing to offer and none held). With a board (a worker
// build) it proposes the twin's town too (townAt), for every bot; a moved
// town alone is a proposal.
// book: the bot's known recipe ids; error: its income error
// (DecisionSections.incomeError); mpPerHour: its seated MP recovery;
// watchList, findSpot: the build's watched buys and spot catalog (townAt);
// keepTown: the held build stands for the town (no COMPUTED.town section raised).
function propose(state, { book, hourAdena, mpPerHour, error = 0, board = null, watchList, findSpot, keepTown = false } = {}) {
    if (Shop.isStationService(state)) return null;
    const town = typeof board?.ownerLines === 'function' ? townAt(state, { board, watchList, findSpot, keepTown })
        : state.stats?.twin?.town;
    const moved = !!town && town !== state.stats?.twin?.town;
    const workshop = proposeWorkshop(state, { book, hourAdena, mpPerHour, error });
    if (!workshop && !moved) return null;
    return { ...state.stats?.twin, ...(town ? { town } : {}), ...(workshop ? { workshop } : {}) };
}

function proposeWorkshop(state, { book, hourAdena, mpPerHour, error }) {
    if (!(hourAdena > 0) || !Array.isArray(book) || !Eligibility.isServiceCrafter(state)) return null;
    const held = Array.isArray(state.stats?.twin?.workshop) ? state.stats.twin.workshop : null;
    const fees = new Map();
    for (const id of book) {
        const recipe = Recipes.resolveByRecipeId(Number(id?.recipeId ?? id));
        if (!recipe || fees.has(Number(recipe.recipeId)) || !Eligibility.canCraft(state, recipe)) continue;
        const work = Profit.labour(recipe, { hourAdena, mpPerHour });
        if (work) fees.set(Number(recipe.recipeId), Math.max(1, Math.round(work.adena)));
    }
    const sameSet = held && held.length === fees.size && held.every(entry => fees.has(Number(entry.recipeId)));
    const order = sameSet ? held.map(entry => Number(entry.recipeId)) : [...fees.keys()].sort((a, b) => a - b);
    const heldFees = new Map((held || []).map(entry => [Number(entry.recipeId), Number(entry.price)]));
    const workshop = order.map(recipeId => {
        const fee = fees.get(recipeId), old = heldFees.get(recipeId);
        return { recipeId, price: old > 0 && Math.abs(fee - old) <= old * error ? old : fee };
    });
    if (held ? sameSet && workshop.every((entry, at) => entry.price === Number(held[at].price)) : !workshop.length) return null;
    return workshop;
}

module.exports = { entriesOf, placeOf, propose, shopLine, storeTown, townOf };
