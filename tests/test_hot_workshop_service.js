'use strict';
// T93 move 1: a workshop serves while its crafter is hot (a player stands by
// its body). A cold bot's order is served as it is at a cold crafter (same
// product, fee and MP spent), the MP comes from the body, and the player still
// sees the workshop on the board and orders there.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('hot-workshop-service');
require('../src/Global');
const { publishTwinOffer } = require('./helpers/twinOffer');
const { insertSession } = require('./helpers/worldSessions');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');
const Item = invoke('GameServer/Item/Item');
const Actor = invoke('GameServer/Actor/Actor');
const Workshop = require('../src/GameServer/Bot/Economy/CraftWorkshopService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
const PlayerBoard = require('../src/GameServer/AfkTrade/PlayerBoardService');
const ColdCrafting = invoke('GameServer/Bot/Economy/ColdCraftingService');
Data.init(); fixture.assertConfigured(options.default);
let serial = 0;
// The customers stand at the twin's place in Giran (the town centre); the
// crafter's body hunts in the fields, where the player is.
const giran = { locX: 83396, locY: 147904, locZ: -3400 };
const fields = { locX: 120000, locY: 110000, locZ: -3000 };
async function seed(recipe, { crafter = false, account = `bot_hot_workshop_${++serial}` } = {}) {
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `HotWorkshop${++serial}`, race: 4,
        classId: crafter ? 57 : 0, sex: 0, face: 0, hair: 0, hairColor: 0,
        maxHp: 1000, maxMp: 1000000, ...(crafter ? fields : giran) })).insertId);
    await Database.execute(['UPDATE characters SET level=70,hp=1000,mp=1000000 WHERE id=?', [id]]);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000000, equipped: false });
    if (crafter) await Database.setCharacterRecipe(id, recipe.recipeId, recipe.type);
    else for (const [selfId, amount] of Profit.requirements(recipe)) {
        await Database.setItem(id, { selfId, name: 'Material', amount, equipped: false });
    }
    if (!account.startsWith('bot_')) return id;
    let state = await Life.upsertState({ characterId: id, accountName: account, name: `HotWorkshop${serial}`,
        level: 70, phase: 'cold', activity: crafter ? 'hunting' : 'shopping', loc: crafter ? fields : giran,
        currentRegion: crafter ? 'Dragon Valley' : 'Giran', adena: 100000000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 1000, maxHp: 1000, mp: 1000000, maxMp: 1000000 },
        stats: { classId: crafter ? 57 : 0, generatedCold: true, money: [36000, 0, 0, 0],
            ...(crafter ? { twin: { town: 'Giran' } } : {}) }, timing: {} }, 'hot_workshop_fixture');
    if (crafter) state = await publishTwinOffer(state);
    return state;
}
// A body in the world: its MP, its bag and its place are its own.
async function body(id, account, point, mp) {
    const session = { accountId: account, botSession: account.startsWith('bot_'), packets: [],
        dataSendToMe(packet) { this.packets.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    const actor = { session, point: { ...point }, mp, fetchId: () => id, fetchMp() { return this.mp; }, setMp(value) { this.mp = value; },
        fetchHp: () => 1000, fetchClanId: () => 0, fetchLocX() { return this.point.locX; }, fetchLocY() { return this.point.locY; },
        fetchLocZ() { return this.point.locZ; }, fetchIsOnline: () => true, isDead: () => false, statusUpdateVitals() {},
        backpack: { items: [], fetchItems() { return this.items; },
            fetchTotalAdena() { return this.items.filter(item => item.fetchSelfId() === 57).reduce((n, item) => n + item.fetchAmount(), 0); },
            insertItem(objectId, selfId, row) {
                const template = Data.items.find(item => item.selfId === selfId);
                const item = new Item(objectId, { ...template?.etc, ...row, selfId, kind: template?.template?.kind });
                this.items.push(item); return item;
            } } };
    session.actor = actor;
    for (const row of await Database.fetchItems(id)) actor.backpack.insertItem(row.id, row.selfId, row);
    insertSession(session);
    return actor;
}
const count = (rows, id) => rows.filter(row => Number(row.selfId) === id).reduce((n, row) => n + Number(row.amount), 0);
const adenaOf = async id => count(await Database.fetchItems(id), 57);
// A cold bot's workshop order through its own entry: its held plan names the
// crafter's workshop (WishProviders.personalCraftPlan) and it stands there.
async function order(owner, customer, recipe) {
    const before = { owner: await adenaOf(owner), customer: await adenaOf(customer) };
    const state = await Life.upsertState({ ...Life.cachedState(customer), activity: 'crafting',
        stats: { ...Life.cachedState(customer).stats, equipmentPlan: { status: 'ready_to_craft', strategy: 'craft',
            recipeId: recipe.recipeId, target: { selfId: recipe.productId },
            craftProviders: { [recipe.recipeId]: { workshop: true, characterId: owner } } } } }, 'hot_workshop_order');
    const result = await ColdCrafting.craft(state, () => 0);
    const items = await Database.fetchItems(customer);
    return { result, fee: before.customer - await adenaOf(customer), earned: await adenaOf(owner) - before.owner,
        product: count(items, recipe.productId),
        parts: [...Profit.requirements(recipe)].map(([id]) => count(items, id)) };
}
async function run() {
    World.user = { sessions: [], revision: 0 };
    await Database.init(); await Life.init(); Workshop.init();
    const recipe = Recipes.resolveByRecipeId(1);

    // The same order at a cold crafter: what the hot one must match.
    const coldOwner = await seed(recipe, { crafter: true }), coldBuyer = await seed(recipe);
    const coldMp = Number(coldOwner.vitals.mp);
    const cold = await order(coldOwner.characterId, coldBuyer.characterId, recipe);
    assert.equal(cold.result.crafted, true, JSON.stringify(cold.result));
    const coldSpent = coldMp - Number(Life.cachedState(coldOwner.characterId).vitals.mp);

    // A player walks up to the crafter's body in the fields: the crafter turns
    // hot (markHot before its body joins the world, BotManager), then its body
    // posts 'activated'. Its saved MP lags (0); its body holds 5000.
    const owner = await seed(recipe, { crafter: true }), buyer = await seed(recipe);
    // The player in Giran is a real actor: the board answer sends it the
    // native item list and user info.
    const playerId = await seed(recipe, { account: 'player_hot_workshop' });
    const [playerRow] = await Database.execute(['SELECT * FROM characters WHERE id=?', [playerId]]);
    const playerSession = insertSession({ accountId: 'player_hot_workshop', packets: [], socket: { write() {} },
        dataSendToMe(packet) { this.packets.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} });
    playerSession.actor = new Actor(playerSession, { ...playerRow, ...utils.crushOb(Data.classTemplates.find(entry => entry.classId === 0)),
        ...giran, items: await Database.fetchItems(playerId), paperdoll: utils.tupleAlloc(16, {}) });
    playerSession.actor.setIsOnline(true);
    const player = playerSession.actor;
    await Database.createAccount('player_in_fields', 'fixture');
    const nearby = await body(Number((await Database.createCharacter('player_in_fields', { name: 'FieldPlayer', race: 0,
        classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100, ...fields })).insertId),
    'player_in_fields', fields, 100);
    assert(nearby, 'a player stands next to the crafter');
    await Database.execute(['UPDATE characters SET mp=0 WHERE id=?', [owner.characterId]]);
    const hot = await Life.upsertState({ ...owner, phase: 'hot', vitals: { ...owner.vitals, mp: 0 },
        timing: { lastHotAt: Date.now() } }, 'hot_crafter');
    const crafterBody = await body(owner.characterId, owner.accountName, fields, 5000);
    Life.notifyNearFacts(crafterBody.session, 'activated');
    await new Promise(resolve => setImmediate(resolve));
    // An AFK sale replaces the hot row in the cache with no change event.
    Life.acceptMarketTrades(owner.characterId, { [recipe.productId]: 1 });

    const row = Workshop.publicRecipeRows(owner.characterId).find(entry => entry[1] === recipe.recipeId);
    assert(row, 'a hot crafter stays in the workshop index');
    assert.deepEqual(row.slice(3, 6), ['Giran', giran.locX, giran.locY], 'its workshop stands at its twin place');
    assert(row[7] >= 1, 'its capacity reads the body MP, not the stale saved MP');
    assert(Workshop.boardRecords().some(shop => Number(shop.ownerId) === owner.characterId),
        'the player\'s board window lists the hot crafter\'s workshop');

    const served = await order(owner.characterId, buyer.characterId, recipe);
    assert.equal(served.result.crafted, true, `a cold bot's order is served by the hot crafter: ${JSON.stringify(served.result)}`);
    assert.equal(served.fee, cold.fee, 'same fee as at a cold crafter');
    assert.equal(served.earned, cold.earned, 'the crafter earns the same fee');
    assert.equal(served.product, cold.product, 'same product');
    assert.deepEqual(served.parts, cold.parts, 'same parts spent');
    assert.equal(5000 - crafterBody.fetchMp(), coldSpent, 'the body spends the MP a cold crafter spends');
    assert.equal(crafterBody.backpack.fetchTotalAdena(), await adenaOf(owner.characterId), 'the body holds the fee');
    const saved = Life.cachedState(owner.characterId);
    assert.equal(saved.phase, 'hot', 'the hot row stays its body\'s');
    assert.equal(Number(saved.simulation?.revision || 0), Number(hot.simulation?.revision || 0),
        'the order writes no revision over the body\'s row');

    // The player in Giran orders from the same workshop through the board.
    const shop = Workshop.boardRecords().find(entry => Number(entry.ownerId) === owner.characterId);
    const quote = Workshop.lookup(owner.characterId, recipe.recipeId, { characterId: player.fetchId(), stats: {} });
    const board = PlayerBoard.create();
    const answer = await board.answer(player.session, { kind: 'workshop', ownerId: owner.characterId,
        recipeId: recipe.recipeId, price: quote.price, revision: shop.revision, confirmed: true });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.action, 'crafted');
    assert.equal(count(await Database.fetchItems(player.fetchId()), recipe.productId), recipe.productCount);
    assert.equal(5000 - crafterBody.fetchMp(), 2 * coldSpent, 'the player\'s order spends the body MP too');

    // A dead body publishes no capacity: bots plan no trip there.
    crafterBody.isDead = () => true;
    Life.notifyNearFacts(crafterBody.session, 'death');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Workshop.publicRecipeRows(owner.characterId).find(entry => entry[1] === recipe.recipeId)[7], 0);
    crafterBody.isDead = () => false;

    // A body with no MP left serves no order; nothing changes hands.
    crafterBody.setMp(0);
    const refill = await seed(recipe), before = await adenaOf(refill.characterId);
    const refused = await order(owner.characterId, refill.characterId, recipe);
    assert.equal(refused.result.crafted, false);
    assert.equal(await adenaOf(refill.characterId), before);
    assert.equal(crafterBody.backpack.fetchTotalAdena(), await adenaOf(owner.characterId));
    console.log('PASS hot crafter: indexed at its place, cold bot order matches a cold crafter, MP from the body, player sees and orders');
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => Database.close?.());
