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
const TableFingerprint = require('../../src/GameServer/Bot/AI/TableFingerprint');

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

// The tree files this process has loaded through require, as root-relative
// paths: after an extract, every module of the extract (the model's own
// scripts, inputs.js itself, the game modules it reads and theirs) and the
// data they require. Derived from the module graph, so a module the extract
// starts to read joins without a list to keep.
function loadedFiles() {
    const prefix = common.root + path.sep;
    return Object.keys(require.cache).filter(file => file.startsWith(prefix) && !file.includes(`${path.sep}node_modules${path.sep}`))
        .map(file => path.relative(common.root, file).split(path.sep).join('/')).sort();
}

// The contents of these tree files; a file gone hashes as missing.
function sourcesHash(files) {
    const hash = crypto.createHash('sha256');
    for (const file of files) {
        const full = path.join(common.root, file);
        hash.update(`${file}\n`).update(fs.existsSync(full) ? fs.readFileSync(full) : 'missing').update('\n');
    }
    return hash.digest('hex').slice(0, 16);
}

// The live game data a snapshot is made from: the hunt tables' fingerprint
// (TableFingerprint 'hunt', over the code and data the hunt tables and the
// hunt cycle are simulated by, data/Npcs, Items, Skills, Templates and
// Recipes among them), the spot table's own (its header) and the contents of
// the extract's loaded files (loadedFiles).
function dataStamp(files) {
    return { fingerprint: TableFingerprint.fingerprint('hunt').hash,
        spotTable: JSON.parse(fs.readFileSync(path.join(common.root, 'data', 'Bots', 'spot-table.json'), 'utf8')).header?.fingerprint?.hash || null,
        sources: sourcesHash(files) };
}

// A snapshot header's stamp equals the live game data's.
function stampMatches(header) {
    if (!Array.isArray(header?.sourceFiles)) return false;
    const live = dataStamp(header.sourceFiles);
    return Object.keys(live).every(field => header[field] && header[field] === live[field]);
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

module.exports = { boot, usePreset, loadedFiles, dataStamp, stampMatches, option, presetsOption, PRESETS, root: common.root };
