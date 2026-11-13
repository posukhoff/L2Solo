'use strict';
// The economy model's specification and its code registry stay one list: the
// situation and lever rows of the model's specification marked built or old are exactly the ids
// of rules/levers.js, each lever points at a function, and each built row
// names a test case that exists.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { specRows } = require('../scripts/economy-model/spec-rows');
const { LEVERS } = require('../scripts/economy-model/rules/levers');

const rows = specRows(fs.readFileSync(path.join(__dirname, '../scripts/economy-model/SPEC.md'), 'utf8'));
const STATUSES = ['planned', 'built', 'old'];

for (const row of rows) assert.ok(STATUSES.includes(row.cells.status), `SPEC.md:${row.line} ${row.id}: status "${row.cells.status}" is not one of ${STATUSES.join(', ')}`);

// Situation rows sit in tables with a fact column, lever rows in tables with a kind column.
const standing = list => list.filter(row => ('fact' in row.cells || 'kind' in row.cells) && ['built', 'old'].includes(row.cells.status)).map(row => row.id);

// Throws with each id that stands on one side only, printed on its side.
function assertOneList(specIds, codeIds) {
    const notInCode = specIds.filter(id => !codeIds.includes(id)), notInSpec = codeIds.filter(id => !specIds.includes(id));
    assert.ok(!notInCode.length && !notInSpec.length,
        `a row or a lever on one side only fails with its id: in SPEC.md, not in rules/levers.js: [${notInCode.join(', ')}]; in rules/levers.js, not in SPEC.md: [${notInSpec.join(', ')}]`);
}

const specIds = standing(rows), codeIds = Object.keys(LEVERS);
assert.ok(specIds.length > 0, 'SPEC.md has situation or lever rows marked built or old');
assertOneList(specIds, codeIds);

// A row or a lever added on one side only fails, its id printed: one id removed
// from a parsed copy of the spec, then from a copy of the registry.
const removed = specIds[0];
assert.throws(() => assertOneList(standing(rows.filter(row => row.id !== removed)), codeIds),
    error => error.message.includes(`in rules/levers.js, not in SPEC.md: [${removed}]`),
    'a lever with no spec row fails with its id');
assert.throws(() => assertOneList(specIds, codeIds.filter(id => id !== removed)),
    error => error.message.includes(`in SPEC.md, not in rules/levers.js: [${removed}]`),
    'a spec row with no lever fails with its id');

for (const id of codeIds) assert.equal(typeof LEVERS[id], 'function', `${id} points at the function that does it`);

// Each built row's test cell names a case that exists in that test file.
for (const row of rows.filter(each => each.cells.status === 'built')) {
    const cell = row.cells.test || '', at = cell.indexOf(': ');
    assert.ok(at > 0, `SPEC.md:${row.line} ${row.id}: a built row names "<test file>: <case>", got "${cell}"`);
    const file = path.join(__dirname, cell.slice(0, at)), name = cell.slice(at + 2);
    assert.ok(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(name), `SPEC.md:${row.line} ${row.id}: no case "${name}" in ${cell.slice(0, at)}`);
}

console.log('test_economy_model_spec: ok');
