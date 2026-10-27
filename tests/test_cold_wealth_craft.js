const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-market-case');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const Service = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
const Policy = invoke('GameServer/Bot/Economy/WealthCraftPolicy');
// The search WealthCraftDecision runs, for one dwarven recipe.
const opportunityFor = (state, recipe, planFor, exits, ownedFor, context) =>
    Policy.chooseQuantity({ state, recipe, planFor, exits, ownedFor, context });
const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
const Shots = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const CraftShop = invoke('GameServer/Bot/Economy/CraftShopService');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const HotWealth = invoke('GameServer/Bot/Economy/HotWealthCraftService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Crafting = invoke('GameServer/Crafting/RecipeCrafting');
const World = invoke('GameServer/World/World');
const nativeChoice = require('./helpers/nativeMarketChoice');

// Craft levels and the native packet use the authored catalogue before the
// original synthetic recipe/item calculator overrides are installed.
DataCache.init();
const originals = { items: DataCache.items, fetchCharacterRecipes: Database.fetchCharacterRecipes,
    fetchItems: Database.fetchItems, craftInventoryItems: Database.craftInventoryItems,
    resolveByRecipeId: Recipes.resolveByRecipeId, offers: AfkTrade.offers,
    buyFromShop: AfkTrade.buyFromShop, sellToShop: AfkTrade.sellToShop,
    upsertState: LifeState.upsertState, refreshInventory: LifeState.refreshInventory,
    record: LifeEvents.record };
function boardLine(id, selfId, count, price) {
    AfkTrade.refreshRecord({ id, ownerId: 9003, ownerName: 'Supplier', ownerAccount: 'bot_9003', kind: 'sell_ad',
        storeType: AfkTrade.SELL, status: 'active', town: 'Giran', title: '', revision: 1, expiresAt: 0,
        locX: 0, locY: 0, locZ: 0, appearance: {}, lines: [{ id: id * 10, selfId, name: `Item ${selfId}`, count, price, enchant: 0 }] });
}
async function run() {
    invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    boardLine(980001, 1864, 2, 10000);
    boardLine(980002, 1865, 1, 5000);
    boardLine(980003, 1867, 6, 500);
    // Two finite dye sellers give two hennas a step now; the second is the
    // first unaffordable priority, so its ratio is the native money floor.
    boardLine(980004, 4529, 10, 16000);
    boardLine(980005, 4541, 10, 16000);
    const originalState = { characterId: 9001, accountName: 'bot_pop_test', name: 'Crafter', phase: 'cold',
        activity: 'shopping', currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
        level: 60, adena: 400000, vitals: { mp: 100 }, inventory: {},
        stats: { classId: 57, generatedIndex: 1787947094937 }, persona: { primaryDrive: 'wealth' } };
    const native = await nativeChoice.capture(originalState, { nativeRoutes: true }, 'wealth_original_before_unit_overrides');
    const state = native.state;
    // MVP-1: money waits only behind a path with a step now, so the decision
    // reads prepared routes (as live does) and the gap is a priced seller.
    assert.notStrictEqual(native.read.activity.activity, 'crafting', 'the unchanged original inputs have no funded synthetic craft leaf');
    assert(native.captured.queue.some(row => !row.funded && Math.round(row.price) === native.state.stats.money[3]),
        'the first unfunded priority with a step now is the money gap, including improvements as well as gear');
    assert(native.state.stats.money[3] > 0, 'the genuine unfunded priority remains a money gap');
    const nativePacket = structuredClone(state.stats.money);
    const productId = 999999;
    const recipe = { type: 'dwarven', recipeId: 90001, level: 4, productId,
        productCount: 1, successRate: 100, mpCost: 20,
        materials: [{ selfId: 1864, amount: 2 }, { selfId: 1865, amount: 1 }] };
    const sellStore = { afkTrade: true, storeType: AfkTrade.SELL };
    const buyStore = { afkTrade: true, storeType: AfkTrade.BUY };
    const purchases = [];
    let exitPrice = 50000, crafted = false, sold = false;
    DataCache.items = [{ selfId: productId, template: { name: 'Test Component', kind: 'Other.Material' },
        etc: { stackable: true, slot: 0 } }];
    Database.fetchCharacterRecipes = async () => [{ recipeId: recipe.recipeId }];
    const originalPhysicalMaterials = [{ id: 10, selfId: 1864, amount: 2 }, { id: 11, selfId: 1865, amount: 1 }];
    Database.fetchItems = async () => structuredClone(originalPhysicalMaterials);
    Database.craftInventoryItems = async () => { crafted = true; throw Error('an unfunded craft reached the physical writer'); };
    Recipes.resolveByRecipeId = recipeId => recipeId === recipe.recipeId ? recipe : null;
    AfkTrade.offers = (selfId, storeType) => {
        if (storeType === AfkTrade.BUY && selfId === productId) return [{
            sourceId: 9002, price: exitPrice, count: 1, store: buyStore, town: 'Giran' }];
        if (storeType !== AfkTrade.SELL) return [];
        return selfId === 1864 || selfId === 1865 ? [{ sourceId: 9003,
            price: selfId === 1864 ? 10000 : 5000, count: selfId === 1864 ? 2 : 1, store: sellStore }] : [];
    };
    AfkTrade.buyFromShop = async (...args) => { purchases.push(args); throw Error('unfunded purchase'); };
    AfkTrade.sellToShop = async () => { sold = true; throw Error('unfunded sale'); };
    // These original facades isolate writer non-entry; no SQLite crafting is claimed.
    LifeState.upsertState = async current => current;
    LifeState.refreshInventory = async () => { throw Error('no product inventory without an actual craft'); };
    LifeEvents.record = async () => null;
    assert.strictEqual(Service.eligible(state, 1000000), true,
        'ordinary generated dwarves must not be mistaken for fixed crafting stations');
    const pledge = { id: 980010, ownerId: state.characterId, ownerName: state.name,
        ownerAccount: state.accountName, kind: 'buy_ad', storeType: AfkTrade.BUY,
        status: 'active', town: 'Giran', revision: 1, escrowAdena: 1,
        expiresAt: 0, appearance: {}, lines: [{ id: 9800100, selfId: 1867, count: 1, price: 1, enchant: 0 }] };
    AfkTrade.refreshRecord(pledge);
    const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
    assert.strictEqual(Market.buyOrderEscrow(state.characterId), 1);
    assert.strictEqual(Service.eligible(state), true,
        'positive off-wallet escrow leaves independent craft eligible');
    for (const [karma, blocked] of [[undefined, false], [null, false], [0, false], [-5, false], ['0', false], [NaN, false], [1, true], ['7', true], [45, true]]) {
        assert.strictEqual(Service.eligible({ ...state, stats: { ...state.stats, karma } }), !blocked,
            `wealth craft with karma ${karma}`);
    }
    assert.strictEqual(Service.eligible({ ...state, level: 36, stats: { ...state.stats, classId: 56 } }), true);
    assert.strictEqual(Service.eligible({ ...state, stats: { ...state.stats, classId: 55 } }), true,
        'a Bounty Hunter can evaluate production within its retained craft skill');
    assert.strictEqual(Service.eligible({ ...state, level: 78, stats: { ...state.stats, classId: 118 } }), true,
        'a Maestro crafts for profit like a Warsmith');
    // The producer root's craft on its chosen buyer line, inputs at 1 adena
    // by default: only the craft level decides below
    // (WealthCraftDecision.producerStep). r: the root's money-queue ratio.
    const producerStep = ({ r = .01, unit = 1, price = 50000, amount = 1, money = [1000, .001, 0, 0] } = {}) => {
        const purchase = count => ({ town: 'Giran', units: count, whole: true, cost: count * unit, landed: count * unit,
            lines: [{ line: { lineId: 1, selfId: 1, revision: 1 }, count, price: unit }], tripDetails: { known: true, hours: 0, fees: 0 } });
        const options = { ownStock: new Map(), existing: () => 0,
            prepareExits: function* () { yield 'quote'; return [{ type: 'afk', price, count: amount, town: 'Giran', trip: 0,
                offer: { recordId: 7, lineId: 70, ownerId: 9002, revision: 1, price, count: amount, town: 'Giran' } }]; },
            preparePurchase: function* (owner, id, count) { yield 'quote'; return purchase(count); } };
        const iterator = Wealth.producerStep({ ...state, stats: { ...state.stats, money } },
            [{ key: `resale:${productId}`, amount, recipeId: recipe.recipeId, exit: [7, 70, price, 1], recipeReady: true, r }], [recipe.recipeId],
            { context: { hourAdena: 1000, moneyPrice: .001, mpPerHour: 100000 }, options });
        let next; do { next = iterator.next(); } while (!next.done);
        return next.value;
    };
    recipe.level = 8;
    assert.strictEqual(CraftShop.canCraft(state, recipe), false, 'recipe8 exceeds level60 craft level7');
    assert.strictEqual(producerStep(), null, 'a recipe above the craft level is skipped');
    recipe.level = 7;
    assert.strictEqual(CraftShop.canCraft(state, recipe), true, 'recipe7 reaches the unchanged actual skill-tree limit');
    assert.strictEqual(producerStep()?.recipe.recipeId, recipe.recipeId, 'a recipe within the craft level is crafted');
    // Inputs 30000 adena, sale 45000: about half the cash comes back as net
    // value. The step spends at its funded root's place in the money queue.
    const halfReturn = producerStep({ r: .002, unit: 10000, price: 45000 });
    assert(halfReturn && halfReturn.valueHours > 0 && halfReturn.valueHours < .001 * 30000,
        'a craft returning about half its cash in net value is made for a funded root');
    assert.strictEqual(halfReturn.r, .002, 'the craft step carries its root\'s money-queue ratio');
    assert.strictEqual(producerStep({ r: 0, unit: 10000, price: 45000 }), null,
        'an unfunded root does not spend cash on its craft inputs');
    // 340000 of the 400000 purse is held for a higher root: the ratio may
    // spend 60000, two 30000 batches of the three the root asks for.
    assert.strictEqual(producerStep({ r: .002, unit: 10000, price: 45000, amount: 3,
        money: [1000, .001, 0, 0, .01, 340000, 99] })?.batches, 2,
    'a root whose ratio cannot pay every batch crafts the batches it can pay');
    // A ratio the money queue already rounded charges its own packet row.
    for (const ratio of [3.86e-6, 9.86e-3]) {
        assert.deepStrictEqual(Funding.packetAfterPurchase([1000, 1e-6, 0, 0, ratio, 5000, 0], 2000, { r: ratio }),
            [1000, 1e-6, 0, 0, ratio, 3000, 0], `a purchase at ratio ${ratio} pays down its root's row`);
    }
    recipe.level = 4;

    // ARCH-NOTE: the original recipe90001/product999999 is an authored unit
    // basket, not a catalogue recipe or native earned-income claim. E1/E3
    // require a paid clock plus the genuine packet before Main may spend.
    const paid = Object.freeze({ hourAdena: 360000, mpPerHour: 3600 });
    const prices = new Map([[1864, 10000], [1865, 5000]]);
    const planFor = (id, amount) => prices.has(id) ? { town: 'Giran', cost: prices.get(id) * amount,
        landed: prices.get(id) * amount, units: amount, whole: true } : null;
    const exit = { type: 'afk', price: 50000, count: 1, trip: 0 };
    const net = (entry, price, inputs, trip = 0) => price * entry.productCount * entry.successRate / 100
        - inputs - entry.mpCost / paid.mpPerHour * paid.hourAdena - trip;
    const labour = recipe.mpCost / paid.mpPerHour * paid.hourAdena;
    assert.strictEqual(labour, 2000, '20MP at 1MP/second priced at 100 Adena/second');
    assert.strictEqual(opportunityFor(state, recipe, planFor, [exit]), null,
        'without a paid clock the original positive is unknown labour');
    const unit = opportunityFor(state, recipe, planFor, [exit], undefined, paid);
    assert(unit, 'the complete original basket is physically affordable and has positive paid net profit');
    assert.strictEqual(unit.basket.cost, 25000);
    assert.strictEqual(unit.basket.cashCost, 25000);
    assert.deepStrictEqual(unit.basket.purchases.map(p => [p.selfId, p.count, p.town]), [[1864, 2, 'Giran'], [1865, 1, 'Giran']]);
    assert.strictEqual(unit.revenue, 50000);
    assert.strictEqual(unit.expectedProfit, net(recipe, 50000, 25000));
    assert.strictEqual(unit.expectedProfit, 23000);
    const breakEven = 25000 + labour;
    assert.strictEqual(breakEven, 27000);
    assert.strictEqual(opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEven }], undefined, paid), null);
    assert.strictEqual(opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEven - 1 }], undefined, paid), null);
    assert.strictEqual(opportunityFor(state, recipe, planFor, [{ ...exit, price: breakEven + 1 }], undefined, paid).expectedProfit, 1);
    assert.strictEqual(opportunityFor({ ...state, adena: 24999 }, recipe, planFor, [exit], undefined, paid), null,
        'cash must cover all original inputs before buying');
    assert.strictEqual(opportunityFor({ ...state, vitals: { mp: 19 } }, recipe, planFor, [exit], undefined, paid), null);
    assert(opportunityFor({ ...state, vitals: { mp: 20 } }, recipe, planFor, [exit], undefined, paid));
    assert.strictEqual(opportunityFor(state, { ...recipe, successRate: 50 }, planFor, [exit], undefined, paid), null,
        'the full input cost and paid clock remain payable on a failed roll');
    assert.strictEqual(net({ ...recipe, successRate: 50 }, 50000, 25000), -2000);
    assert.strictEqual(opportunityFor(state, recipe, planFor, [{ ...exit, count: 0 }], undefined, paid), null);
    assert.strictEqual(opportunityFor(state, recipe, id => id === 1865 ? null : planFor(id, 2), [exit], undefined, paid), null);
    assert.strictEqual(opportunityFor(state, recipe, (id, amount) => ({ ...planFor(id, amount), whole: false }), [exit], undefined, paid), null);
    assert.deepStrictEqual(Profit.materials(originalPhysicalMaterials, recipe), [
        { id: 10, selfId: 1864, amount: 2 }, { id: 11, selfId: 1865, amount: 1 }], 'original complete physical ingredient rows');
    assert.strictEqual(Profit.materials(originalPhysicalMaterials.slice(0, 1), recipe), null, 'missing ore cannot produce the output');
    assert.strictEqual(Profit.succeeds(recipe, () => { throw Error('100% success must not roll'); }), true);
    for (const mp of [100, 80]) {
        const repeatable = opportunityFor({ ...state, vitals: { mp } }, recipe, planFor, [exit], undefined, paid);
        assert(repeatable && repeatable.expectedProfit === 23000, 'a complete funded unit basket has no arbitrary timer');
        assert.strictEqual(mp - recipe.mpCost, mp === 100 ? 80 : 60, 'original two-round MP accounting is a unit fact, not consumed stock');
    }
    const ratio = unit.expectedProfit / paid.hourAdena / unit.basket.cashCost;
    assert(ratio < nativePacket[1], 'the original synthetic gain is below the actual native money floor');
    assert.strictEqual(Funding.spendable(state, 0, { r: ratio }), 0);
    const planning = adena => ({ ...state, adena, stats: { ...state.stats, equipmentPlan: {
        status: 'active', strategy: 'market', target: { selfId: 100, name: 'Planned Gear', slot: 7 },
        market: { town: 'Giran', price: 370000, sourceType: 'npc', reserve: 10000 } } } });
    for (const current of [state, planning(state.adena), planning(state.adena + 380000)]) {
        assert.strictEqual(Funding.spendable(current, 0, { r: ratio }), 0,
            'the original wallet/gear-plan variants do not override the real gain floor');
    }
    const blocked = await Service.execute(state, { ...unit, template: DataCache.items[0], r: ratio });
    assert.strictEqual(blocked.crafted, false);
    assert.strictEqual(blocked.reason, 'purchase_failed');
    assert.strictEqual(blocked.state.adena, originalState.adena);
    assert.deepStrictEqual(blocked.state.inventory, {});
    assert.strictEqual(blocked.state.vitals.mp, 100);
    assert.deepStrictEqual(blocked.state.stats.money, nativePacket);
    assert.strictEqual(purchases.length, 0);
    assert.strictEqual(crafted, false);
    assert.strictEqual(sold, false);
    const stalePurse = { ...state, adena: 1, stats: { ...state.stats, money: [360000, .0000001, 0, 0] } };
    const stale = await Service.execute(stalePurse, { ...unit, template: DataCache.items[0], r: ratio });
    assert.strictEqual(stale.crafted, false, 'native input acquisition rereads the current purse');
    assert.strictEqual(stale.state.adena, 1);
    assert.strictEqual(stale.state.vitals.mp, 100);
    assert.strictEqual(purchases.length, 0);
    assert.strictEqual(crafted, false);
    assert.strictEqual(Market.buyOrderEscrow(state.characterId), 1,
        'a refused stale craft never releases or consumes the accepted pledge');
    const result = await Service.tryCraft(state, 1000000);
    const repeat = await Service.tryCraft(state, 1000001);
    for (const current of [result, repeat]) {
        assert.strictEqual(current.crafted, false, 'unchanged original service state cannot craft without a funded native gain');
        assert.strictEqual(current.state.adena, originalState.adena);
        assert.deepStrictEqual(current.state.inventory, {});
        assert.strictEqual(current.state.vitals.mp, 100);
    }
    assert.strictEqual(Service.eligible(result.state), true, 'a no-craft result introduces no arbitrary eligibility timer');

    const away = { ...state, characterId: 9006, name: 'AwayCrafter', activity: 'hunting', currentRegion: 'Dion',
        loc: { locX: 17000, locY: 145000, locZ: -3000 } };
    const trip = Profit.tripFor(away, paid)('Giran');
    assert(Number.isFinite(trip) && trip > 0, 'actual native routes price the original Dion/Giran round trip');
    const awayPlanFor = (id, amount) => { const plan = planFor(id, amount); return plan && { ...plan, landed: plan.landed + trip }; };
    assert.strictEqual(opportunityFor(away, recipe, awayPlanFor, [{ ...exit, trip }], undefined, paid), null,
        'the real trip outweighs the original 23000 net margin');
    exitPrice = 500000;
    const lucrative = opportunityFor({ ...away, characterId: 9007 }, recipe, awayPlanFor,
        [{ ...exit, price: exitPrice, trip }], undefined, paid);
    assert(lucrative && lucrative.expectedProfit === net(recipe, exitPrice, 25000 + trip, trip));
    assert.strictEqual(lucrative.basket.cashCost, 25000);
    assert.strictEqual(lucrative.basket.cost, 25000 + trip, 'one town trip supplies both original inputs');
    assert.strictEqual(Funding.spendable(away, 0, { r: lucrative.expectedProfit / paid.hourAdena / 25000 }), 0,
        'a remote unit margin still cannot invent native funding or a buying trip');
    exitPrice = 50000;
    assert.strictEqual(purchases.length, 0, 'no goods bought from afar or locally by the unfunded service');

    const leather = { type: 'dwarven', recipeId: 25, level: 1, productId: 1882,
        productCount: 1, successRate: 100, mpCost: 10, materials: [{ selfId: 1867, amount: 6 }] };
    const leatherPlan = (id, count) => id === 1867 ? { town: 'Giran', cost: 500 * count, landed: 500 * count, units: count, whole: true } : null;
    const fixed = opportunityFor({ ...state, characterId: 9004, name: 'ResourceCrafter' }, leather,
        leatherPlan, [{ type: 'afk', price: 10000, count: 1, trip: 0 }], undefined, paid);
    assert(fixed);
    assert.strictEqual(fixed.basket.cost, 3000);
    assert.strictEqual(fixed.expectedProfit, net(leather, 10000, 3000));
    assert.strictEqual(fixed.expectedProfit, 6000);
    assert.deepStrictEqual(Profit.materials([{ id: 12, selfId: 1867, amount: 6 }], leather), [{ id: 12, selfId: 1867, amount: 6 }]);

    // Main waits for the exact guarded worker action; it does not rescan a
    // learned recipe catalogue when no published opportunity is available.
    let emptyReads = 0;
    Database.fetchCharacterRecipes = async () => { emptyReads += 1; return []; };
    const idle = { ...state, characterId: 9005, name: 'WaitingCrafter' };
    for (const now of [1000000, 1000001, 1000000 + 5 * 60 * 1000]) {
        assert.strictEqual((await Service.tryCraft(idle, now)).reason, 'no_profit');
    }
    assert.strictEqual(emptyReads, 0, 'unpublished lifecycle does not scan the learned recipe catalogue');
    assert.strictEqual(purchases.length, 0);
    assert.strictEqual(crafted, false);
    assert.strictEqual(sold, false);
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const sourceBoard = new BoardIndex();
    sourceBoard.put({ id: 991010, ownerId: 991001, storeType: AfkTrade.SELL, custodyPolicy: 1,
        kind: 'sell_ad', town: 'Giran', revision: 1, lines: [{ lineId: 9910100, selfId: 1867, count: 6, price: 1 }] });
    sourceBoard.put({ id: 991011, ownerId: 991002, storeType: AfkTrade.SELL, kind: 'shop', town: 'Giran', revision: 1,
        lines: [{ lineId: 9910110, selfId: 1867, count: 6, price: 500 }] });
    sourceBoard.put({ id: 991012, ownerId: 991001, storeType: AfkTrade.BUY, custodyPolicy: 1,
        kind: 'buy_ad', town: 'Giran', revision: 1, lines: [{ lineId: 9910120, selfId: 1882, count: 1, price: 100000 }] });
    sourceBoard.put({ id: 991013, ownerId: 991002, storeType: AfkTrade.BUY, kind: 'shop', town: 'Giran', revision: 1,
        lines: [{ lineId: 9910130, selfId: 1882, count: 1, price: 90000 }] });
    const Admission = require('../src/GameServer/Bot/Population/PartyAdmission');
    Admission.configureTradeAdmission(id => Number(id) === 991001 ? { characterId: 991001,
        party: { partyId: 'buyer-busy' } } : null);
    const forbiddenExit = { ...unit, template: DataCache.items[0], r: ratio,
        exit: { type: 'afk', conditional: true, price: 50000, town: 'Dion',
            offer: { ownerId: 991001, conditional: true, town: 'Dion' } } };
    const nativeBoardIndex = AfkTrade.boardIndex;
    const syntheticItems = DataCache.items;
    AfkTrade.boardIndex = () => sourceBoard;
    DataCache.items = originals.items;
    Recipes.resolveByRecipeId = id => Number(id) === 25 ? leather : null;
    try {
        const fundedCrafter = { ...state, stats: { ...state.stats, money: [1000, .00001, 0, 0] } };
        const step = { recipeId: 25, batches: 1, exit: [991013, 9910130, 90000, 1], r: .01 };
        const currentBasket = Service.recheck(fundedCrafter, step, [{ recipeId: 25 }]);
        assert(currentBasket, 'a backed native buyer and legal ingredients still pass spending recheck');
        const mpRefusal = {};
        const lowMp = { ...fundedCrafter, vitals: { mp: 0 } };
        assert.strictEqual(Service.recheck(lowMp, step, [{ recipeId: 25 }], mpRefusal), null);
        assert.strictEqual(mpRefusal.reason, 'mp_changed', 'native current MP failure is distinguished from a source rejection');
        assert.strictEqual(await Service.rejectAccepted(lowMp, lowMp, mpRefusal), lowMp,
            'an accepted action waits for MP without invalidating the graph');
        assert.strictEqual(currentBasket.basket.purchases[0].lines[0].line.recordId, 991011,
            'main spending recheck skips the cheaper party personal ingredient supplier');
        assert.strictEqual(Service.recheck(fundedCrafter,
            { ...step, exit: [991012, 9910120, 100000, 1] }, [{ recipeId: 25 }]), null,
        'a selected party personal buyer cannot pass spending recheck');
        assert.strictEqual(Service.recheck(fundedCrafter, { ...step, r: 0 }, [{ recipeId: 25 }]), null,
            'a buyer-line step without its root\'s ratio that must buy inputs goes back to the worker');
        // C8: a craft for sale keeps the worker's listing exit; with no buyer
        // line it crafts and keeps the product, a buyer exit still sells into its line.
        const listingBoard = new BoardIndex();
        listingBoard.put({ id: 991011, ownerId: 991002, storeType: AfkTrade.SELL, kind: 'shop', town: 'Giran', revision: 1,
            lines: [{ lineId: 9910110, selfId: 1867, count: 6, price: 500 }] });
        AfkTrade.boardIndex = () => listingBoard;
        const listingStep = { recipeId: 25, batches: 1, exit: [-2, Shots.townCode('Giran'), 12000, 1] };
        assert.deepStrictEqual(Shots.unpackStep(Shots.packStep({ wealth: { ...listingStep, r: 0.01 } })).wealth,
            { ...listingStep, r: 0.01 }, 'the packed wealth step keeps its listing exit and value ratio');
        // The crafter takes the more valuable craft: a shot step replaces the
        // wealth step only with more value hours; a tie keeps the wealth step.
        const wealthStep = { wealth: { recipeId: 25, batches: 2 } }, shotStep = { craft: { recipeId: 20, batches: 4 } };
        assert.strictEqual(Shots.moreValuableStep({ step: wealthStep, valueHours: 36 }, { step: shotStep, valueHours: 12 }),
            wealthStep, 'a wealth craft worth more than the shot craft is the step');
        assert.strictEqual(Shots.moreValuableStep({ step: wealthStep, valueHours: 12 }, { step: shotStep, valueHours: 20 }),
            shotStep, 'a shot craft worth more than the wealth craft is the step');
        assert.strictEqual(Shots.moreValuableStep({ step: wealthStep, valueHours: 15 }, { step: shotStep, valueHours: 15 }),
            wealthStep, 'equal value keeps the wealth craft');
        assert.strictEqual(Shots.moreValuableStep(null, { step: shotStep, valueHours: 0 }), null,
            'a shot craft of no value is no step');
        assert.strictEqual(Service.recheck(fundedCrafter, listingStep, [{ recipeId: 25 }]), null,
            'a listing step that must buy inputs without a value ratio goes back to the worker');
        assert.strictEqual(Service.recheck(fundedCrafter, { ...listingStep, r: 0.01 }, [{ recipeId: 25 }])?.exit.town, 'Giran',
            'a funded listing step passes the spending recheck with no buyer line');
        const stocked = { ...fundedCrafter, inventory: { 1867: { selfId: 1867, amount: 6 } } };
        const saved = { fetchItems: Database.fetchItems, craft: Database.craftInventoryItems, admit: Database.admitEconomyCommand,
            refresh: LifeState.refreshInventory, upsert: LifeState.upsertState, sell: AfkTrade.sellToShop, offers: AfkTrade.offers };
        Database.fetchItems = async (id, tag) => tag === 'wealth_craft_product' ? [{ id: 13, selfId: 1882, amount: 1 }]
            : [{ id: 12, selfId: 1867, amount: 6 }];
        Database.admitEconomyCommand = async () => ({ command: {}, row: null });
        Database.craftInventoryItems = async () => ({ success: true, units: 1, mp: 90 });
        LifeState.refreshInventory = async next => ({ ...next, inventory: { 1882: { selfId: 1882, amount: 1 } } });
        LifeState.upsertState = async next => next;
        let sale = null;
        AfkTrade.sellToShop = async (characterId, store, selfId, count, terms) => {
            sale = { selfId, count, lineId: terms.lineId };
            return { amount: count, totalPrice: 90000 * count, coldState: terms.coldState };
        };
        try {
            const listed = Service.recheck(stocked, listingStep, [{ recipeId: 25 }]);
            assert.strictEqual(listed?.exit.type, 'listing', 'owned inputs need no value ratio to pass');
            const kept = await Service.execute(stocked, listed);
            assert.strictEqual(kept.crafted, true, 'a listing exit with no buyer line still crafts');
            assert.strictEqual(kept.sold, false);
            assert.strictEqual(kept.reason, 'for_sale', 'the product stays in the bag for the listing');
            assert.strictEqual(kept.state.inventory[1882].amount, 1);
            // A hot crafter runs the producer's listing exit too: the leaf
            // carries it to the spending recheck, which passes with no buyer line.
            const hotSaved = { registered: World.registeredActorById, stateFor: Economy.stateForActor,
                forget: Economy.forget, craftSelf: Crafting.craftSelf };
            const actor = { fetchId: () => stocked.characterId, fetchHp: () => 100, fetchMp: () => 1000,
                fetchPrivateStoreType: () => 0, isDead: () => false, fetchIsOnline: () => true,
                state: { fetchHits: () => false, fetchCasts: () => false },
                backpack: { fetchRecipeBook: () => [{ recipeId: 25 }] } };
            const session = { actor }, registered = { actor, session };
            let craftedHot = null;
            World.registeredActorById = id => Number(id) === stocked.characterId ? registered : null;
            Economy.stateForActor = () => ({ ...stocked, phase: 'hot' });
            Economy.forget = () => {};
            Crafting.craftSelf = async (who, recipeId) => { craftedHot = recipeId; return true; };
            try {
                const hot = await HotWealth.review(session, { statsPacket: {},
                    network: { activity: { activity: 'crafting', rootKey: 'resale:1882', recipeId: 25, exit: listingStep.exit } } });
                assert.deepStrictEqual(hot, { attempted: true, crafted: true },
                    'a hot listing craft with owned inputs and no buyer line crafts');
                assert.strictEqual(craftedHot, 25);
            } finally {
                World.registeredActorById = hotSaved.registered; Economy.stateForActor = hotSaved.stateFor;
                Economy.forget = hotSaved.forget; Crafting.craftSelf = hotSaved.craftSelf;
            }
            assert.strictEqual(sale, null, 'no sale into a buy line for a listing exit');
            AfkTrade.boardIndex = () => sourceBoard;
            const sold = Service.recheck(stocked, step, [{ recipeId: 25 }]);
            assert.strictEqual(sold?.exit.offer.recordId, 991013);
            AfkTrade.offers = (selfId, storeType) => storeType === AfkTrade.BUY && selfId === 1882
                ? [{ ...sold.exit.offer, price: sold.exit.price, count: 1, store: buyStore }] : [];
            const done = await Service.execute(stocked, sold);
            assert.strictEqual(done.reason, 'sold', 'a buyer exit still sells the product into its line');
            assert.deepStrictEqual(sale, { selfId: 1882, count: 1, lineId: 9910130 });
        } finally {
            Database.fetchItems = saved.fetchItems; Database.craftInventoryItems = saved.craft;
            Database.admitEconomyCommand = saved.admit; LifeState.refreshInventory = saved.refresh;
            LifeState.upsertState = saved.upsert; AfkTrade.sellToShop = saved.sell; AfkTrade.offers = saved.offers;
        }
    } finally {
        AfkTrade.boardIndex = nativeBoardIndex;
        DataCache.items = syntheticItems;
        Recipes.resolveByRecipeId = recipeId => recipeId === recipe.recipeId ? recipe : null;
    }
    const writesBefore = purchases.length;
    const blockedBuyer = await Service.execute(state, forbiddenExit);
    assert.strictEqual(blockedBuyer.reason, 'buyer_changed', 'even a remote personal buyer is rejected before acquiring craft inputs');
    assert.strictEqual(blockedBuyer.state.stats.wishDirty, Sections.sectionBit('sources'));
    assert.strictEqual(blockedBuyer.state.stats.activityLeaf, 0, 'native buyer rejection retires only the accepted work');
    assert.deepStrictEqual(blockedBuyer.state.inventory, state.inventory);
    assert.strictEqual(blockedBuyer.state.adena, state.adena, 'a source event cannot buy inputs or acquire knowledge');
    const beforeCached = LifeState.cachedState, beforePersist = LifeState.upsertState;
    let current = { ...state, adena: state.adena + 3 }, sourceWrites = 0;
    LifeState.cachedState = () => current;
    LifeState.upsertState = async next => { sourceWrites++; current = next; return next; };
    try {
        const rejected = await Service.rejectAccepted(state);
        assert.strictEqual(rejected.adena, state.adena + 3, 'a rejection preserves the newest native wallet after an await');
        assert.strictEqual(rejected.stats.wishDirty, Sections.sectionBit('sources'));
        assert.strictEqual(await Service.rejectAccepted(state), rejected);
        assert.strictEqual(sourceWrites, 1, 'one accepted failure persists one source event, never a repeated invalidation loop');
    } finally { LifeState.cachedState = beforeCached; LifeState.upsertState = beforePersist; }
    assert.strictEqual(purchases.length, writesBefore);
    Admission.configureTradeAdmission(id => LifeState.cachedState(Number(id)),
        id => invoke('GameServer/World/World').registeredActorById(Number(id))?.session);
    console.log(JSON.stringify({ scope: 'declared unit clock plus genuine native unfunded execution',
        recipeId: recipe.recipeId, productId, wallet: originalState.adena, cash: unit.basket.cashCost,
        revenue: unit.revenue, labour, net: unit.expectedProfit, breakEven, ratio, nativePacket,
        resultReasons: [blocked.reason, result.reason, repeat.reason], remoteTripCost: trip,
        physicalCommerceClaim: false, purchases: purchases.length, crafted, sold, emptyReads }));
    console.log('Cold wealth craft checks passed');
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    Workshop.remove(9001); Workshop.remove(9005);
    AfkTrade._resetForTests();
    for (const key of ['fetchCharacterRecipes', 'fetchItems', 'craftInventoryItems']) Database[key] = originals[key];
    for (const key of ['offers', 'buyFromShop', 'sellToShop']) AfkTrade[key] = originals[key];
    for (const key of ['upsertState', 'refreshInventory']) LifeState[key] = originals[key];
    LifeEvents.record = originals.record;
    Recipes.resolveByRecipeId = originals.resolveByRecipeId;
    DataCache.items = originals.items;
});
