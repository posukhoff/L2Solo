'use strict';
// enemy_met (situations.md A2, B8, B10, B11; step 2): a bot meets a grievance peer on a spot at an
// arrival, either one arriving. Pure over what it is given (both threads): no clock, no World, seeded
// rolls. The pairs: each arriving bot against each standing one (the spot's room bounds them, ≤ 36),
// both ways, where the holder remembers the peer (its memory view) or their clans are in a mutual war
// (a grievance of its own, B11). Each pair is decided by the shared PvP/revenge rule
// (RevengePolicy.evaluate with the pair's C4 standing) and rolled once per (holder, peer, arrival step)
// (TendencyRoll 'enemy_met'); the first pair whose roll is under its chance is the meeting, one per
// arrival. Callers: the worker's arrivals (ColdSimulationWorker: a far trip's end, a party's arrival,
// a near post's spot change) and main's visibility for a player and a bot (CharacterVisibility, B8,
// through player()). Counts go on the situations= line (Situations.note), the meeting is traced with
// the spot as subject.
const Policy = require('../../Social/RevengePolicy');
const { coldPair } = require('../../Social/PvpAggression');
const TendencyRoll = require('../AI/TendencyRoll');
const Situations = require('../Situations');
const Trace = require('../DecisionTrace');
// The standing bots one arrival meets (limits.md "enemy_met"): a spot's largest room.
const MAX_STANDING = 36;
const partyIdOf = state => state?.party?.partyId || state?.partyId || null;
const identity = state => ({ id: Number(state.characterId), clanId: Number(state.stats?.clanId || 0), partyId: partyIdOf(state) });

// A far bot that can meet an enemy where it stands: alive on its spot, hunting, no trip, wait or
// errand, no fight under way. A body near a player is its own (main checks it at the command).
function available(state, at) {
    return state?.phase === 'cold' && ['hunting', 'grouped'].includes(state.activity) && state.vitals?.hp > 0
        && state.spotId && !state.stats?.travel && !state.stats?.coldCompetition?.wait
        && !state.stats?.supplyErrand && !state.stats?.warehouseWorkflow && !state.stats?.marketReturn
        && !(state.stats?.pvpEncounter?.expiresAt > at);
}
// The rule's cheap gate for the side that starts a fight (RevengePolicy.startsNoFight): a bot with
// karma starts none unless its clan is in a mutual war (the pair's own war is read at the pair).
// wars: the memory's clan war view.
function mayStart(state, wars) {
    return !Policy.startsNoFight({ ownKarma: state?.stats?.karma,
        war: wars?.hasMutual?.(Number(state?.stats?.clanId || 0)) === true });
}
const hot = state => state?.phase === 'hot';
// May this bot take part (either side): a far one available, a near one by its body (main).
const takesPart = (state, at) => hot(state) || available(state, at);

// Does the holder's memory view name the peer (its character rows, an iterable).
function remembers(memory, holderId, peerId) {
    for (const id of memory.views.get(holderId)?.characterIds || []) if (Number(id) === peerId) return true;
    return false;
}
// One pair, decided: { holder, peer, reason ('revenge' | 'clan_war'), roll, chance } or null.
// wars: the clan war view; step: the arrival's step (the roll's key).
function decide(holder, peer, { memory, personaFor, at, step }) {
    const wars = memory.clanWars;
    const remembered = remembers(memory, Number(holder.characterId), Number(peer.characterId));
    const atWar = wars?.between?.(Number(holder.stats?.clanId || 0), Number(peer.stats?.clanId || 0))?.mutual === true;
    if (!remembered && !atWar) return null;
    if (!mayStart(holder, wars)) return null;
    const relation = memory.assess(identity(holder), identity(peer), {}, at);
    const war = relation.war?.mutual === true;
    const social = Policy.evaluate(relation, personaFor(holder), coldPair(holder, peer, at, war));
    if (!(social.chance > 0)) return null;
    const roll = TendencyRoll.roll('enemy_met', Number(holder.characterId), Number(peer.characterId), step);
    return roll < social.chance ? { holder, peer, reason: social.reason === 'clan_war' ? 'clan_war' : 'revenge', roll, chance: social.chance } : null;
}

// An arrival's meeting. arriving: the arriving bots' states; standing: the bots standing on the spot
// (the arriving ones not among them); spotId; at: the arrival's time; step: its step; memory: the
// interaction memory (views, assess, clanWars); personaFor(state).
// Returns { meeting, kind: 'cold' | 'hot' } or null; a meeting of a far and a near bot is counted
// (enemy_met:mixed) and traced, no fight (B10), and the next pair is read.
function meet({ arriving = [], standing = [], spotId, at, step, memory, personaFor }) {
    const others = standing.filter(state => takesPart(state, at)).slice(0, MAX_STANDING);
    if (standing.length > MAX_STANDING) Situations.note('enemy_met:capped');
    for (const a of arriving) {
        if (!takesPart(a, at)) continue;
        for (const b of others) {
            if (partyIdOf(a) && partyIdOf(a) === partyIdOf(b)) continue;
            for (const [holder, peer] of [[a, b], [b, a]]) {
                const meeting = decide(holder, peer, { memory, personaFor, at, step });
                if (!meeting) continue;
                const kind = hot(holder) && hot(peer) ? 'hot' : !hot(holder) && !hot(peer) ? 'cold' : 'mixed';
                trace(spotId, meeting, kind);
                if (kind === 'mixed') { Situations.note('enemy_met:mixed'); continue; }
                Situations.note(`enemy_met:${meeting.reason}`);
                return { meeting, kind };
            }
        }
    }
    return null;
}
function trace(spotId, meeting, kind) {
    if (Trace.on()) Trace.record({ kind: 'raise', name: 'enemy_met', spot: spotId == null ? undefined : String(spotId),
        bot: Number(meeting.holder.characterId), target: Number(meeting.peer.characterId), reason: meeting.reason, outcome: kind });
}

// A cold meeting as main's competition actions take it (ColdCompetitionActions → ColdPartyConflict):
// the holder starts it. partyOf(id): the party row a bot is in, or null; memoryRevision(id).
function coldEvent({ meeting, spotId, at, step, partyOf, memoryRevision }) {
    const participant = state => {
        const party = partyIdOf(state) ? partyOf(Number(state.characterId)) : null;
        return { id: Number(state.characterId), name: state.name, partyId: party?.partyId || null, size: party?.memberIds?.length || 1,
            partyRevision: party?.revision, revision: Number(state.simulation?.revision || 0), memoryRevision: memoryRevision(Number(state.characterId)) };
    };
    return { key: `enemy_met:${spotId}:${meeting.holder.characterId}:${meeting.peer.characterId}:${step}`, at,
        action: meeting.reason, reason: meeting.reason, spotId, npcId: 0, contextVersion: 1, pvpIntent: true,
        revengeRoll: meeting.roll, chance: meeting.chance, actor: participant(meeting.holder), peer: participant(meeting.peer) };
}
// A hot meeting as main takes it (the worker's spot_command; BotRevenge.request on main).
function hotCommand({ meeting, spotId, at, step }) {
    return { kind: 'enemy_met', key: `enemy_met:${spotId}:${meeting.holder.characterId}:${meeting.peer.characterId}:${step}`, at,
        reason: meeting.reason, actorId: Number(meeting.holder.characterId), peerId: Number(meeting.peer.characterId),
        roll: meeting.roll, chance: meeting.chance };
}

// A player and a bot meet on main (B8: the player's client first receives the bot's CharInfo):
// the bot's grievance toward the player (its memory) or their clans' mutual war, decided by the same
// rule, rolled once per (bot, player, the bot's stay: its spot post's number). relation: main's
// assess of the bot toward the player (InteractionMemoryRuntime); war: their clans' mutual war
// (ClanWarRuntime.between); standing: the pair's C4 standing (PvpAggression.hotStanding of both).
// Returns { reason, roll, chance } or null.
function player({ botId, playerId, stay, relation, persona, standing, war }) {
    if (!relation?.ready || !(relation.personal || war)) return null;
    const social = Policy.evaluate(relation, persona, { ...standing, war: war === true });
    if (!(social.chance > 0)) return null;
    const roll = TendencyRoll.roll('enemy_met', Number(botId), Number(playerId), Number(stay) || 0);
    return roll < social.chance ? { reason: social.reason === 'clan_war' ? 'clan_war' : 'revenge', roll, chance: social.chance } : null;
}
module.exports = { meet, coldEvent, hotCommand, player, available, mayStart, MAX_STANDING };
