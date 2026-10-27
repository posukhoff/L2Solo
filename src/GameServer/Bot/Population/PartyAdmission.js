const { settlesAtOnce } = require('../../AfkTrade/BoardIndex');
const { partyIdOf } = require('./PartyId');
// All formation paths share this admission budget. Historical origin labels
// never grant slots or protect a party; reservations include in-flight commits.
class PartyAdmission {
    constructor() { this.pending = 0; }
    reserve(parties, config) {
        const limit = Math.max(0, Math.floor(Number(config.maxBackgroundParties) || 0));
        if (parties.length + this.pending >= limit) return null;
        this.pending++;
        let released = false;
        return () => { if (!released) { released = true; this.pending--; } };
    }
}
// Waiting can eventually outweigh a fresh urgent request. Only a current open
// objective contributes age; stale metadata and group origin grant no priority.
function priority(objectives, timestamp) {
    const open = objectives.filter(o => o?.status === 'open');
    if (!open.length) return 0;
    return Math.max(...open.map(o => {
        const urgency = o.priority === 'required' ? 2 : 0;
        const requestedAt = Number(o.requestedAt || 0);
        const age = requestedAt > 0 ? Math.max(0, timestamp - requestedAt) : 0;
        return urgency + Math.min(6, age / 120000);
    }));
}
// E169: admission only. Existing group reviews and accepted trade receipts
// keep their native owner; no departure/return policy is introduced here.
function partyTradeAllowed(direction, state = {}, session = null, preparing = false, accepted = false) {
    if (direction === 'party') return !preparing && !accepted && !state?.stats?.tradeMeeting;
    if (direction === 'trade') return !(partyIdOf(state) || state?.playerPartyId || state?.stats?.playerPartyTakeover?.playerId
        || session?.hotBackgroundPartyId || session?.partyCompanion || session?.followPlayerSession);
    throw new TypeError('invalid_party_trade_direction');
}
let tradeStateFor = id => typeof invoke === 'function'
    ? invoke('GameServer/Bot/Population/BotLifeState')?.cachedState?.(Number(id)) : null;
let tradeSessionFor = id => typeof invoke === 'function'
    ? invoke('GameServer/World/World')?.registeredActorById?.(Number(id))?.session : null;
function configureTradeAdmission(stateFor, sessionFor = () => null) {
    tradeStateFor = stateFor;
    tradeSessionFor = sessionFor;
}
// The buyer's own half of the rule: its state and session (looked up when
// none is passed) admit a meeting trade.
function buyerAdmitted(state, session = null) {
    if (session === null && state?.characterId) session = tradeSessionFor(state.characterId);
    return partyTradeAllowed('trade', state, session);
}
// The offer owner's half of the rule: its state and session (looked up when
// none is passed) admit a meeting trade.
function sellerAdmitted(offer, otherState, otherSession = null) {
    const otherId = Number(offer.ownerId ?? offer.sourceId);
    if (otherState === undefined) otherState = tradeStateFor(otherId);
    if (otherSession === null) otherSession = tradeSessionFor(otherId);
    return partyTradeAllowed('trade', otherState, otherSession);
}
function personalOfferAllowed(offer, ownState, otherState, ownSession = null, otherSession = null) {
    // A line that settles at once is open to every buyer; the rule reads a
    // conditional (meeting) line only.
    if (settlesAtOnce(offer)) return true;
    return buyerAdmitted(ownState, ownSession) && sellerAdmitted(offer, otherState, otherSession);
}
// personalOfferAllowed for one buyer over many lines while its own half
// cannot move (one reader of one synchronous build): the buyer's half is read
// once, at the first meeting line.
function offerAdmission(ownState) {
    let buyer = null;
    return offer => settlesAtOnce(offer)
        || (buyer ??= buyerAdmitted(ownState)) && sellerAdmitted(offer);
}
// The party rule's flip event (partyrev, user 2026-10-25): write() changes
// the states the rule reads for ownerIds (watchStates: the worker's one
// write path); an owner whose seller half (sellerAdmitted) moved gets a new
// admission revision for every item it holds a meeting line for
// (board.admissionChanged), so a result held on who may take those lines
// (OfferQuery.cheapestIn's fills) drops
// by that revision. A write that throws after storing is a flip too: the
// after-read runs whatever write() does. Returns write()'s result. Cost: 2
// rule reads per owner.
const admissionEvents = { flips: 0, items: 0 };
function admissionWrite(ownerIds, board, write) {
    const before = ownerIds.map(id => sellerAdmitted({ ownerId: id }));
    try {
        return write();
    } finally {
        for (let i = 0; i < ownerIds.length; i++) {
            if (sellerAdmitted({ ownerId: ownerIds[i] }) === before[i]) continue;
            admissionEvents.flips++;
            if (board) admissionEvents.items += board.admissionChanged(ownerIds[i]);
        }
    }
}
// The one write path of the states the rule reads (the worker's
// kernel.states, read by configureTradeAdmission's stateFor): every set and
// delete becomes admissionWrite for its bot (the id and its negative read as
// one), and the board learns that its admission revision follows every flip
// (board.trackAdmission), so its readers may hold a result on it. A board
// no one watches (main's) reports no revision and nothing holds on it.
function watchStates(states, board) {
    const set = states.set.bind(states), remove = states.delete.bind(states);
    states.set = (id, ...rest) => admissionWrite([Math.abs(Number(id))], board, () => set(id, ...rest));
    states.delete = id => admissionWrite([Math.abs(Number(id))], board, () => remove(id));
    board.trackAdmission();
}
// The admission reads a held result made (ColdMarketService's denied trip,
// a main-thread result: main has no one write path for the states and
// sessions the rule reads): [ownerId, allowed] per owner of a conditional
// offer it read. At most ADMISSION_READ_LIMIT owners; one more marks the
// reads overflowed, and an overflowed result never holds. reads: the
// result's array, or null when nothing is held.
const ADMISSION_READ_LIMIT = 8;
function noteRead(reads, ownerId, allowed) {
    if (reads.length > ADMISSION_READ_LIMIT) return;
    const held = reads.find(pair => pair[0] === ownerId);
    if (held) held[1] = allowed;
    else reads.push([ownerId, allowed]);
}
// Every owner read (ColdMarketService: a denial reads whom it read).
function readAdmission(offer, state, reads = null) {
    const allowed = personalOfferAllowed(offer, state);
    if (reads && !settlesAtOnce(offer)) noteRead(reads, Number(offer.ownerId ?? offer.sourceId), allowed);
    return allowed;
}
// The held result still holds for this buyer: every owner it read is admitted
// as it was (the buyer's own half is read again with each).
function admissionReadsHold(reads, state) {
    return reads.length <= ADMISSION_READ_LIMIT
        && reads.every(([ownerId, allowed]) => personalOfferAllowed({ custodyPolicy: 1, ownerId }, state) === allowed);
}
module.exports = { PartyAdmission, priority, partyTradeAllowed, personalOfferAllowed, buyerAdmitted, offerAdmission, watchStates,
    admissionEventCounts: () => ({ ...admissionEvents }), readAdmission, admissionReadsHold, configureTradeAdmission };
