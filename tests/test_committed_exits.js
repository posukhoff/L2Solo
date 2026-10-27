'use strict';
// A buyer's line already served by rivals' plans in flight (CommittedExits,
// written from each bot's wish build): a producer sizes its lots at what
// they leave (PriceDecision.bidLots, `producer`), its own plan not
// subtracted; a holder answering the line with goods in hand is not cut.
// A bot commits the rows it can produce without waiting for money.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Price = require('../src/GameServer/Bot/Economy/PriceDecision');
const Committed = require('../src/GameServer/Bot/Economy/CommittedExits');

const SELLER = 1, RIVAL = 7;
// The line bids over the item's NPC buy-back (600): a bid at or under it is no buyer.
const line = { recordId: 500, lineId: 2, ownerId: 900, selfId: 1879, price: 1000, count: 1, enchant: 0, custodyPolicy: 0 };
const lots = (producer = SELLER) => Price.bidLots({ characterId: SELLER }, line, { asks: [], oldUnits: 0, perLot: 1, producer });
const commit = (botId, recordId, lineId, amount = 1) =>
    Committed.commit(botId, [{ key: `resale:${line.selfId}`, amount, exit: [recordId, lineId, line.price, 1] }]);

assert.equal(lots(), 1, 'a one-unit line no rival plans for: one lot');
commit(SELLER, line.recordId, line.lineId);
assert.equal(lots(), 1, 'the seller\'s own plan on the line is not a rival');
commit(RIVAL, line.recordId, line.lineId + 1);
assert.equal(lots(), 1, 'a rival on another line leaves this one open');
commit(RIVAL, line.recordId, line.lineId);
assert.equal(lots(), 0, 'one rival committed to the one-unit line: no lot left');
assert.equal(lots(0), 1, 'a holder of the goods still sells its unit into the line');
commit(RIVAL, line.recordId, line.lineId + 1);
assert.equal(lots(), 1, 'the rival\'s next build moved its plan: the line is open again');
commit(RIVAL, line.recordId, line.lineId);
Committed.remove(RIVAL);
assert.equal(lots(), 1, 'the rival unloaded: the line is open again');
Committed.clear();

// Which rows a bot commits (exitRows, WishNetwork.build): what it can produce
// without waiting for money, so a ready row the craft step may take commits
// even off its active leaf, the active leaf's root commits, a root the leaf
// only earns money for does not. The restore from the held card
// (heldProducers) applies the same rule to the leaf's root.
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const onLine = (lineId, recipeReady, item = line.selfId) =>
    ({ key: `resale:${item}`, amount: 1, exit: [line.recordId, lineId, line.price, 1], recipeReady });
const rivalBuild = (producers, activity) => Committed.commit(RIVAL, Committed.exitRows(producers, activity));
const other = { rootKey: 'resale:1880', activity: 'shopping' };
rivalBuild([onLine(line.lineId, true), onLine(line.lineId + 1, false, 1880)], other);
assert.equal(lots(), 0, 'a ready row off the active leaf is a plan in flight: the line is served');
rivalBuild([onLine(line.lineId, false)], other);
assert.equal(lots(), 1, 'a row waiting for its scroll off the active leaf serves nothing');
rivalBuild([onLine(line.lineId, false)], { rootKey: `resale:${line.selfId}`, activity: 'shopping' });
assert.equal(lots(), 0, 'the active leaf\'s root serves its line');
const farming = { rootKey: `resale:${line.selfId}`, activity: 'hunting', funding: true };
rivalBuild([onLine(line.lineId, false)], farming);
assert.equal(lots(), 1, 'a root the bot only earns money for serves nothing yet');
const card = leaf => ({ activity: { ...leaf, exitKey: [line.recordId, line.lineId] }, wish: [Decision.kindCode('resale'), 1] });
Committed.commit(RIVAL, Decision.heldProducers(card({ rootKey: `resale:${line.selfId}`, activity: 'shopping' })));
assert.equal(lots(), 0, 'the restored card commits the leaf\'s root as the build does');
Committed.commit(RIVAL, Decision.heldProducers(card(farming)));
assert.equal(lots(), 1, 'a restored card earning its root\'s money commits nothing, as the build');
Committed.clear();
console.log('PASS committed exits: a line served by a rival plan leaves no lot to a producer, a holder still sells, own plan and other lines do not count; a bot commits its ready rows and its active non-funding root, at build and at restore');
