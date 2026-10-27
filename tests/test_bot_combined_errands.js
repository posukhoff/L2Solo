'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-errands-'));
const oldConfig = process.env.L2NODE_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'test.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
const defaults = fs.readFileSync(path.resolve(__dirname, '../config/default.ini'), 'utf8');
fs.appendFileSync(process.env.L2NODE_CONFIG_FILE, '\n' + defaults.slice(defaults.indexOf('[AuthServer]')));
require('./helpers/databaseIsolation');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Errands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Goals = invoke('GameServer/Bot/Goals/GoalExecutor');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const Goal = invoke('GameServer/Bot/Goals/GoalState');
const Background = invoke('GameServer/Bot/Population/BackgroundResolver');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Actor = invoke('GameServer/Model/Actor');
const Backpack = invoke('GameServer/Actor/Backpack');
const Skill = invoke('GameServer/Model/Skill');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const CraftEligibility = invoke('GameServer/Bot/Economy/CraftEligibility');
const withNativeInput = require('./helpers/nativeEconomyInput');
let serial = 0;
async function seed(items) {
    const account = `bot_combined_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, { name: `Combined${serial}`, race: 0, classId: 0,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 22000, locY: 140000, locZ: -3000 })).insertId);
    for (const item of items) await Database.setItem(id, { equipped: false, slot: 0, enchant: 0, ...item });
    return Life.upsertState({ characterId: id, accountName: account, name: `Combined${serial}`, level: 20,
        phase: 'cold', activity: 'hunting', loc: { locX: 22000, locY: 140000, locZ: -3000 },
        currentRegion: 'Dion fields', inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        adena: Number(items.find(item => item.selfId === 57)?.amount || 0),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { generatedCold: true, classId: 0 }, timing: {} }, 'combined_seed');
}
function held(state, id) { return Number(state.inventory?.[id]?.amount || 0); }
function physical(rows, id) { return rows.filter(row => Number(row.selfId) === id).reduce((n, row) => n + Number(row.amount), 0); }
async function run() {
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init(); await Afk.init();
    // The mandatory floor has no economic/HP percentage threshold.
    assert.equal(Floor.evaluate({ hp: 1, mp: 1, slots: 79, load: 499, maxLoad: 1000 }), null);
    assert.equal(Floor.evaluate({ hp: 0 }).action, 'revive');
    assert.equal(Floor.evaluate({ hp: 1, mp: 4, manaRequired: true, castCosts: [5] }).reason, 'no_mp');
    assert.equal(Floor.evaluate({ hp: 1, mp: 4, manaRequired: true, castCosts: [4] }), null);
    assert.equal(Floor.evaluate({ hp: 1, mp: 0, castCosts: [5] }), null, 'melee is not forced to rest for mana');
    assert.equal(Floor.evaluate({ hp: 1, slots: 80 }).reason, 'no_slot');
    assert.equal(Floor.evaluate({ hp: 1, slots: 80, slotLimit: Floor.inventoryLimit(4) }), null);
    assert.deepEqual([0.499, 0.5, 2 / 3, 0.8, 1].map(share => Floor.weightPenalty(1000 * share, 1000)), [0, 1, 2, 3, 4]);
    console.log('PASS game floor boundaries');

    const mage = { characterId: 900001, level: 7, activity: 'hunting', phase: 'cold', inventory: {},
        vitals: { hp: 100, maxHp: 100, mp: 0, maxMp: 100 }, stats: { classId: 10 } };
    // Owned characters fight with their learned kit only (113e1791): the mage
    // carries the skills a level 7 Human Mystic has learned.
    mage.stats.coldCombat = Profile.legacySnapshot(mage, Profile.skillRecordsFromTree(10, 7));
    const profile = Profile.profileFor(mage);
    const skills = Profile.offensiveSkills(profile);
    assert(skills.some(skill => skill.mp > 0), 'shipped mage has an actual usable spell');
    const actor = new Actor({ classId: 10, race: 0, level: 7, hp: 100, maxHp: 100, mp: 0, maxMp: profile.maxMp,
        maxLoad: profile.maxLoad });
    actor.backpack = new Backpack({ paperdoll: {}, items: [] });
    actor.skillset = { fetchSkills: () => skills.map(skill => new Skill(skill)) };
    assert.equal(Floor.forActor(actor).reason, 'no_mp');
    assert.equal(Floor.forState(mage).reason, 'no_mp');
    const mandatoryRest = Needs.evaluate(mage)[0];
    assert.deepEqual({ type: mandatoryRest.type, priority: mandatoryRest.priority, kind: mandatoryRest.plan.kind },
        { type: 'recover', priority: 100, kind: 'rest' }, 'the native no-MP floor selects mandatory rest');
    assert.equal(Background.resolveSolo({ state: mage, timestamp: Date.now(), elapsedMs: 1000 }).patch.activity, 'resting');
    const lowHp = { ...mage, vitals: { ...mage.vitals, hp: 1, mp: profile.maxMp } };
    assert.equal(Needs.evaluate(lowHp).some(goal => goal.type === 'recover' && goal.priority === 100), false,
        'alive low HP retains ordinary recovery rather than a mandatory death floor');
    console.log('PASS hot/cold actual skill and live HP floor');

    actor.setMp(profile.maxMp);
    actor.backpack.insertItem(17, 17, { amount: 1 });
    const arrows = actor.backpack.fetchItemFromSelfId(17);
    assert.equal(Floor.forActor(actor), null);
    arrows.setAmount(Math.ceil(profile.maxLoad / arrows.fetchMass()));
    assert.equal(Floor.forActor(actor).reason, 'overweight', 'a quantity change weighs on the floor at once');
    console.log('PASS quantity events');

    const before = { ...mage, stats: { classId: 0 }, inventory: { 1835: { selfId: 1835, amount: 10 } }, adena: 1000 };
    assert.equal(Errands.edge(before, { ...before, inventory: structuredClone(before.inventory) }), null);
    assert.equal(Errands.edge(before, { ...before, adena: 2000 }), 'deal');
    assert.equal(Errands.edge(before, { ...before, inventory: { 1835: { selfId: 1835, amount: 9 } } }), 'shots');
    assert.equal(Errands.edge(before, before, { materialize: { items: [{ selfId: 1869, amount: 1 }] } }), 'bag');
    assert.equal(Errands.edge(before, { ...before, activity: 'traveling', adena: 2000 }), null);
    assert.equal(Errands.edge(before, { ...before, activity: 'resting', adena: 2000 }), null);
    console.log('PASS bag/shot/deal edges without passive checks');

    const seller = await seed([{ selfId: 1869, name: 'Iron Ore', amount: 3 }]);
    const source = (await Database.fetchItems(seller.characterId)).find(row => Number(row.selfId) === 1869);
    // A craft input errand buys only from a line that sells at once (a shop), not
    // a bot's conditional sell ad (OfferQuery.settledOnlyFor).
    const sale = await Afk.publishBot(seller.characterId, { kind: 'shop', storeType: Afk.SELL,
        town: 'Dion', locX: 15631, locY: 142885, locZ: -2704, title: 'Materials',
        lines: [{ objectId: source.id, selfId: 1869, name: 'Iron Ore', count: 3, price: 60, enchant: 0, slot: 0, stackable: true }] });
    assert(sale?.lines?.length === 1);
    let buyer = await seed([{ selfId: 57, name: 'Adena', amount: 500000 }, { selfId: 736, name: 'Scroll of Escape', amount: 3 },
        { selfId: 86, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }]);
    const now = Date.now();
    // A trip must pay for itself before travel (24512a44); a planned errand
    // carries its originating value (ColdMarketService.fundingTerms).
    const jobs = [
        { selfId: 1869, amount: 2, town: 'Dion', purpose: 'craft_input', maxPrice: 80, valueHours: 10, at: now },
        { selfId: 1060, amount: 2, town: 'Dion', purpose: 'healing', money: 50000, at: now },
        { selfId: 736, amount: 1, town: 'Dion', purpose: 'scrolls', money: 50000, at: now },
        { selfId: 1061, amount: 1, town: 'Giran', purpose: 'future_visit', at: now }
    ];
    for (const job of jobs) buyer = Errands.enqueue(buyer, job, now);
    buyer = Errands.enqueue(buyer, { ...jobs[0], amount: 2 }, now);
    assert.equal(Errands.pending(buyer).length, 4, 'refreshing a need adds no reservation or duplicate errand');
    const travel = Goals.beginMarketTravel(buyer, Market.errandGoal(jobs[0]), now);
    assert(travel && travel.activity === 'traveling');
    assert.equal(travel.stats.travel.townName, 'Dion');
    assert.equal(held(travel, 736), held(buyer, 736) - Number(!!travel.stats.travel.paid?.scroll), 'one paid departure');
    const fee = Number(travel.stats.travel.paid?.fee || 0);
    assert.equal(travel.adena, buyer.adena - fee);
    const originalReturn = structuredClone(travel.stats.marketReturn);
    const departed = await Life.upsertState(travel, 'combined_departure');
    const arrival = Background.resolveSolo({ state: departed, timestamp: travel.stats.travel.arrivalAt,
        elapsedMs: travel.stats.travel.arrivalAt - now });
    const arrived = await Life.applyResolve(departed, arrival);
    assert.equal(arrived.activity, 'shopping');
    assert.equal(arrived.currentRegion, 'Dion');
    assert.equal(Goals.finishMarketVisit(arrived), null, 'return waits for this town\'s work');
    // The record changed while the buyer travelled. That unavailable job must
    // neither use its saved price nor prevent the other native purchases.
    await Afk.repriceBot(seller.characterId, sale.lines[0].id, 90, sale.revision);
    const policyFinished = await withNativeInput(arrived, accepted => Market.finishTownErrands(accepted));
    const beforeExecution = await Database.fetchItems(buyer.characterId);
    const basics = invoke('GameServer/Bot/Economy/EconomyContext').basics(policyFinished);
    assert.equal(arrived.level, invoke('GameServer/Progression/ProgressionCap').levelForExperience(arrived.exp || 0, buyer.level),
        'native arrival projects the original EXP0; the historical Life20 input does not grant XP');
    assert.equal(basics.kitCost(1060), 0, 'full HP supplies no missing healing kit');
    assert.equal(basics.kitCost(736), 0, 'the existing escape scroll stack supplies the kit');
    assert.equal(basics.stock('shots').target, 0, 'these unchanged arrival facts supply no economic shot stock');
    assert.equal(physical(beforeExecution, 1869), 0, 'changed quote remains refused');
    assert.equal(physical(beforeExecution, 1060), 0, 'an unvalued legacy healing errand is not funded');
    assert.equal(physical(beforeExecution, 736), held(arrived, 736), 'the unneeded scroll errand makes no purchase');
    assert.equal(policyFinished.adena, arrived.adena, 'no selected budget means no automatic payment');

    // Explicit execution seam for the original same-town quantities: native
    // merchant quote, physical SQL debit and unchanged scalar economy CAS.
    // This is NOT a voluntary E3 funding claim for those refused jobs.
    let finished = await Life.upsertState(policyFinished, 'combined_native_visit_finished');
    assert(finished, 'the actual completion marker is published before separate SQL execution');
    for (const job of jobs.slice(1, 3)) {
        const quoted = Market.planPurchase(finished, job.selfId, job.amount,
            { towns: ['Dion'], money: job.money, timestamp: now });
        assert(quoted && quoted.npcPrice > 0, 'the original stack has an authored local merchant quote');
        const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
        const quote = [...Opportunity.npcOffersAll(job.selfId), ...Opportunity.fixedStoreOffers(job.selfId)]
            .find(offer => offer.town === 'Dion' && Number(offer.price) === Number(quoted.npcPrice));
        assert(quote, 'execution uses the actual source shop price');
        const beforeWallet = finished.adena;
        const bought = await Database.purchaseNpcInventoryItem(finished.characterId,
            { selfId: job.selfId, amount: job.amount, unitPrice: Number(quote.price), coldState: finished });
        assert(bought.ok && bought.coldLifeRow);
        const old = finished;
        finished = Life.acceptLifecycleRow(bought.coldLifeRow);
        assert.equal(finished.adena, beforeWallet - job.amount * Number(quote.price));
        await assert.rejects(Database.purchaseNpcInventoryItem(old.characterId,
            { selfId: job.selfId, amount: 1, unitPrice: Number(quote.price), coldState: old }), /economy_state_changed/);
        assert.equal(Life.snapshot(finished.characterId).adena, finished.adena, 'stale execution rolls back its physical debit');
    }
    const bag = await Database.fetchItems(buyer.characterId);
    assert.equal(physical(bag, 1869), 0, 'changed offer is rechecked against its authored price cap');
    assert.equal(physical(bag, 1060), 2, 'other same-town NPC errand is completed');
    assert.equal(physical(bag, 736), held(arrived, 736) + 1, 'scroll errand is not another town payment');
    assert.equal(Errands.pending(finished, Date.now(), 'Dion').length, 0);
    assert.equal(Errands.pending(finished).length, 1, 'a different town does not get smuggled into this visit');
    assert.deepEqual(finished.stats.marketReturn, originalReturn, 'original physical return remains');
    const shotPlan = ShotStock.planForState(finished);
    assert(shotPlan.perAction > 0);
    assert.equal(held(finished, shotPlan.selfId), 0, 'the refused stock has not been invented by explicit other-item executions');
    assert(finished.adena < arrived.adena, 'actual purchases debit the wallet');
    assert.equal(physical(bag, 57), finished.adena, 'physical and lifecycle wallet remain equal');
    console.log('PHYSICAL_EXECUTION_SEAM', JSON.stringify({ inputLevel: buyer.level, arrivalLevel: arrived.level,
        exp: arrived.exp, policyWallet: policyFinished.adena, executedWallet: finished.adena,
        healing: physical(bag, 1060), scrolls: physical(bag, 736), shots: physical(bag, shotPlan.selfId) }));
    const returning = Goals.finishMarketVisit(finished);
    assert(returning && returning.activity === 'traveling');
    assert.equal(held(returning, 736), held(finished, 736), 'return consumes no second departure scroll');
    console.log('PASS native one-town queue, changed quote, supplies and one return');

    // A kept errand departs on the terms its arrival buys on: a board-only
    // errand (route tag -5: no NPC, whole fill from the top quotes) leaves only
    // for a town where those quotes fill it. The seller's line now holds 3 at 90.
    const keeper = await seed([{ selfId: 57, name: 'Adena', amount: 500000 }, { selfId: 736, name: 'Scroll of Escape', amount: 3 },
        { selfId: 86, name: 'Sword of Revolution', amount: 1, equipped: true, slot: 7 }]);
    const at = Date.now();
    const depart = errand => Goals.beginMarketTravel(Errands.enqueue(keeper, errand, at), Market.errandGoal(errand), at);
    const whole = { selfId: 1869, amount: 3, town: 'Dion', purpose: 'wealth_craft', tag: [-5], r: 1, at };
    assert.equal(depart(whole)?.stats.travel.townName, 'Dion', 'the quotes fill the errand: it departs');
    const short = { ...whole, amount: 4 };
    assert.equal(depart(short), null, 'no departure on a partial fill the arrival refuses');
    // The refused departure ends the errand as the arrival on those terms does:
    // gone, its job told it bought nothing, and the bot's next goal is another one.
    const ended = await Market.departOrEndErrand(Errands.enqueue(keeper, short, at), Market.errandGoal(short), at);
    assert.equal(ended.travel, null);
    assert.equal(Errands.pending(Life.snapshot(keeper.characterId)).length, 0, 'the refused errand is not kept until it lapses');
    assert.notEqual(Needs.evaluate(ended.state)[0]?.type, 'market_errand', 'the bot picks another goal');
    // A job whose source view is older than the board (it saw 5 on the line that
    // now holds 3) plans the errand; the departure gate refuses it on the board's
    // terms and the errand ends, while the job's own current goal stays its own.
    await Goal.set(keeper.characterId, { type: 'hunt', status: 'active', priority: 10, plan: { kind: 'hunt' } });
    const line = Afk.boardIndex().list(1869, Afk.SELL, 'Dion')[0];
    const seen = { selfId: 1869, town: 'Dion', lines: [{ line: { ...line, count: 5 }, price: Number(line.price), count: 4 }],
        cost: 4 * Number(line.price), landed: 4 * Number(line.price) };
    const asked = await Market.acquire(Life.snapshot(keeper.characterId), 1869, 4,
        { purpose: 'wealth_craft', npc: false, quoteDepth: 5, sourcePlan: seen, towns: ['Dion'], r: 1, timestamp: at });
    assert.deepEqual([!!asked.plan, asked.traveling, asked.reason], [true, false, 'market_errand_no_offer'], 'planned on the old view, refused at the gate');
    assert.equal(Errands.pending(Life.snapshot(keeper.characterId)).length, 0, 'the refused errand is not kept');
    assert.deepEqual([Goal.snapshot(keeper.characterId).current.type, Goal.snapshot(keeper.characterId).current.status],
        ['hunt', 'active'], 'the job\'s own goal is not closed by its errand\'s end');
    const arriver = await seed([{ selfId: 57, name: 'Adena', amount: 500000 }]);
    const arrived2 = await Market.tryPurchase({ ...Errands.enqueue(arriver, short, at), activity: 'shopping', currentRegion: 'Dion' },
        Market.errandGoal(short));
    assert.equal(arrived2.reason, 'market_errand_no_offer', 'the arrival on the same terms buys nothing');
    assert.equal(Errands.pending(arrived2.state).length, 0);
    const npcOnly = { selfId: 1060, amount: 2, town: 'Dion', purpose: 'craft_input', valueHours: 10, tag: [-5], at };
    assert.equal(depart(npcOnly), null, 'no departure to an NPC source the board-only errand does not buy from');
    console.log('PASS kept errand departs on its arrival terms');

    // A gear recipe scroll bought on an errand is learned by that purchase,
    // though the buyer's economy card names no craft now; a buyer who cannot
    // learn it keeps the scroll unlearned.
    const crafterOf = state => ({ ...state, level: 60, stats: { ...state.stats, classId: 57 } });
    const probeCrafter = crafterOf({ stats: {}, inventory: {} });
    const gear = Object.values(RecipeItems.loadRecipeItems()).find(recipe => {
        const item = { selfId: recipe.recipeItemId, name: 'Recipe', kind: 'Other.Recipe', amount: 1 };
        const kind = Disposition.recipeInfo(item)?.product?.template?.kind || '';
        return (kind.startsWith('Weapon.') || kind.startsWith('Armor.'))
            && Disposition.recipeDisposition(probeCrafter, item)?.action === 'learn';
    });
    assert(gear, 'a learnable gear recipe scroll exists');
    const scrollSeller = await seed([{ selfId: gear.recipeItemId, name: 'Recipe', amount: 2 }]);
    const scrollRow = (await Database.fetchItems(scrollSeller.characterId)).find(row => Number(row.selfId) === gear.recipeItemId);
    assert((await Afk.publishBot(scrollSeller.characterId, { kind: 'shop', storeType: Afk.SELL,
        town: 'Dion', locX: 15631, locY: 142885, locZ: -2704, title: 'Recipes',
        lines: [{ objectId: scrollRow.id, selfId: gear.recipeItemId, name: 'Recipe', count: 2, price: 100, enchant: 0,
            slot: 0, stackable: true }] }))?.lines?.length === 1);
    const scrollErrand = { selfId: gear.recipeItemId, amount: 1, town: 'Dion', purpose: 'wealth_craft', tag: [-5],
        valueHours: 10, at: Date.now() };
    // The worker's money packet funds the buy; the saved row carries it.
    const buyScroll = async (state) => withNativeInput(await Life.upsertState({ ...Errands.enqueue(state, scrollErrand),
        activity: 'shopping', currentRegion: 'Dion' }, 'combined_scroll_errand'), async accepted =>
        Market.tryPurchase(await Life.upsertState(accepted, 'combined_scroll_funding'), Market.errandGoal(scrollErrand)));
    const crafter = await Life.upsertState(crafterOf(await seed([{ selfId: 57, name: 'Adena', amount: 500000 }])), 'combined_crafter');
    // A Warsmith of this level has learned its Create Item level.
    await Database.setSkill({ selfId: 172, name: 'Create Item',
        level: CraftEligibility.craftLevelFor(crafter) }, crafter.characterId);
    const craftBuy = await buyScroll(crafter);
    assert.equal(craftBuy.reason, 'market_errand_bought');
    assert((await Database.fetchCharacterRecipes(crafter.characterId)).some(row => Number(row.recipeId) === gear.recipeId),
        'the bought gear recipe is in the recipe book after the visit');
    assert.equal(physical(await Database.fetchItems(crafter.characterId), gear.recipeItemId), 0, 'learning used the scroll');
    const fighter = await seed([{ selfId: 57, name: 'Adena', amount: 500000 }]);
    const fighterBuy = await buyScroll(fighter);
    assert.equal(fighterBuy.reason, 'market_errand_bought');
    assert.equal((await Database.fetchCharacterRecipes(fighter.characterId)).length, 0, 'a scroll its buyer cannot learn is not learned');
    assert.equal(physical(await Database.fetchItems(fighter.characterId), gear.recipeItemId), 1, 'the unlearnable scroll stays held');
    // The same Warsmith buying it for the clan keeps the scroll for the deposit.
    const clanBuyer = await Life.upsertState(crafterOf(await seed([{ selfId: 57, name: 'Adena', amount: 500000 }])), 'combined_clan_buyer');
    await Database.setSkill({ selfId: 172, name: 'Create Item',
        level: CraftEligibility.craftLevelFor(clanBuyer) }, clanBuyer.characterId);
    const clanSeller = await seed([{ selfId: gear.recipeItemId, name: 'Recipe', amount: 1 }]);
    const clanRow = (await Database.fetchItems(clanSeller.characterId)).find(row => Number(row.selfId) === gear.recipeItemId);
    assert((await Afk.publishBot(clanSeller.characterId, { kind: 'shop', storeType: Afk.SELL,
        town: 'Dion', locX: 15631, locY: 142885, locZ: -2704, title: 'Recipes',
        lines: [{ objectId: clanRow.id, selfId: gear.recipeItemId, name: 'Recipe', count: 1, price: 100, enchant: 0,
            slot: 0, stackable: true }] }))?.lines?.length === 1);
    const clanPlan = Market.planPurchase({ ...clanBuyer, currentRegion: 'Dion' }, gear.recipeItemId, 1, { towns: ['Dion'], purpose: 'clan', money: 500000 });
    assert(clanPlan, 'the clan plan finds the scroll');
    const clanBought = await withNativeInput(await Life.upsertState({ ...clanBuyer, activity: 'shopping', currentRegion: 'Dion' },
        'combined_clan_funding'), async accepted => Market.buyHere(await Life.upsertState(accepted, 'combined_clan_accepted'), clanPlan));
    assert.equal(clanBought.units, 1);
    assert.equal((await Database.fetchCharacterRecipes(clanBuyer.characterId)).length, 0, 'a scroll bought for the clan is not learned');
    assert.equal(physical(await Database.fetchItems(clanBuyer.characterId), gear.recipeItemId), 1, 'the clan scroll stays held for the deposit');
    console.log('PASS a bought recipe scroll is learned by the purchase');

    // A learn point learns every held scroll the crafter can learn, though
    // nothing it plans wants that recipe; a scroll its holder cannot learn
    // stays and is listed; a scroll held for the clan's deposit stays.
    const holder = await Life.upsertState(crafterOf(await seed([{ selfId: gear.recipeItemId, name: 'Recipe', amount: 1 }])),
        'combined_scroll_holder');
    await Database.setSkill({ selfId: 172, name: 'Create Item',
        level: CraftEligibility.craftLevelFor(holder) }, holder.characterId);
    await Life.learnCraftableRecipes(holder);
    assert((await Database.fetchCharacterRecipes(holder.characterId)).some(row => Number(row.recipeId) === gear.recipeId),
        'a held learnable scroll no plan wants is learned at the learn point');
    assert.equal(physical(await Database.fetchItems(holder.characterId), gear.recipeItemId), 0, 'learning used the held scroll');
    const fighterHeld = await Life.learnCraftableRecipes(Life.cachedState(fighter.characterId));
    assert.equal((await Database.fetchCharacterRecipes(fighter.characterId)).length, 0, 'a scroll its holder cannot learn is not learned');
    assert(Disposition.saleCandidates(fighterHeld, { unlimited: true }).some(item => Number(item.selfId) === gear.recipeItemId),
        'a scroll its holder cannot learn is listable');
    const clanHeld = Life.cachedState(clanBuyer.characterId);
    await Life.learnCraftableRecipes({ ...clanHeld, stats: { ...clanHeld.stats, clanId: 77,
        lastErrand: { purpose: 'clan', selfId: gear.recipeItemId, units: 1, tag: { clanId: 77 }, at: Date.now() } } });
    assert.equal((await Database.fetchCharacterRecipes(clanBuyer.characterId)).length, 0,
        'a scroll held for the clan deposit is not learned at a learn point');
    assert.equal(physical(await Database.fetchItems(clanBuyer.characterId), gear.recipeItemId), 1, 'the clan scroll stays for the deposit');
    // The clan deposit ends that hold: a later copy of the scroll is free and
    // learned at the next learn point.
    const scrollClan = await Database.createAutonomousClan({ name: 'ScrollClan', leaderId: clanBuyer.characterId,
        memberIds: [clanBuyer.characterId], founderQuorum: 1, maxBotClans: 40, maxBotMemberShare: 1, stateJson: { level: 1 } });
    assert.equal(scrollClan.ok, true, scrollClan.code);
    await Database.execute(['UPDATE clans SET level=1 WHERE id=?', [scrollClan.clanId]]);
    await Database.execute(['UPDATE clan_simulation_clans SET stateJson=? WHERE clanId=?',
        [JSON.stringify({ mode: 'autonomous', warehouseRevision: 0 }), scrollClan.clanId]]);
    const owed = Life.cachedState(clanBuyer.characterId);
    await Life.upsertState({ ...owed, clanId: scrollClan.clanId, stats: { ...owed.stats, clanId: scrollClan.clanId,
        lastErrand: { purpose: 'clan', selfId: gear.recipeItemId, units: 1, tag: { clanId: scrollClan.clanId }, at: Date.now() } } },
    'combined_clan_owed');
    const owedRow = (await Database.fetchItems(clanBuyer.characterId)).find(row => Number(row.selfId) === gear.recipeItemId);
    const deposited = await Database.transferInventoryToClanWarehouse({ clanId: scrollClan.clanId, characterId: clanBuyer.characterId,
        item: { id: owedRow.id, selfId: gear.recipeItemId, kind: 'Other.Recipe', stackable: false }, amount: 1,
        resolveKey: 'combined-clan-scroll' });
    assert.equal(deposited.ok, true, deposited.code);
    Life.acceptNewerLifecycleRow(deposited.state);
    await Database.setItem(clanBuyer.characterId, { selfId: gear.recipeItemId, name: 'Recipe', amount: 1, equipped: false, slot: 0, enchant: 0 });
    const later = Life.cachedState(clanBuyer.characterId);
    await Life.learnCraftableRecipes({ ...later,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(clanBuyer.characterId)) });
    assert((await Database.fetchCharacterRecipes(clanBuyer.characterId)).some(row => Number(row.recipeId) === gear.recipeId),
        'after the clan deposit a later copy of the scroll is learned');
    // A member near the player deposits hot (ClanWarehouseService.depositHot):
    // that deposit ends the hold too.
    await Database.setItem(clanBuyer.characterId, { selfId: 1864, name: 'Stem', amount: 1, equipped: false, slot: 0, enchant: 0 });
    await Database.execute([`UPDATE bot_life_state SET phase='hot', statsJson=json_set(statsJson,'$.lastErrand',json(?))
        WHERE characterId=?`, [JSON.stringify({ purpose: 'clan', selfId: 1864, units: 1,
        tag: { clanId: scrollClan.clanId }, at: Date.now() }), clanBuyer.characterId]]);
    const hotRow = (await Database.fetchItems(clanBuyer.characterId)).find(row => Number(row.selfId) === 1864);
    const hotDeposit = await Database.transferInventoryToClanWarehouse({ clanId: scrollClan.clanId, characterId: clanBuyer.characterId,
        item: { id: hotRow.id, selfId: 1864, kind: 'Other.Material', stackable: true }, amount: 1,
        resolveKey: 'combined-clan-scroll-hot', expectedPhase: 'hot', validateLive: () => true });
    assert.equal(hotDeposit.ok, true, hotDeposit.code);
    assert.equal(Errands.clanHeld(Life.acceptLifecycleRow(hotDeposit.state), 1864, scrollClan.clanId), 0, 'the hot clan deposit ends the hold');
    console.log('PASS a learn point learns every learnable held scroll');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    console.log('CLEANUP', !fs.existsSync(directory));
});
