'use strict';

// RM-20: the player (clan 6000000) logs in, goes to the Fallen Orc Shaman fields (spots 30_6, 29_6) and stays online and idle
// for the whole window (the step never resolves; --minutes ends it).

const ADEN = { locX: 147450, locY: 25900, locZ: -2000 };
const SHAMAN_FIELDS = { locX: 181800, locY: 41900, locZ: -3672 };

module.exports = {
    name: 'rm20-player',
    players: 1,
    // The code only a player online reaches: the near-player scan and party forming's player budget.
    areas: ['GameServer/Bot/Population/PopulationService.js', 'GameServer/Bot/Population/HotActivation.js'],
    needs: { towns: ['Aden'] },
    place() {
        const { locX, locY, locZ } = ADEN;
        return invoke('GameServer/World/TownRespawn').getClosestTown(locX, locY, locZ) || ADEN;
    },

    async run({ step, setup, player }) {
        await step('the player goes to the Fallen Orc Shaman fields', async () => {
            if (setup.teleport(player, SHAMAN_FIELDS) === false) throw new Error('teleport refused');
        });
        await step('the player stays online', () => new Promise(() => {}));
    }
};
