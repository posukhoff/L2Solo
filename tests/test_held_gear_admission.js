'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('held-gear-admission');
require('../src/Global');
fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');

// T79 (user 10-28, option c): gear admission and the path choice price the
// cash the wallet holds at the held money's price of the same build
// (WishNetwork.heldPriceAhead over each family's best row and the roots
// built before admission; the build reads the rows its caps left out), the
// lacking part at the hunt rate. Checked through the real build
// (EconomyContext.forState: WishProviders admission, WishNetwork, the money
// packet), only the hunt rate fixed (a poor field).
const trip = town => town === 'Dion' ? 0 : Infinity;
trip.details = town => ({ known: town === 'Dion', hours: .05, fees: 0 });
const deps = { spots: [], board: new BoardIndex(), tripCost: trip, knowledgeEnabled: false,
    npcOffersFor: id => Market.npcOffers(id, 'Dion'), timestamp: 1791464400000 };
const huntIncome = Hunt.huntIncome;
// A bot of `level` and `classId` holding `adena`, every slot but `open`
// wearing its strongest piece at the level (the second earring and ring the
// next one), then `worn` ([slot, item]) over that.
function bot(level, classId, adena, { open = [], worn = [] } = {}) {
    const state = { characterId: 912, name: 'HeldGear', accountName: 'bot_912', phase: 'cold', activity: 'hunting', level, adena,
        currentRegion: 'Dion', loc: { locX: 19223, locY: 146228, locZ: -3069 }, timing: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
        stats: { classId, exp: Data.experience[level - 1] + 1, generatedCold: true, decisionSeq: 1,
            persona: { primaryDrive: 'progression', understanding: 1, traits: { ambition: 0, commitment: 0,
                caution: .5, resilience: .5, assertiveness: .5, empathy: .5, sociability: .5 } } },
        inventory: {} };
    const wear = (slot, selfId) => {
        for (const id of Object.keys(state.inventory)) if (state.inventory[id].slot === slot) delete state.inventory[id];
        state.inventory[selfId] = { selfId, amount: 1, slot, equipped: true, equippedCount: 1 };
    };
    for (const [slot, rows] of Providers.gearCandidates(state)) {
        const pick = rows[[2, 5].includes(slot) ? 1 : 0];
        if (!open.includes(slot) && pick && !state.inventory[pick.selfId]) wear(slot, pick.selfId);
    }
    for (const [slot, selfId] of worn) wear(slot, selfId);
    return state;
}
function decide(state, perHour) {
    Economy.reset();
    Hunt.huntIncome = (...args) => ({ ...huntIncome(...args), perHour });
    try { return Economy.forState(state, deps); } finally { Hunt.huntIncome = huntIncome; }
}
const queueRow = (context, key) => context.network.queue.find(row => row.key === key);

try {
    // (1) A level-30 bot with 1M and an empty helmet slot on a 10k/h field:
    // the Bone Helmet (31.3k at the NPC, 37.6k landed) would cost 3.76 hunt
    // hours, more than it adds (~3.6 h); the wallet covers every wish it
    // sees, so the held cash costs nothing and it buys the helmet now
    // (before T79: no helmet admitted, it farmed money for a Plate Helmet
    // no one sells).
    const helmet = bot(30, 1, 1e6, { open: [6] });
    const rich = decide(helmet, 10000);
    assert(rich.projection.roots.includes('power:45:6'), 'the 37.6k helmet is admitted');
    assert.equal(rich.network.activity?.rootKey, 'power:45:6');
    assert.equal(rich.network.activity?.activity, 'shopping', 'the bot goes to buy it');
    assert.equal(queueRow(rich, 'power:45:6')?.funded, true);
    const packet = Funding.packetFor(rich.network, rich.hourAdena, 0);
    assert(Funding.spendable({ characterId: 912, adena: 1e6, stats: { money: packet } }, 0, { itemId: 45 }) >= 37560,
        'the executed purchase is funded');

    // (2) A level-37 bot with 300k, a Bone Helmet worn, saving for C gear it
    // cannot cover yet (a 1.15M weapon no one sells): the held money is as
    // dear as earned money (at least the hunt rate), so the 60k Bronze
    // Helmet is not admitted and the weapon stays its goal.
    // A Human Knight: a one-handed sword (a Warrior holds a two-hander, user 10-29).
    const saver = decide(bot(37, 4, 3e5, { worn: [[6, 45], [7, 69]] }), 10000);
    assert(saver.network.heldPrice >= 1 / 10000, 'saving for the weapon keeps held money at the hunt rate');
    assert(!saver.projection.roots.includes('power:46:6'), 'the D helmet does not take the saved money');
    const [, focusId, focusSlot] = String(saver.network.focus?.[0]).split(':');
    assert.equal(focusSlot, '7', 'a weapon stays the focus');
    assert.equal(Data.items.find(item => item.selfId === Number(focusId))?.etc?.rank, 'c',
        'the C weapon stays the focus');
    assert(!saver.network.queue.some(row => row.funded), 'nothing is bought');

    // (3) A level-53 bot with 26M on a 1.5k/h field wearing a D polearm:
    // the B Lance (6.55M belief, no seller) would cost 4367 hunt hours; the
    // wallet covers it, so it is admitted and the bot bids for it at no more
    // than its price belief (before T79: no gear root at all).
    const polearm = bot(53, 3, 26e6, { open: [14], worn: [[14, 297]] }), wealthy = decide(polearm, 1500);
    assert(wealthy.projection.roots.includes('power:97:14'), 'the B weapon is admitted');
    assert.equal(wealthy.network.focus?.[0], 'power:97:14');
    const lance = Intent.project(polearm, wealthy.network, wealthy.projection, 40).find(line => line.itemId === 97);
    assert(lance && lance.worth > 0, 'the bot bids for the lance');
    assert(lance.worth <= wealthy.price(97) * (1 + 1e-9), 'its bid stops at its price belief');
    console.log(JSON.stringify({ helmet: queueRow(rich, 'power:45:6').price, saverHeld: saver.network.heldPrice, lanceBid: Math.round(lance.worth), lanceBelief: Math.round(wealthy.price(97)) }));
    console.log('PASS held money priced at gear admission (T79): a rich bot buys the helmet, a saver keeps its money, a wealthy bot bids its belief');
} finally {
    Hunt.huntIncome = huntIncome; Economy.reset();
    require('node:fs').rmSync(fixture.directory, { recursive: true, force: true });
}
