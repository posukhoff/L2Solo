'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Market = invoke('GameServer/Bot/Economy/MarketCounters');
const Demand = require('../src/GameServer/Bot/Economy/MarketDemand');
const Shots = require('../src/GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
const Basket = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
const probe = require('./helpers/workerEconomyDecision');
const originalBoard = Afk.boardIndex;
Market.useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure());

// A crafter's own use of its shots is worth at most buying them at their
// market price (TradeIntent.inputValue, PriceBelief soldPrice): a huge stock
// benefit (1000 hours a shot) with shots traded at 140 values a shot of own
// use at 140 / hourAdena hours; a benefit below that price keeps its own
// value, and so does any benefit of an untraded shot (sold price 0).
{
    const recipe = Recipes.resolveByRecipeId(20), hourAdena = 1000;
    const state = { characterId: 910802, phase: 'cold', currentRegion: 'Giran', level: 40, adena: 10000000,
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { money: [hourAdena, 1 / hourAdena, 0, 0] },
        inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId,
            { selfId: row.selfId, amount: row.amount * 64, stackable: true }])) };
    const trip = () => 0;
    trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const ownStock = new Map(recipe.materials.map(row => [Number(row.selfId), { count: row.amount * 64, unitValue: 0 }]));
    const ownUse = (benefitHours, sold = 140) => Basket.drain(Policy.recipeShotSearch(state, recipe,
        { hourAdena, moneyPrice: 1 / hourAdena, mpPerHour: 1000, trip, price: () => 0,
            soldPrice: id => id === recipe.productId ? sold : 0 }, { ownStock,
            stock: { itemId: recipe.productId, missing: 1000, survivalMissing: 0, target: 1000, benefitHours, unitPrice: 140 },
            prepareExits: function* () { yield 'exit'; return []; },
            preparePurchase: function* () { yield 'quote'; return null; } }));
    const capped = ownUse(1000 * 1000);
    assert.equal(capped?.exit?.type, 'use', 'the crafter makes shots for its own use');
    assert(capped.exit.ownUseUnitHours <= 140 / hourAdena + 1e-12, 'a shot of own use is worth at most its price');
    assert(capped.valueHours <= capped.exit.ownUseUnits * 140 / hourAdena + 1e-9,
        'the batch is worth at most buying the missing shots');
    assert.equal(ownUse(10).exit.ownUseUnitHours, 10 / 1000, 'a benefit below the price keeps its own value');
    assert.equal(ownUse(1000 * 1000, 0).exit.ownUseUnitHours, 1000, 'an untraded shot keeps its own use value');
    console.log('PASS own shot use is worth at most its price');
}

// A stock root whose item node crafts the bot's own shots is a producer row
// with the own-use exit (WishNetwork.build); the craft step crafts it for
// own use from held inputs, and never for an exit the root did not choose.
{
    const Wealth = require('../src/GameServer/Bot/Economy/WealthCraftDecision');
    const recipe = Recipes.resolveByRecipeId(20), hourAdena = 1000;
    const state = { characterId: 910803, accountName: 'bot_pop_shot_own', name: 'OwnShots', phase: 'cold', activity: 'shopping',
        currentRegion: 'Giran', level: 76, adena: 10000000, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
        stats: { classId: 57, money: [hourAdena, 1 / hourAdena, 0, 0] },
        inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId,
            { selfId: row.selfId, amount: row.amount * 64, stackable: true }])) };
    const trip = () => 0;
    trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const ownStock = new Map(recipe.materials.map(row => [Number(row.selfId), { count: row.amount * 64, unitValue: 0 }]));
    const step = (exit, { amount = 1000, r = 0, saleExits = [] } = {}) => Basket.drain(Wealth.producerStep(state,
        [{ key: 'stock:shots', amount, recipeId: 20, exit, recipeReady: true, r }], [20],
        { context: { hourAdena, moneyPrice: 1 / hourAdena, mpPerHour: 1000, trip, price: () => 0, soldPrice: () => 140 },
            options: { ownStock, existing: () => 0,
                stock: { itemId: recipe.productId, missing: 1000, survivalMissing: 0, target: 1000, benefitHours: 1000, unitPrice: 140 },
                prepareExits: function* () { yield 'exit'; return saleExits; },
                preparePurchase: function* () { yield 'quote'; return null; } } }));
    const own = step([-1, 1000]);
    assert.equal(own?.step.craft?.recipeId, 20, 'the own-use row is a shot craft step');
    assert.equal(own.step.craft.exit[0], -1, 'the step crafts for the bot\'s own use');
    assert.equal(step([-1, 100], { amount: 100 })?.step.craft?.batches, 1, 'a shortfall under one batch (156 shots) still crafts');
    assert.equal(step([-2, Policy.townCode('Giran')]), null, 'a listing the root chose but no exit offers is no craft');
    console.log('PASS the network\'s own-use row crafts the bot\'s shots');
}

(async () => {
    for (const recipeId of [20, 21, 317]) {
        const recipe = Recipes.resolveByRecipeId(recipeId), timestamp = Date.now(), board = new BoardIndex();
        Afk.boardIndex = () => board;
        const state = { characterId: 910801, accountName: 'bot_pop_shot_batch', name: 'ShotSmith',
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran', homeRegion: 'Giran', level: 76,
            adena: 10000000, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Object.fromEntries(recipe.materials.map(row => [row.selfId,
                { selfId: row.selfId, amount: row.amount * 64, stackable: true }])), updatedAt: timestamp, timing: {},
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, stats: { classId: 57, money: [1000, .001, 0, 0] } };
        state.persona = invoke('GameServer/Bot/AI/BotPersona').generate(state);
        const batches = [];
        const receipts = [{ quantity: 100 }, { quantity: 10000 },
            ...(recipeId === 21 ? [{ quantity: 10000, fixed: true }] : [])];
        for (const { quantity, fixed } of receipts) {
            Market.reset();
            if (fixed) {
                Market.supplyDeal(recipe.productId, quantity, 'Giran', timestamp - 600000);
                Market.supplyDeal(recipe.productId, quantity, 'Giran', timestamp - 300000);
                assert.equal(Market.itemDeals(recipe.productId).deals, 0, 'the producer starts without any peer shot sale');
            } else {
                Market.deal(recipe.productId, 100, quantity, timestamp - 600000, 12, 'Giran', 13);
                Market.deal(recipe.productId, 100, quantity, timestamp - 300000, 14, 'Giran', 15);
            }
            let rows;
            Market.publish({ register: (_name, source) => { rows = source.allRows(); }, changed: () => {} });
            const result = await probe(state, { recipeEarning: true, refreshEconomy: true, timestamp,
                recipes: { recipeBook: Codec.pack([recipeId]) },
                tablePages: [{ tables: [
                    { name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true },
                    { name: 'market', from: null, to: 0, full: true, rows: rows.map(row => [row[0], row]), removed: [], last: true }
                ] }] });
            const selected = Policy.unpackStep(Policy.packStep(result.selected));
            // Weak demand may pay no craft: the producer root's net at the
            // bot's own prices decides (WishProviders), not this test.
            if (quantity === 100 && !selected?.craft) {
                batches.push(0);
                console.log(JSON.stringify({ recipeId, observedPurchase: quantity, batches: 0 }));
                continue;
            }
            assert.equal(selected?.craft?.recipeId, recipeId, 'the actual worker chooses the known shot recipe');
            const native = Shots.recheck(state, selected.craft);
            assert(native && native.expectedSold > 0, 'the selected larger quantity passes the native sale and craft recheck');
            assert(native.batches * recipe.mpCost <= state.vitals.mp, 'production remains within actual mana');
            // A listing sells its lot over the forecast's time (T74): the lot
            // is what one forecast window takes, rounded up to a whole craft.
            assert(native.expectedSold <= Demand.forecast(recipe.productId, 'Giran', timestamp).applicableUnits
                + Number(recipe.productCount), 'output stays within the lots one window of observed demand takes');
            if (quantity === 10000) {
                assert.equal(Shots.recheck({ ...state, vitals: { ...state.vitals, mp: recipe.mpCost } }, selected.craft), null,
                    'the larger command is refused when its mana is no longer available');
                assert.equal(Shots.recheck({ ...state, inventory: { ...state.inventory,
                    [recipe.productId]: { selfId: recipe.productId, amount: 1000000, stackable: true } } }, selected.craft), null,
                    'existing unsold output prevents another large production batch');
            }
            batches.push(native.batches);
            console.log(JSON.stringify({ recipeId, observedPurchase: quantity, fixed: !!fixed,
                batches: native.batches, output: native.batches * recipe.productCount }));
        }
        assert(batches[1] > batches[0], 'stronger observed demand produces a larger shot batch');
        assert(batches[1] >= 5, 'a stocked crafter can serve large demand beyond one or two recipe batches');
    }
    console.log('PASS shot production scales with public demand through worker, command codec and native recheck');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Afk.boardIndex = originalBoard; Market.reset();
});
