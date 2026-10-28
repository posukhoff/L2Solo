'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('worn-piece-exit');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');

// T89 part 1 (decisions 10-28): a piece's exit is the best of resale, the
// NPC buy-back and its crystals (BotCrystallization.exitFloor); in a gear
// step the worn piece counts at its exit, not its full price.
const PLATE_HELMET = 2412, FULL_PLATE_HELMET = 2414, BRIGANDINE_HELMET = 2411;
const trip = town => town === 'Dion' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Dion', hours: .05, fees: 0 });
const huntIncome = Hunt.huntIncome;
// A level-37 Warrior with 10M wearing its strongest piece in every slot,
// a Plate Helmet on its head.
function warrior() {
    const state = { characterId: 914, name: 'WornExit', accountName: 'bot_914', phase: 'cold', activity: 'hunting', level: 37,
        adena: 1e7, currentRegion: 'Dion', loc: { locX: 19223, locY: 146228, locZ: -3069 }, timing: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
        stats: { classId: 1, exp: Data.experience[36] + 1, generatedCold: true, decisionSeq: 1,
            persona: { primaryDrive: 'progression', understanding: 1, traits: { ambition: 0, commitment: 0,
                caution: .5, resilience: .5, assertiveness: .5, empathy: .5, sociability: .5 } } },
        inventory: {} };
    const wear = (slot, selfId) => {
        for (const id of Object.keys(state.inventory)) if (state.inventory[id].slot === slot) delete state.inventory[id];
        state.inventory[selfId] = { selfId, amount: 1, slot, equipped: true, equippedCount: 1 };
    };
    for (const [slot, rows] of Providers.gearCandidates(state)) {
        const pick = rows[[2, 5].includes(slot) ? 1 : 0];
        if (pick && !state.inventory[pick.selfId]) wear(slot, pick.selfId);
    }
    wear(6, PLATE_HELMET);
    return state;
}
try {
    // (1) The worn Plate Helmet is asked at 400k on the board and was never
    // traded: its price belief is ~270k, its exit the NPC buy-back (73.5k).
    // On a 4k/h field the Full Plate Helmet's resale less the worn piece's
    // exit leaves the step worth taking (before T89: less its full belief,
    // the step went negative and the bot kept the old helmet).
    const board = new BoardIndex();
    board.put({ id: 91, ownerId: 990472, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 92, selfId: PLATE_HELMET, count: 1, enchant: 0, price: 400000 }] });
    Economy.reset();
    Hunt.huntIncome = (...args) => ({ ...huntIncome(...args), perHour: 4000 });
    const context = Economy.forState(warrior(), { spots: [], board, tripCost: trip, knowledgeEnabled: false,
        npcOffersFor: id => Market.npcOffers(id, 'Dion'), timestamp: 1791464400000 });
    Hunt.huntIncome = huntIncome;
    assert(context.price(PLATE_HELMET) > 2 * Price.buyback(PLATE_HELMET), 'the worn helmet is believed dear');
    assert(context.projection.roots.includes(`power:${FULL_PLATE_HELMET}:6`), 'the helmet step is admitted at the worn piece\'s exit');

    // (2) The floor: a bot with Crystallize breaks a D piece into its
    // crystals (C4: own skill only), so its floor is the better of those at
    // its price and the buy-back; a bot without the skill sells to the NPC.
    const crystal = 400, artisan = { characterId: 915, accountName: 'artisan', level: 30, activity: 'shopping', currentRegion: 'Dion',
        adena: 50000, inventory: {}, stats: { classId: 56, coldCombat: { skills: [{ selfId: 248, level: 1 }] } } };
    const crystals = Crystals.reward(invoke('GameServer/Item/ItemTemplateIndex').find(Data.items, BRIGANDINE_HELMET)).net;
    assert.equal(Crystals.exitFloor(BRIGANDINE_HELMET, () => crystal, artisan), Math.max(Price.buyback(BRIGANDINE_HELMET), crystals * crystal));
    assert(crystals * crystal > Price.buyback(BRIGANDINE_HELMET), 'its crystals pay more than the NPC');
    assert.equal(Crystals.exitFloor(BRIGANDINE_HELMET, () => crystal, warrior()), Price.buyback(BRIGANDINE_HELMET), 'no skill, no crystals');
    assert.equal(Crystals.exitFloor(BRIGANDINE_HELMET, () => 0, artisan), Price.buyback(BRIGANDINE_HELMET), 'unpriced crystals add nothing');
    assert.equal(Crystals.exitFloor(BRIGANDINE_HELMET, () => crystal, { ...artisan, accountName: 'bot_craft_3' }),
        Price.buyback(BRIGANDINE_HELMET), 'a station crafter roots no crystal sale: its floor is the NPC');

    console.log('PASS the worn piece counts at its exit; the exit floor is the better of the buy-back and own crystals');
} finally {
    Hunt.huntIncome = huntIncome; Economy.reset();
    require('node:fs').rmSync(fixture.directory, { recursive: true, force: true });
}
