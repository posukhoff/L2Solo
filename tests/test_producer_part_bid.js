'use strict';
// A crafter whose focus is its own gear also roots a craft for sale whose key
// part no seller offers (T74 live 10-28: Saber Blade, looted ~25/h and sold to
// the NPC at 7525 each, while 39 dwarves know the Saber recipe). That root
// only bids for the part; off focus it must still bid above the part's NPC
// buy-back, or the looter's NPC exit beats the bid and the part never comes
// (docs/game-decisions.md, pricefloor 10-25).
const assert = require('node:assert/strict');
require('../src/Global');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const { WishNetwork } = require('../src/GameServer/Bot/Economy/WishNetwork');

const BUYBACK = 7525, BELIEF = 8300, HOUR = 6347, ASK = 8000;
const shop = (key, itemId, price) => ({ key, price, paths: [{ kind: 'buy', activity: 'shopping', price, itemId,
    executable: true, quoted: true, availableUnits: 1000, town: 'Giran' }] });
// The part: no ask, no NPC; the bot's belief prices it, the NPC buys it back.
const unsold = { key: 'item:2017', price: BELIEF, paths: [{ kind: 'buy', activity: 'shopping', price: BELIEF, itemId: 2017,
    amount: 1, executable: false, availableUnits: 0, buyback: BUYBACK }] };
// A looter lists 4 blades under the crafter's belief.
const listed = { key: 'item:2017', price: BELIEF, paths: [{ kind: 'buy', activity: 'shopping', price: ASK, itemId: 2017,
    executable: true, quoted: true, availableUnits: 4, town: 'Giran', sourceType: 'afk', unitPrice: ASK }] };
const inputs = [['item:2017', 4], ['item:1880', 70], ['item:1879', 70], ['item:2130', 34]].map(([key, amount]) => ({ key, amount }));
// The live Saber root (replay of 2000165), itself the craft path
// (WishProviders producer root): the Dion listing's gross over the bot's
// hour, inputs ~230k.
const resale = { key: 'resale:123', need: 'power', valueHours: 366000 / HOUR, object: { itemId: 123, amount: 1, kind: 'resale' },
    progressionFunding: true, paths: [{ kind: 'craft', activity: 'crafting', costHours: .1, itemId: 123, productCount: 1,
        recipeId: 148, recipeReady: true, quoted: true, town: 'Dion', grossRequirements: inputs }] };
// The focus: a gear piece the bot buys now.
const piece = shop('item:2448', 2448, 41000);
const gear = { key: 'power:2448:9', need: 'power', valueHours: 2000, progressionPriority: 3, object: { itemId: 2448 },
    paths: [{ requirements: [{ key: piece.key, amount: 1 }] }] };

const build = (commitment, part) => new WishNetwork().build({ actorKey: 'smith', inputKey: `part-${commitment}-${part.paths[0].executable}`,
    characterId: 2000165, nodes: [gear, piece, resale, part, shop('item:1880', 1880, 1006), shop('item:1879', 1879, 693),
        shop('item:2130', 2130, 2300)], roots: [gear.key, resale.key], stockFor: () => ({}),
    wallet: 2.5e6, hourAdena: HOUR, persona: { traits: { commitment } }, remembered: false });

// A bot of full commitment (1) weighs every goal off its focus at nothing:
// the craft leaves its queue, no bid (WishNetwork build), as before.
for (const commitment of [0, 0.65]) {
    const network = build(commitment, unsold);
    assert.equal(network.focus?.[0], gear.key, `the gear piece is the focus (commitment ${commitment})`);
    const root = network.queue.find(row => row.key === resale.key);
    assert(root, `the craft for sale stands in the queue (commitment ${commitment})`);
    const row = Intent.project({}, network, {}, 40).find(intent => intent.itemId === 2017);
    assert(row, `the craft for sale bids for its part off focus (commitment ${commitment})`);
    assert(row.worth > BUYBACK, `the part's bid clears its NPC buy-back off focus (commitment ${commitment}: worth ${row.worth}, buy-back ${BUYBACK})`);
    // The focus weight still ranks the root: the gear piece keeps the focus,
    // the craft's queue value is the weighted one.
    if (commitment > 0) assert(root.valueHours < resale.valueHours, `off focus the craft ranks at its weighted value (commitment ${commitment})`);
}
// Once a looter lists the blades under the crafter's belief, the craft still
// pays the ask (its bid and its meeting consent read the same worth).
for (const commitment of [0.65]) {
    const row = Intent.project({}, build(commitment, listed), {}, 40).find(intent => intent.itemId === 2017);
    assert(row && row.worth >= ASK, `the craft for sale pays a listed part's ask off focus (commitment ${commitment}: worth ${row?.worth}, ask ${ASK})`);
}
console.log('PASS producer part bid: an off-focus craft for sale bids for its unsold part above the NPC buy-back and pays a listed one off focus');
