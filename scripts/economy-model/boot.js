'use strict';

// Game data for the economy model scripts, without a World or a database: the
// hunt tables' boot (game data at rate x1), then a rate preset. The owners the
// model reads (SpotValueTable, SpotRewardExpectation, NpcShopBuyLists) key
// their rows on the rate profile, so one process switches presets by setting
// the rate variable and resetting the profile, as the table generators do.
//
// The hunt tables' boot changes the working directory to the tree root. The
// model depends on it: C4RecipeItems reads data/Recipes/recipes.csv relative
// to the working directory and, started from another folder, finds no recipe
// and says nothing.
const common = require('../hunt-tables/common');

const PRESETS = Object.freeze(['x1', 'x10', 'x50']);

function boot(preset = 'x1') {
    common.boot();
    usePreset(preset);
    return invoke('GameServer/DataCache');
}

function usePreset(preset) {
    if (!PRESETS.includes(preset)) throw new Error(`unknown preset ${preset} (one of ${PRESETS.join(', ')})`);
    process.env.L2NODE_PROGRESSION_RATE = preset;
    invoke('GameServer/ProgressionRates').reset();
}

// --name value and --name=value command-line options.
function option(argv, name, fallback) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === `--${name}`) return argv[i + 1] ?? fallback;
        if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
    }
    return fallback;
}

function presetsOption(argv) {
    return String(option(argv, 'preset', PRESETS.join(','))).split(',').map(text => text.trim()).filter(Boolean);
}

module.exports = { boot, usePreset, option, presetsOption, PRESETS, root: common.root };
