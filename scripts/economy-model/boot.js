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
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
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

// Every game file the model's hours read beyond the hunt tables' own hash
// (TableFingerprint 'hunt'): the spot table's reader, the hunt reader, the
// reward expectation, the walk back, the shot and item pricing, the death
// valuation and the caster mark, the servitor's life rule and the skill model
// its upkeep is read through, the arrow of each bow grade. A change to one
// changes an hour, a mark, an upkeep or an id of the snapshot.
const EXTRA_FILES = Object.freeze([
    'src/GameServer/Bot/AI/SpotValueTable.js',
    'src/GameServer/Bot/AI/BotHuntEfficiency.js',
    'src/GameServer/Bot/Economy/SpotRewardExpectation.js',
    'src/GameServer/Bot/Economy/WalkBack.js',
    'src/GameServer/Bot/Economy/StaticMerchantPricing.js',
    'src/GameServer/Bot/Economy/EconomicValuation.js',
    'src/GameServer/Bot/Economy/BotImprovementPolicy.js',
    'src/GameServer/Npc/SummonControl.js',
    'src/GameServer/Model/Skill.js',
    'src/GameServer/Inventory/ArrowStock.js',
    'src/GameServer/Actor/BowResources.js'
]);

function extraFilesHash() {
    const hash = crypto.createHash('sha256');
    for (const file of EXTRA_FILES) hash.update(`${file}\n`).update(fs.readFileSync(path.join(common.root, file))).update('\n');
    return hash.digest('hex').slice(0, 16);
}

// The live game data a snapshot is made from: the hunt tables' fingerprint
// (TableFingerprint 'hunt', over the code and data the hunt tables and the
// hunt cycle are simulated by), the spot table's own (its header) and the
// contents of the extra files.
function dataStamp() {
    return { fingerprint: invoke('GameServer/Bot/AI/TableFingerprint').fingerprint('hunt').hash,
        spotTable: JSON.parse(fs.readFileSync(path.join(common.root, 'data', 'Bots', 'spot-table.json'), 'utf8')).header?.fingerprint?.hash || null,
        extraFiles: extraFilesHash() };
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

module.exports = { boot, EXTRA_FILES, usePreset, dataStamp, option, presetsOption, PRESETS, root: common.root };
