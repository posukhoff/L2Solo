const assert = require('assert');
require('../src/Global');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Service = invoke('GameServer/Bot/Population/PopulationService');
const Executor = invoke('GameServer/Bot/Goals/GoalExecutor');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Trace = invoke('GameServer/Bot/DecisionTrace');
const Situations = invoke('GameServer/Bot/Situations');
// Every stay trip's end leaves one decision-trace record (kind party, phase stay_trip).
const traced = [];
Config.decisionTrace = true;
Trace.connect(batch => { traced.push(...batch.records.map(row => JSON.parse(row))); Trace.ack(batch.id, batch.records.length); });
const lastEnd = () => {
    const ends = traced.filter(row => row.kind === 'party' && row.phase === 'stay_trip');
    traced.length = 0;
    return ends.map(row => [row.bot, row.party, row.outcome, row.reason]);
};
const now = Date.now();
const objective = { status: 'open', priority: 'required', clanGoalKey: 'clan:1:gear', clanId: 1,
    clanOperation: 'equipment', minPartySize: 3, maxPartySize: 9 };
const token = { partyId: 'clan-party', characterId: 3, objective, until: now + 900000 };
let party = { partyId: token.partyId, status: 'active', leaderId: 1, memberIds: [1, 2], spotId: 'test',
    stats: { objective, marketAbsences: { 3: token } } };
const leader = { characterId: 1, name: 'Leader', level: 40, loc: { locX: 100, locY: 200, locZ: -100 },
    party: { partyId: party.partyId }, stats: {} };
const returning = { characterId: 3, name: 'Returning', phase: 'cold', level: 40, activity: 'shopping',
    loc: { locX: 1000, locY: 2000, locZ: -100 }, party: { partyId: null },
    stats: { partyMarketReturn: token, marketReturn: { loc: leader.loc, spotId: 'test' } } };
Parties.find = () => party;
Life.cachedState = id => id === 1 ? leader : null;
Spots.findById = () => ({ id: 'test', name: 'Test' });
Risk.backoffForStates = () => { throw new Error('must not apply solo bans to a clan rendezvous'); };
(async () => {
    const travel = Executor.finishMarketVisit(returning, now);
    assert.deepStrictEqual(travel.stats.travel.to, leader.loc);
    assert.strictEqual(travel.stats.travel.arrivalActivity, 'party_wait');
    assert.strictEqual(lifecycleKind(returning), 'command', 'shopping must execute economy, not clan waiting');
    const arrived = { ...returning, activity: 'party_wait', stats: { partyMarketReturn: token } };
    assert.strictEqual(lifecycleKind(arrived), 'command', 'arrival must attempt membership before any solo resolver');
    require('./helpers/recordedPartyCommit').install();
    Life.statesForParty = async () => [leader, { ...leader, characterId: 2 }];
    Parties.createOrUpdate = async value => (party = value);
    const assigned = [];
    Life.assignParty = async (state, partyId) => { assigned.push({ state, partyId }); return state; };
    const result = await Service.resolveColdState(arrived);
    assert.strictEqual(result.reason, 'returned_to_clan_party');
    assert.deepStrictEqual(party.memberIds, [1, 2, 3]);
    assert.deepStrictEqual(party.stats.marketAbsences, {});
    assert.strictEqual(assigned.find(x => x.state.characterId === 3).state.stats.partyMarketReturn, null);
    assert.deepStrictEqual(lastEnd(), [[3, 'clan-party', 'returned', undefined]], 'a return in time is traced as returned');
    party.status = 'dissolved';
    let saved;
    Life.upsertState = async state => (saved = state);
    await Service.resolveColdState(arrived);
    assert.strictEqual(saved.activity, 'party_wait');
    assert.strictEqual(saved.stats.partyRequest.clanGoalKey, objective.clanGoalKey);
    assert.strictEqual(saved.stats.partyMarketReturn, null);
    assert.deepStrictEqual(lastEnd(), [[3, 'clan-party', 'return_wait', 'party_gone']], 'a stranded waiter is traced with its cause');
    const warehouseObjective = { objectiveKey: 'ordinary-hunt', status: 'open' };
    const warehouseToken = { ...token, objective: warehouseObjective, cleanupReason: 'craft_warehouse' };
    const warehouseArrival = { ...arrived, stats: { partyMarketReturn: warehouseToken } };
    party = { ...party, status: 'active', memberIds: [1, 2], stats: {
        objective: warehouseObjective, marketAbsences: { 3: warehouseToken } } };
    const warehouseReturned = await Service.resolveColdState(warehouseArrival);
    assert.strictEqual(warehouseReturned.reason, 'returned_to_clan_party');
    assert.deepStrictEqual(party.memberIds, [1, 2, 3], 'the ordinary warehouse absence rejoins its party');
    assert(!assigned.at(-1).state.stats.clanPartyObjective, 'an ordinary return creates no clan duty');
    party.status = 'dissolved';
    const warehouseSolo = await Service.resolveColdState(warehouseArrival);
    assert.strictEqual(warehouseSolo.reason, 'craft_warehouse_party_unavailable');
    assert.strictEqual(saved.activity, 'hunting', 'a lost party cannot strand a personal craft in party_wait');
    assert.strictEqual(saved.stats.partyMarketReturn, null);
    assert.deepStrictEqual(lastEnd(), [[3, 'clan-party', 'returned', undefined], [3, 'clan-party', 'unavailable', 'party_gone']]);
    // A return past its ticket: the party had stopped holding the place; it still has room, so the member rejoins,
    // and the trip ends as expired (counted), naming the end it found.
    const expiredCount = () => Situations.counts().raised['party:stay_trip:expired'] || 0, expiredBefore = expiredCount();
    const lateToken = { ...token, until: now - 1, startedAt: now - 1000000 };
    party = { ...party, status: 'active', memberIds: [1, 2], stats: { objective, marketAbsences: { 3: lateToken } } };
    const late = await Service.resolveColdState({ ...arrived, stats: { partyMarketReturn: lateToken } });
    assert.strictEqual(late.reason, 'returned_to_clan_party');
    assert.deepStrictEqual(lastEnd(), [[3, 'clan-party', 'expired', 'returned']], 'a late return is traced as expired');
    assert.strictEqual(expiredCount(), expiredBefore + 1, 'the expiry is counted');
    Config.decisionTrace = false;
    Trace.stop();
    const shopping = { ...returning, stats: { ...returning.stats, townVisit: { completed: false } } };
    assert.strictEqual(Service.finishColdMarketStep(shopping, null, null, null, { state: shopping }, { state: shopping, pending: true }, null), shopping,
        'a supply deal already in progress retains ownership until it completes');
    console.log('Clan market return: live rendezvous, solo risk isolation, same-party return and dissolved-party waiting passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
