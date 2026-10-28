'use strict';
// A compact execution of an already selected shared decision, not another
// search/valuation/roll. Full need certificates stay in TradeIntent.project.
const { personalOfferAllowed, offerAdmission } = require('../Population/PartyAdmission');
const { SELL, BUY, offerFields } = require('../../AfkTrade/BoardIndex');
// meetingRefused: the one refusal rule, owned by OfferQuery (its bestBuyerOffer reads it).
const { fill, meetingRefused } = require('./OfferQuery');
const BotImprovementService = invoke('GameServer/Bot/Economy/BotImprovementService');
const MAX_INSPECTED = 20;
const positive = value => Number.isSafeInteger(value) && value > 0;
// The one rule for "a crafting seller may take this buy line as its exit":
// another bot's plain line its party admits and no refused meeting of its own
// (the worker's ColdOccupationSources.prepareExits and main's recheck of the
// saved exit, savedExit).
function buyerExitOpen(line, state) {
    return Number(line.ownerId) !== Number(state?.characterId) && !Number(line.enchant || 0)
        && personalOfferAllowed(line, state) && !meetingRefused(line, state);
}
// A buyer line as a craft's afk exit (the worker's and the recheck's one shape).
function buyerExit(line) {
    return { type: 'afk', conditional: line.custodyPolicy === 1, price: Number(line.price), count: Number(line.count),
        town: line.town, offer: offerFields(line) };
}
// Main's recheck of a worker-saved buyer exit [recordId, lineId, price,
// revision] of productId (compact: [null, lineId, null, revision] among the
// first five bids): the same line at the same revision and price, with units
// left, still open to the seller (buyerExitOpen); else null. Read by
// ColdWealthCraftService.recheck and ColdShotEconomyService.recheck.
function savedExit(board, productId, saved, state) {
    const [recordId, lineId, price, revision] = saved.map(Number);
    const compact = saved[0] == null && saved[2] == null;
    const line = compact ? board.list(productId, BUY).slice(0, 5).find(row => Number(row.lineId) === lineId)
        : board.records.get(recordId)?.find(row => Number(row.lineId) === lineId);
    return line && line.storeType === BUY && line.revision === revision && (compact || line.price === price) && line.count > 0
        && line.selfId === Number(productId) && buyerExitOpen(line, state) ? buyerExit(line) : null;
}
function executable(side, line, state) {
    if (meetingRefused(line, state)) return false;
    if (line.custodyPolicy === 1) return true;
    // Backed purchase records (a player's shop, a bot's escrow buy store)
    // settle immediately. The seller must have reached that town; field
    // answers continue through the physical meeting owner.
    return side === BUY && (line.kind === 'shop' || line.kind === 'buy_ad' && line.botOwned) && line.custodyPolicy === 0
        && state?.activity === 'shopping' && state.currentRegion === line.town
        && BotImprovementService.inTown(state);
}
function encode(side, line, count, state) {
    const tuple = [side, Number(line.selfId), count, Number(line.recordId), Number(line.lineId),
        Number(line.revision), Number(line.price)];
    return [SELL, BUY].includes(side) && tuple.every(positive) && executable(side, line, state) ? tuple : null;
}
// The one rule for "a wish buy takes this meeting-only ad" (the meeting
// executor, its resolve, a bid's outside purchase): a plain ad, taken ad by ad
// for what it holds, as the quote's fill counts it (WishPurchaseEvidence).
function meetingAd(line) {
    return line.custodyPolicy === 1 && !line.enchant;
}
// The one shape test of "my prepared, quoted, executable afk buy" leaf.
function afkBuyLeaf(leaf) {
    return leaf?.activity === 'shopping' && leaf.kind === 'buy' && leaf.sourceType === 'afk'
        && leaf.quoted === true && leaf.executable === true && positive(leaf.itemId)
        && positive(leaf.amount) && positive(leaf.unitPrice) && !!leaf.town;
}
// The one rule for "this ad is part of my prepared afk buy of `units`
// units": the leaf's item and town name the ad, priced at most the leaf's
// quoted unit price (the dearest ask its buy takes, WishPurchaseEvidence),
// and the leaf orders the units (<= leaf.amount); the ad gives what it holds.
function preparedLeaf(line, leaf, units, itemId) {
    return meetingAd(line) && afkBuyLeaf(leaf) && leaf.itemId === Number(itemId)
        && (!line.town || line.town === leaf.town) && line.price <= leaf.unitPrice && leaf.amount >= units;
}
// purchase: the first prepared ad of the town's fill (OfferQuery.fill over
// its lines in board order up to the leaf's unit price, the fill the quote
// made) for what the leaf still orders, at most the ad's count; the rest from
// the next ad on a later step. Shop lines are the arrival buy's
// (ColdMarketService.tryPurchase), skipped here like own, enchanted,
// party-barred and refused (meetingRefused) lines, never counted against a depth.
function purchase(state, economy, board) {
    const leaf = economy?.network?.activity;
    if (economy?.intentPending || !afkBuyLeaf(leaf) || !board?.lines) return null;
    const count = require('../Population/ColdEconomyDecision').remainingToOrder(leaf, state, economy.state || state);
    if (!positive(count)) return null;
    const admitted = offerAdmission(state);
    const taken = fill(board.lines(leaf.itemId, SELL, leaf.town), count, { maxPrice: leaf.unitPrice,
        excludeOwner: state.characterId, ordered: true,
        accept: row => preparedLeaf(row, leaf, count, leaf.itemId) && admitted(row) && !meetingRefused(row, state) }).lines[0];
    return taken ? encode(SELL, taken.line, taken.count, state) : null;
}
function sale(answers, state) {
    const admitted = offerAdmission(state);
    for (const answer of answers || []) {
        if (!admitted(answer.line)) continue;
        const tuple = encode(BUY, answer.line, answer.count, state);
        if (tuple) return tuple;
    }
    return null;
}
// Resolve only the exact indexed quote. A changed quote waits for the next
// native event; it never authorizes a different counterparty or price.
function tradeStateForOwner(id) {
    return typeof invoke === 'function' ? invoke('GameServer/Bot/Population/BotLifeState')?.cachedState?.(Number(id)) : null;
}
function resolve(tuple, board, ownerId) {
    if (!Array.isArray(tuple) || tuple.length !== 7 || !tuple.every(positive)
        || ![SELL, BUY].includes(tuple[0])) return null;
    const [side, selfId, count, recordId, lineId, revision, price] = tuple;
    const line = board?.records?.get(recordId)?.find(row => row.lineId === lineId);
    const state = tradeStateForOwner(ownerId);
    return line && personalOfferAllowed(line, state) && line.storeType === side && executable(side, line, state) && line.selfId === selfId
        && line.ownerId !== Number(ownerId) && line.revision === revision && line.price === price
        && (side === BUY || meetingAd(line)) && line.count >= count ? line : null;
}
module.exports = { meetingAd, meetingRefused, buyerExitOpen, buyerExit, savedExit, preparedLeaf, purchase, sale, resolve, MAX_INSPECTED };
