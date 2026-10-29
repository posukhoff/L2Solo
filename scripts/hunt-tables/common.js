'use strict';

// Shared plumbing of the offline hunt tables (scripts/hunt-tables/build.js):
// the game-data boot at rate x1, deterministic randomness, rounding and the
// table file with its header of input fingerprints (pattern spot-table.json).

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(root, 'data', 'Bots', 'hunt');
const SCHEMA = 1;
const MAX_LEVEL = 78;
// C4 classes: 0-57 (88+ are later chronicles' third professions).
const MAX_C4_CLASS = 57;

let booted = false;
function boot() {
    if (booted) return;
    process.chdir(root);
    process.env.L2NODE_CONFIG_FILE = path.join(root, 'config', 'default.ini');
    delete process.env.L2NODE_SHARED_CONFIG_FILE;
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    require('../../src/Global');
    invoke('GameServer/DataCache').init({ validate: false });
    booted = true;
}

function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Runs work with Math.random seeded (the spawn catalogue and a few owners roll it).
function seeded(seed, work) {
    const random = Math.random;
    Math.random = mulberry(seed);
    try { return work(); } finally { Math.random = random; }
}

function round(value, digits = 4) {
    if (!Number.isFinite(value)) throw new Error(`non-finite value ${value}`);
    return value === 0 ? 0 : Number(value.toPrecision(digits));
}

function files(target) {
    const full = path.join(root, target);
    if (!fs.existsSync(full)) return [];
    if (fs.statSync(full).isFile()) return [target];
    return fs.readdirSync(full).sort().flatMap(name => files(path.join(target, name)));
}

// A short sha1 of each input path (file or directory, recursive).
function fingerprints(inputs) {
    const out = {};
    for (const input of inputs) {
        const sha = crypto.createHash('sha1');
        for (const file of files(input)) {
            sha.update(file);
            sha.update(fs.readFileSync(path.join(root, file)));
        }
        out[input] = sha.digest('hex').slice(0, 12);
    }
    return out;
}

function gitRevision() {
    try {
        const head = childProcess.execSync('git rev-parse --short=9 HEAD', { cwd: root }).toString().trim();
        const dirty = childProcess.execSync('git status --porcelain -- src data/Npcs data/Items data/Skills data/Templates data/Henna data/Recipes',
            { cwd: root }).toString().trim() !== '';
        return dirty ? `${head}+local` : head;
    } catch (_) {
        return 'unknown';
    }
}

// The game data every table reads (DataCache) and the code that reads it.
const GAME_INPUTS = ['data/Npcs', 'data/Items', 'data/Skills', 'data/Templates', 'data/Henna', 'data/Recipes',
    'data/Bots/spot-reward-npcs.json', 'data/Bots/spot-table.json'];

function tablePath(name) {
    return path.join(OUT_DIR, `${name}.json`);
}

// Writes data/Bots/hunt/<name>.json: { header, ...body }. Returns its size in bytes.
function writeTable(name, { inputs = {}, counts = {}, startedAt, extraInputs = [] }, body) {
    const header = { schema: SCHEMA, table: name, generator: 'scripts/hunt-tables/build.js', revision: gitRevision(),
        fingerprints: fingerprints([...GAME_INPUTS, ...extraInputs]), inputs, counts,
        buildSeconds: round((Date.now() - startedAt) / 1000, 3) };
    const text = `${JSON.stringify({ header, ...body })}\n`;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(tablePath(name), text);
    return text.length;
}

function readTable(name) {
    return JSON.parse(fs.readFileSync(tablePath(name), 'utf8'));
}

function c4ClassIds() {
    boot();
    const ids = new Set();
    for (const row of invoke('GameServer/DataCache').classTemplates) {
        const id = Number(row.classId);
        if (Number.isInteger(id) && id >= 0 && id <= MAX_C4_CLASS) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
}

module.exports = { root, OUT_DIR, MAX_LEVEL, boot, hash, mulberry, seeded, round, writeTable, readTable, tablePath, c4ClassIds,
    fingerprints };
