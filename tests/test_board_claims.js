'use strict';
// Board line claims: a bot that decides an errand trip for board lines claims the units
// it will buy of them; another bot's purchase decision reads those units as gone, the
// claimant does not; the claim ends with its errand (bought, refused, lapsed) or the
// bot's death. First come wins: the units left stay on the board for others.
const assert = require('node:assert/strict');
require('../src/Global');
const Claims = invoke('GameServer/Bot/Economy/BoardClaims');
const CombinedErrands = invoke('GameServer/Bot/Population/CombinedErrandPolicy');

const now = Date.now();
const line = (lineId, count) => ({ recordId: 50, lineId, count, selfId: 1864, price: 100 });
const errand = { selfId: 1864, amount: 7, town: 'Giran', purpose: 'wealth_craft', tag: [5], at: now };
const holder = { characterId: 1, activity: 'traveling', stats: CombinedErrands.enqueue({ stats: {} }, errand, now).stats };
const counts = {};
Claims.claim(1, errand, [{ line: line(1, 5), count: 5 }, { line: line(2, 9), count: 2 }], key => { counts[key] = (counts[key] || 0) + 1; });
assert.equal(Claims.unclaimed(line(1, 5), 2, now), 0, 'a line claimed whole is gone for another buyer');
assert.equal(Claims.unclaimed(line(1, 5), 1, now), 5, 'the claimant still buys it');
assert.equal(Claims.unclaimed(line(2, 9), 2, now), 7, 'the units left stay for others');
assert.equal(Claims.unclaimed(line(1, 5), 2, now + CombinedErrands.ERRAND_MS), 5, 'a claim past its errand\'s life holds nothing');
// A buyer's purchase plan reads the units left (OfferQuery countOf): the claimed line holds
// nothing for it, the other line its unclaimed part.
const Query = invoke('GameServer/Bot/Economy/OfferQuery');
const plan = Query.fill([line(1, 5), line(2, 9)], 9, { countOf: row => Claims.unclaimed(row, 2, now) });
assert.deepEqual(plan.lines.map(entry => [entry.line.lineId, entry.count]), [[2, 7]], 'only the unclaimed units are planned');
Claims.ownerChanged(holder);
assert.equal(Claims.unclaimed(line(1, 5), 2, now), 0, 'the errand still held: the claim stands');
Claims.ownerChanged({ ...holder, activity: 'dead' });
assert.equal(Claims.unclaimed(line(1, 5), 2, now), 5, 'the claimant died: released');
Claims.claim(1, errand, [{ line: line(1, 5), count: 5 }]);
Claims.ownerChanged({ ...holder, stats: CombinedErrands.complete(holder, errand, now).stats });
assert.equal(Claims.unclaimed(line(1, 5), 2, now), 5, 'the errand ended: released');
assert.deepEqual(Claims.size(), { lines: 0, owners: 0 }, 'nothing left behind');
assert.equal(counts['board:claim:taken'], 1);
console.log('board claims: PASS (claimed units gone for others, released with the errand or a death)');
process.exit(0);
