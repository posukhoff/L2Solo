const ClanCrafting = require('../../Clan/ClanCraftingPolicy');
const { partyIdOf } = require('../Population/PartyId');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Karma = require('../../Karma');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');
const C4DualSwordCombinations = invoke('GameServer/Items/C4DualSwordCombinations');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const ColdTrip = invoke('GameServer/Bot/Population/ColdTrip');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Profit = require('./CraftProfitPolicy');
const Commit = require('./EconomyCommit');
const Production = require('./ProductionPolicy');
const Workshops = require('./CraftWorkshopService');

const NATIVE_TRAVEL_MS = ColdTrip.AUTHOR_TRIP_MS;

// A plan's workshop agreement now: the dwarf's offer (selected, null when not
// offered now) and whether its fee left the agreed price (repriced).
function workshopAgreement(provider, recipeId, state) {
    const selected = Workshops.lookup(provider.characterId, recipeId, state);
    return { selected, repriced: !!selected && provider.price != null && Number(selected.entryPrice) !== Number(provider.price) };
}

// Who crafts this recipe for the bot: the provider its held plan names
// (plan.craftProviders: a bot workshop or the bot itself from
// WishProviders.personalCraftPlan, a clan crafter from the clan planners), or
// the blacksmith of a dual-sword exchange. No Giran station serves bots: a
// recipe no provider crafts is no craft, null. The bot itself crafts where it
// stands while its skill covers the recipe (canCraft); capacityBatches is
// what its MP pays for now (0: it waits for MP, craftTrip).
function stationForRecipe(recipeId, state = null) {
    const combination = C4DualSwordCombinations.resolveByRecipeId(recipeId);
    if (combination) return combination.station;
    const provider = state?.stats?.equipmentPlan?.craftProviders?.[recipeId];
    if (provider?.self) {
        const recipe = C4RecipeItems.resolveByRecipeId(recipeId);
        if (!CraftShopService.canCraft(state, recipe)) return null;
        return { id: `self_${state.characterId}`, characterId: Number(state.characterId), self: true,
            loc: { ...(state.loc || {}) }, recipeId: Number(recipeId),
            capacityBatches: Profit.mpBatches(state.vitals?.mp, recipe) };
    }
    if (provider?.workshop) {
        // The agreement is the dwarf and his published fee; his save revision
        // is read here and checked again by the craft after the async reads.
        const { selected, repriced } = workshopAgreement(provider, recipeId, state);
        if (!selected || repriced) return null;
        return { id: `workshop_${provider.characterId}`, characterId: provider.characterId,
            playerWorkshop: selected.playerWorkshop === true,
            loc: { ...selected.place.loc }, townName: selected.place.town, workshop: true,
            recipeId: Number(recipeId), price: selected.price, entryPrice: selected.entryPrice,
            revision: Number(selected.state.simulation?.revision || 0),
            capacityBatches: Profit.mpBatches(selected.state.vitals?.mp, selected.recipe) };
    }
    if (provider && state.stats.equipmentPlan.clanGoal?.clanId
        && (!Production.buyersDisabled() || state.stats.equipmentPlan.clanGoal.orderId)) return {
        id: `clan_crafter_${provider.characterId}`, characterId: provider.characterId,
        loc: provider.loc, clan: true
    };
    return null;
}

// Why stationForRecipe found no provider: gone for good (true: the held plan
// cannot run) or away for now (false: the plan waits). Gone: a workshop its
// cold owner withdrew or repriced (Workshops.withdrawn, workshopAgreement); a
// craft the plan names no workshop for (none, or a clan crafter) while the
// static buyers are enabled. Away: that same craft while the static buyers are
// disabled; the plan waits.
function providerGone(state, recipeId) {
    const provider = state?.stats?.equipmentPlan?.craftProviders?.[recipeId];
    if (provider?.self) return false;
    if (provider?.workshop) {
        return Workshops.withdrawn(provider.characterId, recipeId) || workshopAgreement(provider, recipeId, state).repriced;
    }
    return !Production.buyersDisabled();
}

function componentFor(state, selfId) {
    return C4RecipeItems.resolveByRecipeId(state?.stats?.equipmentPlan?.componentRecipes?.[selfId])
        || C4RecipeItems.resolveByProductId(selfId);
}

function recipeForState(state, recipe) {
    const provider = state?.stats?.equipmentPlan?.craftProviders?.[recipe?.recipeId];
    if (!recipe || !provider || provider.known || provider.workshop) return recipe;
    return ClanCrafting.recipeForProvider(recipe, provider);
}

function hasMaterials(state, recipe) {
    recipe = recipeForState(state, recipe);
    const required = Profit.requirements(recipe);
    return !!required && [...required].every(([id, amount]) => Number(state?.inventory?.[id]?.amount || 0) >= amount);
}

// The held plan's next craft by the plan's one readiness rule
// (Planner.craftReadiness): the deepest recipe with its inputs in the bag
// whose provider runs it now (stationForRecipe: offered, with MP for a batch;
// a component's output reaches its parent on the next cold-life tick). A
// recipe the plan already holds the product of is no craft.
// gone (nextCraft only): collects a recipe the plan crafts (the final one, a
// named provider or component recipe) whose inputs are in the bag but whose
// provider no longer offers it.
function readyRecipeFor(state, recipe, gone = null) {
    const plan = state?.stats?.equipmentPlan;
    if (!recipe || !plan?.clanGoal && Number(plan?.recipeId) === Number(recipe.recipeId)
        && requiredCraftCount(recipe, recipe, state) === 0) return null;
    const crafter = at => {
        const station = stationForRecipe(at.recipeId, state);
        if (station && !(station.workshop && !(station.capacityBatches >= 1))) return recipeForState(state, at);
        if (gone && (Number(at.recipeId) === Number(recipe.recipeId) || plan?.craftProviders?.[at.recipeId]
            || Number(plan?.componentRecipes?.[at.productId]) === Number(at.recipeId))
            && hasMaterials(state, at) && providerGone(state, at.recipeId)) gone.recipe = at;
        return null;
    };
    return Planner.craftReadiness(recipe, state, crafter, id => componentFor(state, id), []).recipe;
}

// The held plan's next craft: the deepest ready recipe and who crafts it.
// refusal: a craft the plan holds whose provider is gone for good
// (providerGone), the ready recipe itself or a planned component with its
// inputs in the bag: the held plan cannot run, a rejection the caller raises
// as an event (PopulationService resolveColdCraft, ShoppingState
// workshopTarget), for a bot at the provider or on its way. A provider away
// for now: no station, no refusal, the plan waits.
function nextCraft(state) {
    const plan = state?.stats?.equipmentPlan;
    const finalRecipe = C4RecipeItems.resolveByRecipeId(plan?.recipeId)
        || C4DualSwordCombinations.resolveByRecipeId(plan?.recipeId);
    const gone = { recipe: null };
    const recipe = readyRecipeFor(state, finalRecipe, gone);
    const station = recipe ? stationForRecipe(recipe.recipeId, state) : null;
    return { finalRecipe, recipe, station, refusal: !recipe && gone.recipe ? 'missing_station' : null };
}

// The station runs the next craft where the bot stands now: its own recipe
// with MP for a batch, a workshop in range (and MP, readyRecipeFor), a clan
// crafter (craft() follows him) or a dual-sword blacksmith.
function runsHere(state, station) {
    if (!station) return false;
    if (station.self) return station.capacityBatches >= 1;
    return !station.workshop || Workshops.inWorkshopRange(station, state.loc);
}

const NO_TRIP = Object.freeze({ trip: null, refusal: null });
const CRAFT_HERE = Object.freeze({ trip: null, refusal: null, here: true });
// The trip to the held plan's next craft (trip null: none), the craft where
// the bot stands (here: its own recipe; out of MP it hunts on and regains
// it), or its refusal. A plan that says ready (its status from the same
// readiness rule) with nothing its providers run now is refused (no_crafter):
// the plan rebuilds instead of coming back to this command every step. A
// closed town stops only a trip.
function craftTrip(state, timestamp = Date.now()) {
    const plan = state?.stats?.equipmentPlan;
    if (!state || state.activity === 'traveling' || !Planner.planRunning(plan) || plan.strategy !== 'craft') return NO_TRIP;
    const { finalRecipe, recipe, station, refusal } = nextCraft(state);
    if (refusal) return { trip: null, refusal };
    if (!station) return plan.status === 'active' ? NO_TRIP : { trip: null, refusal: 'no_crafter' };
    if (station.self) return station.capacityBatches >= 1 ? CRAFT_HERE : NO_TRIP;
    if (Karma.closesTowns(state.stats?.karma)) return NO_TRIP;
    const nearestTown = TownRespawn.getClosestTown(state.loc?.locX, state.loc?.locY, state.loc?.locZ);
    return { trip: ColdTrip.toTown(state, {
        to: { ...station.loc },
        townName: station.townName || 'Giran',
        regionName: station.regionName || station.townName || 'Giran',
        viaTown: nearestTown?.name || null,
        arrivalActivity: 'crafting',
        reason: C4DualSwordCombinations.isCombination(recipe)
            ? 'dual_sword_combine'
            : recipe.recipeId === finalRecipe?.recipeId ? 'equipment_craft' : 'component_craft',
        stationId: station.id
    }, timestamp, {
        craftReturn: state.stats?.craftReturn || { loc: { ...(state.loc || {}) }, spotId: state.spotId || null, regionName: state.currentRegion || null }
    }), refusal: null };
}

function beginTravel(state, timestamp = Date.now()) {
    return craftTrip(state, timestamp).trip;
}

// The trip back from a craft station to the spot the bot left (craftReturn).
function returnTrip(state, from, craftReturn, reason, timestamp) {
    const returnTown = TownRespawn.getClosestTown(craftReturn.loc.locX, craftReturn.loc.locY, craftReturn.loc.locZ);
    return ColdTrip.toSpot(state, {
        from: { ...from },
        to: { ...craftReturn.loc },
        townName: returnTown?.name || craftReturn.regionName || 'Hunting Ground',
        regionName: craftReturn.regionName || state.currentRegion,
        viaTown: returnTown?.name || null,
        spotId: craftReturn.spotId || null,
        arrivalActivity: 'hunting',
        arrivalEvent: 'returned_to_spot',
        reason
    }, timestamp, { extraStats: { craftReturn: null } });
}

function materialRows(items, recipe, multiplier = 1) {
    return Profit.materials(items, recipe, multiplier);
}

function hasNonSupplementalMaterials(items, recipe, multiplier = 1) {
    return Profit.craftableBatches(items, recipe, multiplier) >= multiplier;
}

async function supplementMaterials(characterId, items) {
    // The same public result shape; every crystal and gemstone is now a real input.
    return { items, supplemented: [] };
}

// The background resolver carries a virtual inventory between materializations,
// while crafting changes the physical rows transactionally.  Rebuild from the
// latter after either path, otherwise consumed inputs can linger in the
// summary and send a bot back to a station with phantom materials.
function refreshPhysicalInventory(state) {
    return LifeState.refreshInventory({ ...state, inventory: {} }, { equip: true });
}

function craftableBatchCount(items, recipe, requested = 1) {
    return Profit.craftableBatches(items, recipe, requested);
}

function requiredCraftCount(finalRecipe, recipe, state, requestedOutput = null, visited = new Set()) {
    if (!finalRecipe || !recipe || visited.has(Number(finalRecipe.recipeId))) return 1;
    const desired = requestedOutput === null
        ? Math.max(0, Math.max(1, Number(state?.stats?.equipmentPlan?.outputAmount || finalRecipe.productCount || 1))
            - (state?.stats?.equipmentPlan?.clanGoal ? 0 : Number(state?.inventory?.[finalRecipe.productId]?.amount || 0)))
        : Math.max(0, Number(requestedOutput || 0));
    const crafts = Profit.batchesFor(finalRecipe, desired);
    if (crafts === null) return 0;
    if (Number(finalRecipe.recipeId) === Number(recipe.recipeId)) return crafts;
    const nextVisited = new Set(visited).add(Number(finalRecipe.recipeId));
    for (const [id, amount] of Profit.requirements(finalRecipe) || []) {
        const component = componentFor(state, id);
        if (!component) continue;
        const owned = Number(state?.inventory?.[id]?.amount || 0);
        if (!Number.isSafeInteger(amount * crafts)) return 0;
        const needed = Math.max(0, amount * crafts - owned);
        if (Number(component.recipeId) === Number(recipe.recipeId)) return Math.ceil(needed / Math.max(1, Number(recipe.productCount || 1)));
        const nested = requiredCraftCount(component, recipe, state, needed, nextVisited);
        if (nested > 1 || Number(component.recipeId) === Number(recipe.recipeId)) return nested;
    }
    return 1;
}

function hasCombinationIngredients(items, recipe) {
    // The native blacksmith exchange may consume the currently worn sword;
    // ordinary craft readiness excludes equipped inputs.
    const required = Profit.requirements(recipe), amounts = new Map();
    for (const item of items || []) amounts.set(Number(item.selfId), (amounts.get(Number(item.selfId)) || 0) + Number(item.amount || 0));
    return !!required && [...required].every(([id, count]) => (amounts.get(id) || 0) >= count);
}

async function combineDualSword(state, recipe, station) {
    const items = await Database.fetchItems(state.characterId, 'cold_craft_dual_sword');
    if (!hasCombinationIngredients(items, recipe)) {
        return { state: await refreshPhysicalInventory(state), crafted: false, reason: 'materials_changed' };
    }
    const template = ItemTemplateIndex.find(DataCache.items, recipe.productId);
    if (!template) return { state, crafted: false, reason: 'missing_product' };

    let result;
    try {
        result = await Database.combineInventoryItems(state.characterId, {
            ingredients: recipe.materials,
            product: {
                selfId: Number(recipe.productId),
                name: template.template?.name || '',
                amount: 1,
                slot: Number(template.etc?.slot || 0)
            }
        });
    } catch (error) {
        return {
            state: await refreshPhysicalInventory(state),
            crafted: false,
            reason: 'combine_rejected',
            error: String(error?.message || error)
        };
    }

    const craftReturn = state.stats?.craftReturn;
    const refreshed = await refreshPhysicalInventory(craftReturn?.loc
        ? returnTrip(state, state.loc || station.loc, craftReturn, 'dual_sword_combine_return', Date.now())
        : { ...state, activity: 'hunting', stats: { ...(state.stats || {}), craftReturn: null, travel: null } });
    return {
        state: refreshed,
        crafted: true,
        reason: 'dual_sword_combined',
        result,
        stationId: station.id,
        recipeId: recipe.recipeId,
        productId: Number(recipe.productId),
        productName: template.template?.name || `Item ${recipe.productId}`,
        batchCount: 1
    };
}

async function craft(state, random = Math.random) {
    const plan = state?.stats?.equipmentPlan;
    const next = nextCraft(state);
    const { finalRecipe, station } = next;
    let recipe = next.recipe;
    if (!state || state.activity !== 'crafting') return { state, crafted: false, reason: 'not_ready' };
    if (next.refusal) return { state, crafted: false, reason: next.refusal };
    if (!recipe || !station) return { state, crafted: false, reason: 'not_ready' };
    if (C4DualSwordCombinations.isCombination(recipe)) {
        return combineDualSword(state, recipe, station);
    }
    if (station.self) return craftHere(state, finalRecipe, recipe, station);

    // The provider is a clan crafter or a bot workshop (stationForRecipe).
    const crafter = { id: station.characterId };
    const crafterState = await LifeState.findByCharacterId(crafter.id);
    if (!crafterState || crafterState.phase !== 'cold') return { state, crafted: false, reason: 'station_busy' };

    let learning = false;
    if (station.clan) {
        const clanId = Number(plan.clanGoal?.clanId);
        const [membership] = await Database.execute(['SELECT clanId FROM characters WHERE id = ?', [crafter.id]]);
        if (Number(membership?.clanId) !== clanId || partyIdOf(crafterState)
            || Number(crafterState.vitals?.hp) <= 0 || ['dead', 'respawning'].includes(crafterState.activity)
            || !CraftShopService.canCraft(crafterState, recipe)) {
            return { state, crafted: false, reason: 'clan_crafter_unavailable' };
        }
        if (Math.hypot(Number(state.loc?.locX) - Number(crafterState.loc?.locX),
            Number(state.loc?.locY) - Number(crafterState.loc?.locY)) > 1200) {
            const moved = { ...state, stats: { ...state.stats, equipmentPlan: { ...plan,
                craftProviders: { ...plan.craftProviders, [recipe.recipeId]: { ...plan.craftProviders[recipe.recipeId], loc: crafterState.loc } } } } };
            return { state: beginTravel(moved) || state, crafted: false, reason: 'clan_crafter_moved' };
        }
        const known = await Database.fetchCharacterRecipes(crafter.id);
        learning = !known.some(row => Number(row.recipeId) === Number(recipe.recipeId));
        const providers = { ...plan.craftProviders, [recipe.recipeId]: { ...plan.craftProviders[recipe.recipeId], known: !learning } };
        state = { ...state, stats: { ...state.stats, equipmentPlan: { ...plan, craftProviders: providers } } };
        recipe = recipeForState(state, recipe);
    }
    // A workshop stands at its place (station.loc, Workshops.lookup): moved
    // since the trip, the customer travels there again.
    if (station.workshop && !Workshops.inWorkshopRange(station, state.loc)) {
        return { state: beginTravel(state) || state, crafted: false, reason: 'workshop_moved' };
    }
    const entry = station.workshop ? Workshops.quote(crafterState, state, recipe.recipeId) : { price: 0 };
    const template = ItemTemplateIndex.find(DataCache.items, recipe.productId);
    const crafterMp = Number(crafterState.vitals?.mp || 0);
    if (!entry || !template || Profit.mpBatches(crafterMp, recipe) < 1) {
        return { state, crafted: false, reason: 'station_unavailable' };
    }

    const componentCraft = Number(recipe.recipeId) !== Number(finalRecipe?.recipeId);
    const customerItems = await Database.fetchItems(state.characterId, 'cold_craft');
    const requestedBatch = !learning ? requiredCraftCount(finalRecipe, recipe, state) : 1;
    const materialBatch = craftableBatchCount(customerItems, recipe, Math.min(64, requestedBatch));
    const batchCount = Math.min(materialBatch, Profit.mpBatches(crafterMp, recipe));
    if (!batchCount || !hasNonSupplementalMaterials(customerItems, recipe, batchCount)) {
        const reconciled = await refreshPhysicalInventory(state);
        return { state: reconciled, crafted: false, reason: 'materials_changed' };
    }
    const supplemental = await supplementMaterials(state.characterId, customerItems, recipe, batchCount);
    const materials = materialRows(supplemental.items, recipe, batchCount);
    if (!materials) return { state, crafted: false, reason: 'materials_changed' };
    let success = station.workshop ? null : Profit.succeeds(recipe, random);
    const price = Number(entry.price || 0) * batchCount;
    const adena = Number(customerItems.find((item) => Number(item.selfId) === 57)?.amount || 0);
    if (adena < price) {
        return {
            state: await refreshPhysicalInventory(state),
            crafted: false,
            reason: 'insufficient_adena',
            requiredAdena: price,
            availableAdena: adena
        };
    }
    let result;
    try {
        result = station.workshop ? await Workshops.craft(crafter.id, recipe.recipeId, state.characterId, {
            batches: batchCount, expectedPrice: entry.price, expectedRevision: station.revision, random, funding: { r: Number(plan.valueRate || 0) }
        }) : await Database.craftForCustomer(crafter.id, state.characterId, {
            materials,
            product: success ? {
                selfId: Number(recipe.productId),
                name: template.template?.name || '',
                kind: template.template?.kind || '',
                amount: Number(recipe.productCount || 1) * batchCount,
                stackable: !!template.etc?.stackable,
                slot: Number(template.etc?.slot || 0)
            } : null,
            crafterMp: crafterMp - Number(recipe.mpCost || 0) * batchCount,
            price,
            adena: { name: 'Adena' },
            ...(plan.clanGoal?.orderId ? { clanOrder: { orderId: plan.clanGoal.orderId,
                settings: plan.clanGoal.orderSettings, final: !componentCraft } } : {}),
            ...(station.clan ? { clanCraft: { clanId: Number(plan.clanGoal.clanId), recipeId: recipe.recipeId,
                learning, crafterRevision: crafterState.simulation?.revision ?? crafterState.simulationRevision ?? 0,
                customerRevision: state.simulation?.revision ?? state.simulationRevision ?? 0,
                mpCost: Number(recipe.mpCost) * batchCount } } : {})
        });
    } catch (error) {
        // The recovery only finds a craft that landed; its own refusal
        // (craft_executor_changed: no landed command) hides the cause.
        if (station.workshop && error.economyCommand) {
            try {
                result = await Workshops.craft(crafter.id, recipe.recipeId, state.characterId,
                    { original: error.economyCommand });
            } catch { /* nothing landed: the original error stands */ }
        }
        if (!result) {
            // A refusal spends nothing. Keep the original header if delivery
            // is uncertain; an ordinary replan never invents a second attempt.
            return { state: await refreshPhysicalInventory(state), crafted: false, reason: 'craft_rejected',
                error: String(error?.message || error),
                ...(error.economyCommand ? { economyCommand: error.economyCommand } : {}) };
        }
    }
    if (station.workshop) success = result.success !== false;
    // The craft fee reaches the returned wallet through the exchange receipt:
    // validate it before the writers below; no receipt means no fee was paid.
    const cashReceipt = result?.customerAdena;
    const committedAdena = cashReceipt == null ? undefined : cashReceipt.amount;
    if (cashReceipt != null && (!Number.isSafeInteger(committedAdena) || committedAdena < 0)) {
        throw new TypeError('Invalid customer craft cash receipt');
    }
    if (station.clan && learning) invoke('GameServer/Bot/Economy/CraftWorkshopService').recipesChanged(crafter.id);
    if (station.workshop) {
        LifeState.acceptLifecycleRow(result.crafterState);
        const committed = LifeState.acceptLifecycleRow(result.customerState);
        state = { ...committed, stats: { ...state.stats, ...committed.stats } };
    } else {
        // Clan crafter: both rows are clan-craft states; the customer keeps only
        // the clan inventory revision, and the provider is marked as knowing the recipe.
        LifeState.acceptClanCraftState(result.crafterState);
        const committed = LifeState.acceptClanCraftState(result.customerState);
        state = { ...committed, stats: { ...state.stats, clanInventoryRevision: committed.stats.clanInventoryRevision } };
        state.stats.equipmentPlan.craftProviders[recipe.recipeId].known = true;
    }
    // Workshop/clan publication may replace state with a lifecycle row. Adopt
    // the committed cash afterwards: refreshInventory preserves virtual income
    // with Math.max and cannot reconcile a paid fee from an older balance.
    if (cashReceipt != null) state = { ...state, adena: committedAdena };
    return settle(state, plan, finalRecipe, recipe, station, template, success, result, batchCount, supplemental.supplemented);
}

// After a craft (success or a failed roll): back to the spot after the final
// recipe, on to the next ready component, or to the unseal errand.
async function settle(state, plan, finalRecipe, recipe, station, template, success, result, batchCount, supplemented = []) {
    const componentCraft = Number(recipe.recipeId) !== Number(finalRecipe?.recipeId);
    const craftReturn = state.stats?.craftReturn;
    const timestamp = Date.now();
    const needsUnseal = success && !componentCraft && Number(plan.unseal?.sourceId) === Number(recipe.productId);
    // Decide whether to remain at the station after inventory refresh.
    // The crafted output may unlock another component, but if its raw
    // inputs are exhausted the bot must resume farming instead of idling
    // forever in the high-priority crafting queue.
    const refreshed = await refreshPhysicalInventory(!componentCraft && !needsUnseal && craftReturn?.loc
        ? returnTrip(state, state.loc || station.loc, craftReturn, 'equipment_craft_return', timestamp)
        : { ...state, activity: 'hunting',
            stats: { ...(state.stats || {}), craftReturn: componentCraft || needsUnseal ? craftReturn : null, travel: null } });
    // The base receipt continues the same town errand. A party return ticket
    // must not send it back to the field before its final native conversion.
    const unsealTravel = needsUnseal
        ? invoke('GameServer/Bot/AI/BotMammonUnseal').beginTravel(refreshed, timestamp, { fromCraft: true }) : null;
    // After a component: crafting on where its next step runs here now, a
    // trip to the next step's station elsewhere (craftTrip), else back to
    // the spot (out of MP the bot hunts on and regains it).
    const next = componentCraft ? nextCraft(refreshed) : null;
    const nextCraftable = !!next?.recipe && !C4DualSwordCombinations.isCombination(next.recipe);
    const continueCrafting = nextCraftable && runsHere(refreshed, next.station);
    const nextTrip = nextCraftable && !continueCrafting && next.station && !next.station.self
        ? craftTrip(refreshed, timestamp).trip : null;
    const returnAfterComponent = componentCraft && !continueCrafting && craftReturn?.loc;
    const settled = unsealTravel || (continueCrafting
        ? { ...refreshed, activity: 'crafting' }
        : nextTrip || (returnAfterComponent
            ? returnTrip(refreshed, state.loc || station.loc, craftReturn, 'component_craft_return', timestamp)
            : needsUnseal && craftReturn?.loc
                ? returnTrip(refreshed, state.loc || station.loc, craftReturn, 'equipment_craft_return', timestamp)
                : refreshed));
    // The kept plan names the MP of its next own step (the worker's wait,
    // plan.selfCraftMp); a next step by another crafter waits for none.
    const keptPlan = next?.recipe && settled.stats?.equipmentPlan;
    const nextPlan = keptPlan && { ...keptPlan, selfCraftMp: Number(next.recipe.mpCost || 0) };
    if (nextPlan && !next.station?.self) delete nextPlan.selfCraftMp;
    const planned = nextPlan ? { ...settled, stats: { ...settled.stats, equipmentPlan: nextPlan } } : settled;
    return {
        state: planned,
        crafted: success,
        reason: success ? componentCraft ? 'component_crafted' : 'crafted' : 'craft_failed',
        result,
        stationId: station.id,
        recipeId: recipe.recipeId,
        productId: Number(recipe.productId),
        productName: template.template?.name || `Item ${recipe.productId}`,
        batchCount
        , supplementedMaterials: supplemented
    };
}

// The bot crafts its plan's recipe itself where it stands (a `self`
// provider): the batches the plan still needs that its bag and MP pay for.
async function craftHere(state, finalRecipe, recipe, station) {
    const items = await Database.fetchItems(state.characterId, 'cold_craft_self');
    const batchCount = Math.min(craftableBatchCount(items, recipe, Math.min(64, requiredCraftCount(finalRecipe, recipe, state))),
        station.capacityBatches);
    const materials = batchCount > 0 ? materialRows(items, recipe, batchCount) : null;
    if (!materials) return { state: await refreshPhysicalInventory(state), crafted: false, reason: 'materials_changed' };
    let own;
    try {
        own = await craftOwn(state, recipe, batchCount, materials);
    } catch (error) {
        // Another economy write of the bot in flight is a wait; any other
        // refusal (a recipe or material changed, a reserved input) rebuilds.
        return { state: await refreshPhysicalInventory(state), crafted: false,
            reason: ['economy_operation_in_flight', 'economy_admission_pressure'].includes(error?.message)
                ? 'own_craft_busy' : 'own_craft_rejected',
            error: String(error?.message || error) };
    }
    // The row holds the saved stats: this step's plan stays, the commit
    // leaf is the row's.
    return settle({ ...own.state, stats: { ...state.stats, economyCommit: own.state.stats?.economyCommit } },
    state.stats.equipmentPlan, finalRecipe, recipe, station, ItemTemplateIndex.find(DataCache.items, recipe.productId),
    own.result?.success === true, own.result, batchCount);
}

// The committed row of an own craft (else the admitted state) with the MP the
// receipt left.
function acceptOwnCraft(result, admitted) {
    const row = result?.coldLifeRow ? Commit.acceptRow(result.coldLifeRow) : admitted;
    return { ...row, vitals: { ...(row.vitals || {}), mp: Number(result?.mp ?? row.vitals?.mp) } };
}

// One native craft by the bot itself (no station, no fee) under the economy
// commit admission: accept(receipt, admitted state) turns the receipt of
// Database.craftInventoryItems (coldLifeRow, success, units, mp) into the
// bot's state before the admission ends. Returns that state and the receipt.
// Read by the plan's own craft (craftHere), the producer
// (ColdWealthCraftService.execute) and the shot scrap (ColdShotEconomyService).
async function craftOwn(state, recipe, batches, materials, accept = acceptOwnCraft) {
    const template = ItemTemplateIndex.find(DataCache.items, Number(recipe.productId));
    let admission = null;
    try {
        admission = await Commit.admit(state, Commit.KINDS.craft);
        const result = await Database.craftInventoryItems(admission.state.characterId, {
            materials, coldState: admission.state, recipeId: Number(recipe.recipeId), batches,
            economyCommand: admission.command,
            product: { selfId: Number(recipe.productId), name: template?.template?.name || '',
                amount: Number(recipe.productCount || 1) * batches, stackable: !!template?.etc?.stackable,
                slot: Number(template?.etc?.slot || 0) } });
        return { state: await accept(result, admission.state), result };
    } finally { if (admission) Commit.finish(state.characterId, admission.command); }
}

module.exports = { NATIVE_TRAVEL_MS, craftOwn, stationForRecipe, hasMaterials, hasNonSupplementalMaterials, hasCombinationIngredients, readyRecipeFor, nextCraft, supplementMaterials, craftableBatchCount, requiredCraftCount, craftTrip, beginTravel, craft };
