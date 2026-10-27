'use strict';
// How long a gear buy may wait (gearstuck, user 2026-10-25): the buy path is
// ready when one unit is the bot's own to buy. An ask that rival takers (bots
// already shopping it in that town) hold before the bot is no step now; with
// no supply observed nothing comes, yet the root stays and the bot's buy bid
// for the item stands (the visible demand that brings a seller); with a
// supply the root stays and waits; once the takers are gone the bot buys it.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation'); require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const MarketDemand = invoke('GameServer/Bot/Economy/MarketDemand');
const CommittedExits = invoke('GameServer/Bot/Economy/CommittedExits');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
function kit(level) {
    const inventory = {};
    for (const row of Gear.planFor({ classId: 3, level }).items) {
        const slots = [...inventory[row.selfId]?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: slots.length, equipped: true,
            equippedCount: slots.length, equippedSlots: slots };
    }
    return inventory;
}
// A C kit at 64 owes the B kit: an A piece is a market-only step, so its
// only path is the board's ask.
const base = { characterId: 990471, classId: 3, level: 64, phase: 'cold', activity: 'hunting', adena: 100000000,
    currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
    inventory: kit(40), stats: { classId: 3, playedHours: 20000 } };
for (const id of [invoke('GameServer/Inventory/ShotStock').planForState(base).selfId, 1061, 736])
    base.inventory[id] = { selfId: id, amount: 100000 };
const higher = Data.items.find(item => item.etc?.rank === 'a' && [7, 14].includes(item.etc.slot)
    && Planner.suitable(item, base, Planner.roleFor(base), 'a'));
assert(higher);
const board = new BoardIndex();
board.put({ id: 91, ownerId: 990472, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 92, selfId: higher.selfId, count: 1, enchant: 0, price: 1 }] });
const review = (state = base, at = board, npcOffersFor = () => [], persona = undefined) => Economy.forState(state, { board: at, spots: [], npcOffersFor, rememberContext: false, persona,
    routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
    workshop: null, workshops: () => [], knownRecipes: [] });
const rooted = context => context.projection.roots.some(key => key.startsWith(`power:${higher.selfId}:`));
const shopping = context => context.network.activity?.itemId === higher.selfId && context.network.activity?.activity === 'shopping';
// Two rivals already shopping the item in Giran (their builds' activity
// leaves, restored as a held card restores them).
const takers = [990480, 990481];
const take = () => { for (const id of takers) CommittedExits.commit(id, [CommittedExits.takerRow({ kind: 'buy', sourceType: 'afk',
    itemId: higher.selfId, amount: 1, town: 'Giran' })]); };

// One ask, no rival taker: the bot buys it now.
assert(shopping(review()), 'an ask nobody else takes is a step now');

// One ask, two rival takers, no supply observed: the unit is theirs and
// nothing comes after it; the bot does not go shopping for it, but it still
// wants the item: its buy bid stands on its watch list (the rows its buy ads
// are made of, BuyAdPolicy.bidFor).
take();
const held = review();
assert(!shopping(held), 'an ask rival takers hold before the bot is no step now');
assert(rooted(held), 'a buy no unit comes for keeps the gear root');
assert((held.watchList || []).some(row => row.itemId === higher.selfId && row.amount >= 1 && Number(row.worth) > 0),
    'the bot whose buy never becomes ready keeps a standing buy bid for the item');

// The never item beside a gear step the bot can buy now (another slot, an
// ask nobody takes): the reachable one is the focus, and the bid for the
// never item still stands.
const armour = Data.items.find(item => item.etc?.rank === 'a' && ![7, 14].includes(item.etc.slot)
    && Planner.suitable(item, base, Planner.roleFor(base), 'a'));
assert(armour);
const both = new BoardIndex();
both.put({ id: 91, ownerId: 990472, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 92, selfId: higher.selfId, count: 1, enchant: 0, price: 1 }] });
both.put({ id: 93, ownerId: 990473, storeType: 1, kind: 'shop', town: 'Dion',
    lines: [{ lineId: 94, selfId: armour.selfId, count: 1, enchant: 0, price: 1 }] });
const beside = review(base, both);
assert(String(beside.network.focus?.[0]).startsWith(`power:${armour.selfId}:`),
    'a goal that can never be bought yields the focus to one the bot can buy');
assert((beside.watchList || []).some(row => row.itemId === higher.selfId && Number(row.worth) > 0),
    'the never item keeps its buy bid while another goal is the focus');
// A bot of full commitment (loyalty 1) weighs every goal off its focus at
// nothing, yet the never item's bid still stands: it is its visible demand.
const own = invoke('GameServer/Bot/AI/BotPersona').of(base) || { traits: {}, understanding: 0.3 };
const devoted = review(base, both, () => [], { ...own, traits: { ...own.traits, commitment: 1 } });
assert(String(devoted.network.focus?.[0]).startsWith(`power:${armour.selfId}:`),
    'a fully committed bot also focuses the goal it can buy');
assert((devoted.watchList || []).some(row => row.itemId === higher.selfId && Number(row.worth) > 0),
    'a fully committed bot keeps the buy bid for the never item');

// The same taken ask, and an NPC shop in another town sells the item: the
// bot buys there now instead of waiting behind the takers.
const npc = id => id === higher.selfId ? [{ town: 'Dion', price: 1000, sourceType: 'npc', npcId: 30001, itemId: id, selfId: id }] : [];
const elsewhere = review(base, board, npc);
assert(shopping(elsewhere) && elsewhere.network.activity.town === 'Dion',
    'an ask rival takers hold sends the bot to the NPC shop of another town');

// The item trades about three units an hour: the bot's unit comes after the
// rivals' in well under its horizon; the root stays, waiting.
for (let at = 0; at < 3; at++) MarketDemand.deal(higher.selfId, 1, 'Giran', Date.now());
const waiting = review();
assert(rooted(waiting), 'a short wait for supply keeps the gear root');
assert(!shopping(waiting), 'a waiting buy is no step now');

// The takers bought or left: the ask is the bot's to buy.
for (const id of takers) CommittedExits.remove(id);
assert(shopping(review()), 'once the rival takers are gone the bot buys the ask');
// A buy of more units than the town's asks hold is a partial fill, never a
// wait: a bot that burns potions fast at its spot (its survival stock, the
// top priority under a kit gap) has none, one potion is on the board, no NPC
// sells it, nobody else buying: the bot shops the one there is. The spot
// table fixture: one spot of the bot's band, measured at about one death and
// two thousand potions an hour (tests/fixtures/gear_buy_wait_spots.json).
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
Table.useFile(require('node:path').join(__dirname, 'fixtures', 'gear_buy_wait_spots.json'));
const potions = { ...base, inventory: { ...base.inventory } };
delete potions.inventory[1061];
const partial = new BoardIndex();
partial.put({ id: 95, ownerId: 990474, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 96, selfId: 1061, count: 1, enchant: 0, price: 50 }] });
const short = review(potions, partial);
Table.useFile();
assert(short.network.activity?.itemId === 1061 && short.network.activity?.activity === 'shopping',
    'a town that sells fewer potions than missing is bought from, not waited for');

// The never root steers nothing while a goal can be reached: its queue row
// (its bid) stays, its steps and its claims do not. The network's own
// entry, with the paths a provider would hand it.
const { WishNetwork } = invoke('GameServer/Bot/Economy/WishNetwork');
const neverBuy = itemId => ({ kind: 'buy', activity: 'shopping', price: 10, itemId, executable: true, quoted: true,
    availableUnits: 1, waitHours: Infinity, town: 'Giran' });
const network = (nodes, roots, stockFor = null) => new WishNetwork().build({ actorKey: 'never-root', inputKey: 'fresh',
    characterId: 990475, nodes, roots, wallet: 100000, hourAdena: 100, stockFor, remembered: false,
    persona: { traits: { commitment: 0 } } });
// A craft the bot can never finish (one input no unit comes for) with a free
// farm input, beside a piece on the board: the bot shops the piece; farming
// the free input of a craft that never finishes is no step. The never craft
// keeps its queue row, the visible demand for its item.
{
    const ore = { key: 'item:301', price: 10, paths: [neverBuy(301)] };
    const hide = { key: 'item:302', price: 0, paths: [{ kind: 'farm', activity: 'hunting', price: 0, costHours: 0.01,
        itemId: 302, executable: true, availableUnits: 100 }] };
    const crafted = { key: 'item:201', price: 500, paths: [{ kind: 'craft', activity: 'crafting', costHours: 0.1, itemId: 201,
        productCount: 1, recipeId: 9, requirements: [{ key: ore.key, amount: 1 }, { key: hide.key, amount: 1 }] }] };
    const neverRoot = { key: 'power:201:7', need: 'power', valueHours: 100, progressionPriority: 3, object: { itemId: 201 },
        paths: [{ requirements: [{ key: crafted.key, amount: 1 }] }] };
    const piece = { key: 'item:202', price: 100, paths: [{ kind: 'buy', activity: 'shopping', price: 100, itemId: 202,
        executable: true, quoted: true, availableUnits: 1, costHours: 1, town: 'Dion' }] };
    const reachable = { key: 'power:202:6', need: 'power', valueHours: 50, progressionPriority: 3, object: { itemId: 202 },
        paths: [{ requirements: [{ key: piece.key, amount: 1 }] }] };
    const built = network([neverRoot, crafted, ore, hide, reachable, piece], [neverRoot.key, reachable.key]);
    assert.equal(built.focus?.[0], reachable.key, 'the goal the bot can reach is the focus');
    assert.equal(built.activity?.itemId, 202, 'the bot shops the piece it can buy, not the free input of a craft it can never finish');
    assert(built.queue.some(row => row.key === neverRoot.key), 'the never craft keeps its queue row (its bid)');
}
// Two crafts share a material the bag holds one of; the higher-priority one
// can never finish (another input no unit comes for). The held material goes
// to the craft the bot can finish: it crafts now instead of buying what it holds.
{
    const shared = { key: 'item:401', price: 20, paths: [{ kind: 'buy', activity: 'shopping', price: 20, itemId: 401,
        executable: true, quoted: true, availableUnits: 10, costHours: 1, town: 'Giran' }] };
    const rare = { key: 'item:402', price: 10, paths: [neverBuy(402)] };
    const craft = (itemId, recipeId, inputs) => ({ key: `item:${itemId}`, price: 500, paths: [{ kind: 'craft', activity: 'crafting',
        costHours: 0.1, itemId, productCount: 1, recipeId, grossRequirements: inputs, requirements: inputs }] });
    const neverCraft = craft(501, 11, [{ key: shared.key, amount: 1 }, { key: rare.key, amount: 1 }]);
    const reachCraft = craft(502, 12, [{ key: shared.key, amount: 1 }]);
    const neverRoot = { key: 'power:501:7', need: 'power', valueHours: 100, progressionPriority: 3, object: { itemId: 501 },
        paths: [{ requirements: [{ key: neverCraft.key, amount: 1 }] }] };
    const reachable = { key: 'power:502:6', need: 'power', valueHours: 50, progressionPriority: 2, object: { itemId: 502 },
        paths: [{ requirements: [{ key: reachCraft.key, amount: 1 }] }] };
    const built = network([neverRoot, neverCraft, shared, rare, reachable, reachCraft], [neverRoot.key, reachable.key],
        id => id === 401 ? { owned: 1, incoming: 0 } : {});
    assert.equal(built.focus?.[0], reachable.key, 'the craft the bot can finish is the focus');
    assert.equal(built.activity?.activity, 'crafting', 'the bot crafts with the material it holds');
    assert.equal(built.activity?.itemId, 502, 'the held material went to the craft the bot can finish, not re-bought');
    assert(built.queue.some(row => row.key === neverRoot.key), 'the never craft keeps its queue row (its bid)');
}
console.log('PASS gear buy wait: never root yields focus, steps and claims and keeps its bid at any loyalty, NPC elsewhere bought, partial fill bought, free ask bought, taker-held ask without supply bid for, with supply kept waiting, freed ask bought');
