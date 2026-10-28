'use strict';
const Profit = require('./CraftProfitPolicy');
const Commit = require('./EconomyCommit');
const Diagnostics = require('./EconomyDiagnostics');
const TwinCluster = require('./TwinCluster');
const { isMainThread } = require('node:worker_threads');
const TableChannel = require('../Population/ColdTableChannel').shared;
const Mutations = require('../../Inventory/InventoryMutationQueue');
const recipes = () => invoke('GameServer/Items/C4RecipeItems');
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
// lazy: worker AfkTradeService is main-thread; the worker loads this module
const afk = () => invoke('GameServer/AfkTrade/AfkTradeService');
// How far a customer reaches a workshop from (its place, TwinCluster.placeOf),
// the one owner: the board's meet, the cold customer's trip and the craft's
// commit (Database craftForCustomer) all ask inWorkshopRange.
const WORKSHOP_RANGE = 1200;
function inWorkshopRange(place, loc) {
    return !!place?.loc && Math.hypot(Number(loc?.locX) - Number(place.loc.locX),
        Number(loc?.locY) - Number(place.loc.locY)) <= WORKSHOP_RANGE;
}
// Where a bot's workshop stands now (TwinCluster.placeOf at its standing
// store, AfkTradeService.findOwnerProjection). Main only.
function placeFor(state) {
    return state ? TwinCluster.placeOf(state, afk().findOwnerProjection(Number(state.characterId))?.shop) : null;
}
// A workshop serves while its owner is in the world's population, cold or
// hot: a hot owner's body hunts near a player, its workshop still stands at
// its place (T93: hot is only the body).
function serving(state) {
    return state?.phase === 'cold' || state?.phase === 'hot';
}
// The live body of a hot owner (main only): its MP is the crafter's MP; the
// saved row's lags it.
function bodyOf(state) {
    if (state?.phase !== 'hot') return null;
    // lazy: worker World is main-thread; the worker loads this module
    const actor = invoke('GameServer/World/World').registeredActorById?.(Number(state.characterId))?.session?.actor;
    return actor && !actor.isDead?.() && actor.fetchIsOnline?.() !== false ? actor : null;
}
// The crafter's MP, the one reader (board capacity, the cold customer's batch,
// the order's commit): a hot owner's body, else its saved vitals; a hot owner
// with no live body has none.
function crafterMp(state) {
    if (state?.phase !== 'hot') return Number(state?.vitals?.mp || 0);
    return Number(bodyOf(state)?.fetchMp?.() || 0);
}
function samePlace(a, b) {
    return a === b || !!a && !!b && a.town === b.town && a.loc.locX === b.loc.locX
        && a.loc.locY === b.loc.locY && a.loc.locZ === b.loc.locZ;
}
const byRecipe = new Map();
// Main's demand price holders: the workshops offering a recipe, whatever
// their MP now (the worker counts its mirror's).
if (isMainThread) invoke('GameServer/Bot/Economy/DemandPrice').useHolders(recipeId => byRecipe.get(Number(recipeId))?.size || 0);
const owners = new Map();
const publicScopeDigests = new Map();
const publicCandidates = new (require('./PublicWorkshopIndex').PublicWorkshopIndex)();
// A live player's manufacture rows stay apart from the bot rows above: the
// bot digests are what the worker mirrors (publicRows), and a meeting proof
// compares them with its token. Player rows refresh when the store opens
// (registerPlayer) and on the hot reads that use them (lookup,
// publicForRecipe); no single close event exists (quit, stop, death and
// logout reset the store type apart).
const playerCandidates = new (require('./PublicWorkshopIndex').PublicWorkshopIndex)();
const playerShops = new Map();
function registerPlayer(session) {
    const id = Number(session?.actor?.fetchId?.());
    if (!id || String(session.accountId || '').startsWith('bot_')) return;
    const prior = playerShops.get(id);
    playerShops.set(id, { session, actor: session.actor, rows: prior?.rows || [] });
    refreshPlayers();
}
function refreshPlayers() {
    // lazy: worker the worker loads this module; player workshops (World, ManufactureShop) are main-thread only
    const World = invoke('GameServer/World/World');
    const Manufacture = invoke('GameServer/Crafting/ManufactureShop'); // lazy: worker main-thread only, as World above
    for (const [id, owned] of playerShops) {
        const { session, actor } = owned;
        const rows = [];
        if (session.actor === actor && (World.user?.sessions || []).includes(session)
            && actor.fetchIsOnline?.() !== false && !actor.isDead?.()
            && Number(actor.fetchPrivateStoreType?.()) === Manufacture.MANUFACTURE) {
            // lazy: worker main-thread player workshops only (see refreshPlayers)
            const town = invoke('GameServer/Bot/AI/TownTransitPolicy').townAt(actor);
            if (!town) {
                for (const row of owned.rows) playerCandidates.remove(`p:${id}:${row[1]}`);
                owned.rows = [];
                continue;
            }
            for (const entry of Manufacture.shop(actor).entries) {
                const recipe = recipes().resolveByRecipeId(entry.recipeId);
                if (!recipe || !Number.isSafeInteger(entry.price) || entry.price < 0) continue;
                const capacity = Profit.mpBatches(actor.fetchMp?.(), recipe);
                if (capacity) rows.push([id, recipe.recipeId, entry.price, town,
                    actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(), capacityBucket(capacity)]);
            }
        }
        if (JSON.stringify(rows) === JSON.stringify(owned.rows)) continue;
        for (const row of owned.rows) playerCandidates.remove(`p:${id}:${row[1]}`);
        for (const row of rows) playerCandidates.put(`p:${id}:${row[1]}`, { ...candidateRow(row), playerWorkshop: true });
        owned.rows = rows;
        if (session.actor !== actor || !(World.user?.sessions || []).includes(session)) playerShops.delete(id);
    }
}
function playerLookup(ownerId, recipeId, customer) {
    if (customer?.phase !== 'hot') return null;
    refreshPlayers();
    const owner = playerShops.get(Number(ownerId));
    const row = owner?.rows.find(entry => entry[1] === Number(recipeId));
    if (!row) return null;
    const recipe = recipes().resolveByRecipeId(recipeId);
    return { playerWorkshop: true, recipe, price: row[2], entryPrice: row[2], session: owner.session,
        place: { town: row[3], loc: { locX: row[4], locY: row[5], locZ: row[6] } },
        state: { characterId: Number(ownerId), currentRegion: row[3],
            loc: { locX: row[4], locY: row[5], locZ: row[6] }, vitals: { mp: row[7] * Math.max(1, recipe.mpCost) } } };
}
function togglePublicDigest(row, direction = 1) {
    const productId = Number(recipes().resolveByRecipeId(row[1])?.productId || 0);
    if (!productId) return;
    const hash = invoke('GameServer/Bot/Fnv1a').fnv1a32(JSON.stringify(row));
    const scope = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(productId);
    const prior = publicScopeDigests.get(scope) || { xor: 0, sum: 0, count: 0 };
    const next = { xor: (prior.xor ^ hash) >>> 0, sum: (prior.sum + direction * hash) >>> 0, count: prior.count + direction };
    if (next.count > 0) publicScopeDigests.set(scope, next); else publicScopeDigests.delete(scope);
}
function publicScopeDigest(scope) {
    const value = publicScopeDigests.get(scope);
    return value ? `${value.xor}:${value.sum}:${value.count}` : '0:0:0';
}
function candidateRow(row) {
    return { characterId: row[0], recipeId: row[1], price: row[2], entryPrice: row[2],
        townName: row[3], loc: { locX: row[4], locY: row[5], locZ: row[6] }, capacityBatches: row[7] };
}
const crafters = new Map();
const knownRecipes = new Map();
const encodedRecipes = new Map();
function recipesChanged(id) { knownRecipes.delete(Number(id)); encodedRecipes.delete(Number(id)); }
let unsubscribe = null;
let unsubscribeOwnership = null;
let unsubscribeBoard = null;

// The state object each owner was last indexed from. Life states are replaced,
// not mutated, so the same object registered again (the change and the market
// review listeners both fire for one commit) rebuilds the same rows.
const registeredStates = new Map();

function remove(id, { recipes: dropRecipes = true, publish = true } = {}) {
    registeredStates.delete(Number(id));
    // A bot with a 'recipes' row: a cold crafter, or one whose recipes are loaded.
    const recipeRowShown = dropRecipes && (crafters.has(Number(id)) || knownRecipes.has(Number(id)));
    const removedRecipes = owners.get(Number(id)) || [];
    dropPublicRows(id);
    if (publish) for (const recipeId of removedRecipes) invoke('GameServer/Bot/Population/ColdTableChannel').shared
        .changed('board', { key: `w:${Number(id)}:${recipeId}`, removed: true });
    if (dropRecipes) recipesChanged(id);
    // Not under publish: the board rows publishRows rewrites do not include it.
    if (recipeRowShown) TableChannel.changed('recipes', { key: Number(id), removed: true });
    for (const recipeId of owners.get(Number(id)) || []) {
        const records = byRecipe.get(recipeId);
        records?.delete(Number(id));
        if (!records?.size) byRecipe.delete(recipeId);
    }
    owners.delete(Number(id));
    crafters.delete(Number(id));
}
function register(state) {
    const id = Number(state?.characterId);
    if (serving(state) && registeredStates.get(id) === state) {
        if (!crafters.has(id)) recipesChanged(id);
        if (Diagnostics.active()) Diagnostics.count('workshop_register', 'skipped', 'same_state');
        return;
    }
    if (Diagnostics.active()) Diagnostics.count('workshop_register', 'rebuilt');
    indexState(id, state);
    if (serving(state)) registeredStates.set(id, state);
}
// The owner's public rows leave the digest and the candidate index.
function dropPublicRows(id) {
    for (const row of publicRecipeRows(id)) { togglePublicDigest(row, -1); publicCandidates.remove(`w:${Number(id)}:${row[1]}`); }
}
// The owner's public rows built at its place, into the digest and the index.
function setPublicRows(id, place) {
    const ids = owners.get(id);
    ids.place = place;
    ids.publicRows = Object.freeze(buildPublicRecipeRows(id).map(row => Object.freeze(row)));
    for (const row of ids.publicRows) { togglePublicDigest(row); publicCandidates.put(`w:${id}:${row[1]}`, candidateRow(row)); }
}
// The worker's mirror gets the rows that differ from previousRows.
function publishRows(id, previousRows) {
    const rows = publicRecipeRows(id), keys = new Set(rows.map(row => row[1]));
    for (const row of previousRows) if (!keys.has(row[1])) TableChannel.changed('board', { key: `w:${id}:${row[1]}`, removed: true });
    for (const row of rows) {
        const prior = previousRows.find(old => old[1] === row[1]);
        if (!prior || row.some((value, at) => value !== prior[at])) TableChannel.changed('board', [`w:${id}:${row[1]}`, ...row]);
    }
}
function indexState(id, state) {
    const previousRows = publicRecipeRows(id);
    remove(id, { recipes: !serving(state), publish: false });
    if (!serving(state)) { publishRows(id, previousRows); return; }
    if (invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(state)) crafters.set(id, state);
    else recipesChanged(id);
    // A twin's workshop stands at its place (placeFor) wherever its body
    // hunts, cold or hot.
    const entries = TwinCluster.entriesOf(state);
    if (!entries?.length) { publishRows(id, previousRows); return; }
    const ids = [];
    for (const entry of entries) {
        const recipeId = Number(entry.recipeId);
        if (!byRecipe.has(recipeId)) byRecipe.set(recipeId, new Map());
        byRecipe.get(recipeId).set(id, state); // Original canonical source, never a second actor/state book.
        ids.push(recipeId);
    }
    owners.set(id, ids);
    setPublicRows(id, placeFor(state));
    publishRows(id, previousRows);
}
function init() {
    if (!unsubscribe) unsubscribe = life().subscribeChanges(register);
    if (!unsubscribeOwnership) unsubscribeOwnership = life().subscribeMarketReviewChanges(id => {
        const current = life().cachedState(id);
        if (current) register(current); else remove(id);
    });
    // The held rows read the shop's place (placeFor): an owner whose board
    // records changed is placed again, every owner when the board resets or
    // comes ready (also when it was ready before this subscription).
    if (!unsubscribeBoard && isMainThread) {
        unsubscribeBoard = afk().subscribeBoardChanges(change => reindex(change.reset || change.ready && !change.ownerIds
            ? [...owners.keys()] : (change.ownerIds || []).filter(id => owners.has(Number(id)))));
        if (afk().isBoardReady()) reindex([...owners.keys()]);
    }
}
// Moves the owners' rows to where their workshops stand now. A board change
// moves only the place: the offer and the capacity read the life state, which
// register rebuilds when it is replaced.
function reindex(ids) {
    for (const value of ids) {
        const id = Number(value), held = owners.get(id), state = registeredStates.get(id);
        if (!held) continue;
        if (!state || !life().cachedState(id)) { remove(id); continue; }
        const place = placeFor(state);
        if (samePlace(place, held.place)) continue;
        const previousRows = publicRecipeRows(id);
        dropPublicRows(id);
        setPublicRows(id, place);
        publishRows(id, previousRows);
    }
}
// A hot owner's body posted its facts (BotLifeState.notifyNearFacts: it came
// into the world, looted, died, revived): the capacity its rows publish reads
// the body's MP again (a hot row is not replaced on MP drift; markHot indexes
// the owner before its body is in the world). Rows move only when a bucket
// changed.
function bodyChanged(id) {
    id = Number(id);
    const held = owners.get(id);
    // A dead or gone body publishes no capacity (crafterMp 0).
    if (!held || life().cachedState(id)?.phase !== 'hot') return;
    const previousRows = publicRecipeRows(id);
    const rows = buildPublicRecipeRows(id);
    if (rows.length === previousRows.length && rows.every((row, at) => row[7] === previousRows[at][7])) return;
    dropPublicRows(id);
    setPublicRows(id, held.place);
    publishRows(id, previousRows);
}
function discount(crafter, customer, trust = 0) {
    const clan = Number(crafter.clanId || crafter.stats?.clanId || 0);
    if (!clan || clan !== Number(customer.clanId || customer.stats?.clanId || 0)) return 0;
    const persona = invoke('GameServer/Bot/AI/BotPersona').of(crafter);
    const empathy = Math.max(0, Math.min(1, Number(persona?.traits?.empathy || 0)));
    return empathy * Math.max(0, Math.min(1, (Number(trust) + 100) / 200));
}
function quote(crafter, customer, recipeId) {
    const entry = TwinCluster.entriesOf(crafter)?.find(row => Number(row.recipeId) === Number(recipeId));
    if (!entry) return null;
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const identity = state => ({ id: Number(state.characterId), clanId: Number(state.clanId || state.stats?.clanId || 0) });
    const relation = memory.assess(identity(crafter), identity(customer), {}, Date.now()).personal;
    const price = Math.max(0, Math.floor(Number(entry.price) * (1 - discount(crafter, customer, relation?.trust))));
    return { price, entryPrice: Number(entry.price) };
}
// Orders at a hot crafter's workshop since start: asked (a body was there)
// and served (committed); the live read of T93 move 1 (PopulationStatus).
const hotOrders = { asked: 0, served: 0 };
function hotOrderStats() { return { ...hotOrders }; }
async function craft(ownerId, recipeId, customerId, { expectedPrice = null, expectedRevision = null,
    batches = 1, original = null, random = Math.random, funding = { r: 1 } } = {}) {
    const database = invoke('Database');
    let customer = life().cachedState(customerId);
    let admitted = null;
    let liveOrder = false, liveCommitted = false;
    try {
        // Recovery retains the original identity and precedes the current
        // quote, recipe book and already-consumed material checks.
        if (original) {
            if (!customer) throw Error('workshop customer unavailable');
            admitted = await Commit.admit(customer, Commit.KINDS.craft, original);
            const body = bodyOf(life().cachedState(ownerId));
            const replay = () => database.craftForCustomer(Number(ownerId), Number(customerId), {
                economyCommand: admitted.command });
            const result = body ? await Mutations.run(body.backpack, async () => {
                const done = await replay();
                afk().syncOnlineInventory(ownerId, await database.fetchItems(Number(ownerId)));
                return done;
            }) : await replay();
            if (result.customerState) Commit.acceptRow(result.customerState);
            if (result.crafterState?.phase === 'cold') Commit.acceptRow(result.crafterState);
            return result;
        }
        const player = playerLookup(ownerId, recipeId, customer);
        if (player) {
            liveOrder = true;
            // lazy: worker a player workshop order runs on main; the worker loads this module
            const session = (invoke('GameServer/World/World').user?.sessions || [])
                .find(entry => Number(entry.actor?.fetchId?.()) === Number(customerId));
            if (!session || !customer || expectedPrice !== null && Number(expectedPrice) !== player.price)
                throw Error('workshop price changed');
            admitted = await Commit.admit(customer, Commit.KINDS.craft);
            // lazy: worker a player workshop order runs on main; the worker loads this module
            const result = await invoke('GameServer/Crafting/ManufactureShop').craft(session, Number(ownerId), Number(recipeId), random,
                { botOrder: true, batches, expectedPrice: player.price, funding, economyCommand: admitted.command });
            if (!result || !result.committed) throw Error('player_workshop_unavailable');
            liveCommitted = true;
            if (result.customerState) Commit.acceptRow(result.customerState);
            return result;
        }
        const crafter = life().cachedState(ownerId);
        const recipe = recipes().resolveByRecipeId(recipeId);
        const [physical] = await database.execute(['SELECT * FROM characters WHERE id = ?', [customerId]]);
        if (!physical || !crafter || !recipe || !Number.isSafeInteger(batches) || batches < 1 || batches > 64) {
            throw new Error('workshop unavailable');
        }
        customer ||= { characterId: Number(customerId), clanId: physical.clanId, stats: {} };
        const quoteValue = quote(crafter, customer, recipeId);
        if (!quoteValue || expectedPrice !== null && Number(expectedPrice) !== quoteValue.price
            || expectedRevision !== null && Number(expectedRevision) !== Number(crafter.simulation?.revision || 0)) {
            throw new Error('workshop price changed');
        }
        const materials = Profit.materials(await database.fetchItems(customerId, 'workshop_craft'), recipe, batches);
        if (!materials) throw new Error('workshop materials missing');
        const template = invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, recipe.productId);
        if (!template) throw new Error('workshop product missing');
        if (customer.phase) {
            admitted = await Commit.admit(customer, Commit.KINDS.craft);
            customer = admitted.state;
        }
        const product = { selfId: recipe.productId, amount: recipe.productCount * batches,
            name: template.template.name, stackable: !!template.etc?.stackable, slot: Number(template.etc?.slot || 0) };
        // A hot crafter's body spends the MP: the commit reads it there
        // (validate, in the transaction) and the body takes the rest. The
        // crafter side changes only its Adena row: the body takes that row
        // (ManufactureShop.applyAdena), its other items stay as they are. The
        // commit and that write run in the body's inventory queue, so a loot
        // pickup (PurchaseItem) never writes an Adena amount read before the
        // fee.
        const body = bodyOf(crafter), mpCost = Number(recipe.mpCost) * batches;
        if (crafter.phase === 'hot' && !body) throw new Error('workshop unavailable');
        if (body) hotOrders.asked++;
        const validate = body ? () => {
            if (bodyOf(life().cachedState(ownerId)) !== body || Number(body.fetchMp()) < mpCost) throw new Error('workshop unavailable');
            return { crafterMp: Number(body.fetchMp()) - mpCost };
        } : null;
        const commit = () => database.craftForCustomer(Number(ownerId), Number(customerId), {
            materials, product: admitted || Profit.succeeds(recipe, random) ? product : null,
            price: quoteValue.price * batches, crafterMp: crafterMp(crafter) - mpCost, validate,
            adena: { name: 'Adena' }, economyCommand: admitted?.command, funding, random,
            workshop: { recipeId, batches, entryPrice: quoteValue.entryPrice, fee: quoteValue.price * batches,
                crafterRevision: crafter.simulation?.revision || 0, customerRevision: customer.simulation?.revision || 0 }
        });
        const result = body ? await Mutations.run(body.backpack, async () => {
            const done = await commit();
            body.setMp?.(Math.max(0, Number(body.fetchMp()) - mpCost));
            // lazy: worker ManufactureShop is main-thread; the worker loads this module
            invoke('GameServer/Crafting/ManufactureShop').applyAdena(body, done.crafterAdena);
            body.statusUpdateVitals?.(body);
            hotOrders.served++;
            return done;
        }) : await commit();
        if (result.crafterState) Commit.acceptRow(result.crafterState);
        if (result.customerState) Commit.acceptRow(result.customerState);
        return result;
    } catch (error) {
        // The caller keeps this bounded original header when delivery fails;
        // no new attempt is inferred from the leftover materials.
        if (admitted && (!liveOrder || liveCommitted)) error.economyCommand = admitted.command;
        throw error;
    } finally {
        if (admitted) Commit.finish(customerId, admitted.command);
    }
}

async function knownFor(id) {
    id = Number(id);
    let known = knownRecipes.get(id);
    if (!known) {
        known = (await invoke('Database').fetchCharacterRecipes(id)).map(row => Number(row.recipeId));
        knownRecipes.set(id, known);
        TableChannel.changed('recipes', () => recipeRow(id));
    }
    return known;
}
function cachedRecipes(id) { return knownRecipes.get(Number(id)) || []; }
function bookFor(id) {
    id = Number(id);
    if (!knownRecipes.has(id)) return null;
    if (!encodedRecipes.has(id)) encodedRecipes.set(id, invoke('GameServer/Bot/Economy/RecipeBookCodec').pack(knownRecipes.get(id)));
    return encodedRecipes.get(id);
}
// A bot's recipe knowledge for planning: the packed book; empty until
// knownFor has loaded the bot's recipes.
function knowledgeFor(id) {
    return { recipeBook: bookFor(id) };
}
const recipeRow = id => ({ characterId: Number(id), ...knowledgeFor(id) });
// The 'recipes' table: one row per bot whose recipes main has loaded; the cold
// worker plans a far service crafter from it. A cache drop (recipesChanged)
// keeps the row until the next load replaces it, so the worker plans on the
// last known book meanwhile, not on none. Every learning reaches that load:
// a cold one sends the bot's snapshot (ColdSimulationCoordinator.ensureCraftRecipes),
// a hot one its return to cold (acceptColdState); a bot that leaves (remove)
// takes its row away.
if (isMainThread) TableChannel.register('recipes', { key: row => row.characterId,
    allRows: () => [...knownRecipes.keys()].map(recipeRow) });

// A workshop that no longer offers this recipe for good: its owner's saved
// workshop (its twin) leaves it out.
// An owner outside the cache or with no place yet is away for now: lookup
// misses it until it is back.
function withdrawn(ownerId, recipeId) {
    const owner = life().cachedState(ownerId);
    return serving(owner)
        && !(TwinCluster.entriesOf(owner) || []).some(entry => Number(entry.recipeId) === Number(recipeId));
}
function lookup(ownerId, recipeId, customer) {
    const player = playerLookup(ownerId, recipeId, customer);
    if (player) return player;
    // The index holds the owner's rows; the offer is read from its current
    // state (a hot owner's cached row is replaced with no change event: an
    // AFK sale, a hot merge), and quote misses a recipe it no longer lists.
    const state = life().cachedState(ownerId);
    if (!byRecipe.get(Number(recipeId))?.has(Number(ownerId)) || !serving(state)) return null;
    const place = owners.get(Number(ownerId))?.place;
    const offer = place && quote(state, customer, recipeId);
    return offer ? { state, place, recipe: recipes().resolveByRecipeId(recipeId), ...offer } : null;
}
// Existing public recipe index is the source; only its published fee, place
// and present physical capacity cross the worker boundary. No foreign book.
// The owner's save revision is not part of the public offer: it changes on
// every save and would republish the row and invalidate every customer's
// market read. Execution validates the live owner (lookup, craft revision).
function publicRecipeRows(ownerId) { return owners.get(Number(ownerId))?.publicRows || []; }
// ARCH-NOTE: capacity is published as a power-of-two floor (0, 1, 2, 4 .. 64)
// so MP regeneration republishes the row only when capacity halves or doubles;
// a plan may see up to half of the present batches. Execution recounts MP.
function capacityBucket(batches) {
    if (!(batches >= 1)) return 0;
    let bucket = 1;
    while (bucket * 2 <= batches) bucket *= 2;
    return bucket;
}
function buildPublicRecipeRows(ownerId) {
    const id = Number(ownerId), result = [], place = owners.get(id)?.place;
    if (!place) return result;
    let mp = null;
    for (const recipeId of owners.get(id) || []) {
        const state = byRecipe.get(recipeId)?.get(id);
        const entry = TwinCluster.entriesOf(state)?.find(row => Number(row.recipeId) === recipeId);
        const recipe = recipes().resolveByRecipeId(recipeId);
        if (!state || !entry || !recipe) continue;
        const capacity = Profit.mpBatches(mp ??= crafterMp(state), recipe);
        result.push([id, recipeId, Number(entry.price),
            place.town, place.loc.locX, place.loc.locY, place.loc.locZ, capacityBucket(capacity)]);
    }
    return result;
}
function* publicForRecipe(recipeId, customer = {}) {
    yield* publicCandidates.candidates(recipeId, customer.characterId);
    if (customer.phase !== 'hot') return;
    refreshPlayers();
    yield* playerCandidates.candidates(recipeId, customer.characterId);
}
function* publicRows() {
    for (const id of owners.keys()) for (const row of publicRecipeRows(id)) yield [`w:${id}:${row[1]}`, ...row];
}
function boardRecords() {
    return [...owners.keys()].flatMap(id => {
        const state = life().cachedState(id);
        const entries = TwinCluster.entriesOf(state);
        const place = owners.get(id).place;
        if (!entries?.length || !serving(state) || !place) return [];
        return [{ id: `workshop_${id}`, kind: 'workshop', ownerId: id, ownerName: state.name,
            town: place.town, loc: { ...place.loc }, title: `${state.name}'s workshop`,
            entries, revision: state.simulation?.revision || 0 }];
    });
}
module.exports = { init, register, serving, crafterMp, bodyChanged, hotOrderStats, registerPlayer, remove, recipesChanged, knownFor, cachedRecipes, bookFor, knowledgeFor, publicForRecipe, publicRecipeRows, publicRows, publicScopeDigest, quote, discount, boardRecords, lookup, placeFor, inWorkshopRange, withdrawn, craft };
