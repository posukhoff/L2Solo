'use strict';
// The kit surface (user 10-29): the spot table reads a bot's own kit by its
// numbers against the author's kit (HuntCycle.kitFeatures), on fight and
// damage-taken coefficients fitted from real fights in kits; a band without
// them reads the nearest measured one.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
invoke('GameServer/DataCache').init();
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');

const ref = { pAtk: 100, atkSpd: 300, accur: 40, critical: 40, mAtk: 50, castSpd: 300, pDef: 200, mDef: 150, evasion: 35, maxHp: 1000 };
const row = { mobAccur: 40, mobEvasion: 30 };
assert.deepEqual(HuntCycle.kitFeatures(ref, ref, row, false), [0, 0, 0, 0], 'the author\'s kit: no change');
const [offence, pDefence, mDefence, hp] = HuntCycle.kitFeatures({ ...ref, pAtk: 200, pDef: 300, mDef: 150, maxHp: 1200 }, ref, row, false);
assert(offence > 0.5 && pDefence > 0 && mDefence === 0 && hp > 0, 'a stronger weapon and armour move their features');
assert(HuntCycle.kitFeatures({ ...ref, mAtk: 100 }, ref, row, true)[0] > 0, 'a caster\'s offence is its M.Atk');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spot_table.json'), 'utf8'));
fixture.kitSurface = { features: HuntCycle.KIT_FEATURES, fields: ['fight', 'taken'],
    rows: { dps: { 10: [[-0.9, 0, 0, 0], [0, -0.8, -0.1, 0], 12, 0.05, 0.1] } } };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-surface-')), 'table.json');
fs.writeFileSync(file, JSON.stringify(fixture));
Table.useFile(file);
try {
    assert.deepEqual(Table.kitSurface('dps', 21), { fight: [-0.9, 0, 0, 0], taken: [0, -0.8, -0.1, 0] }, 'its band');
    assert.deepEqual(Table.kitSurface('dps', 40)?.fight, [-0.9, 0, 0, 0], 'a band without one reads the nearest');
    assert.equal(Table.kitSurface('tank', 21), null, 'a key without a surface: none');
} finally {
    Table.useFile();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
}
console.log('PASS hunt kit surface');
