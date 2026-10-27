'use strict';
// A bot crafter's workshop offer as the worker proposes it at the bot's hour
// (TwinCluster.propose over its recipe book) and the far step's commit saves
// it in the bot's mind; main's index publishes it on the save (w: rows).
// The caller has loaded src/Global.
async function publishTwinOffer(state, { hourAdena = 1000 } = {}) {
    const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    Workshop.init();
    const twin = invoke('GameServer/Bot/Economy/TwinCluster').propose(state, {
        book: await Workshop.knownFor(state.characterId), hourAdena,
        mpPerHour: invoke('GameServer/Bot/Population/ColdOccupationSources').mpPerHour(state) });
    if (!twin) return state;
    return invoke('GameServer/Bot/Population/BotLifeState').upsertState({ ...state, stats: { ...state.stats, twin } }, 'twin_offer');
}
module.exports = { publishTwinOffer };
