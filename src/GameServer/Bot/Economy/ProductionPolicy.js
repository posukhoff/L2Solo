'use strict';

const ShotStock = invoke('GameServer/Inventory/ShotStock');
const config = () => invoke('GameServer/Bot/Population/PopulationConfig');
function buyersDisabled() { return config().staticBuyersDisabled === true; }
function shotsDisabled() { return config().staticShotsDisabled === true; }
// The shop-shot test first: most readers ask about items that are no shot.
function allowsFixedShot(id) { return ShotStock.SHOP_SHOT_RANK.has(Number(id)) && !shotsDisabled(); }
module.exports = { buyersDisabled, shotsDisabled, allowsFixedShot };
