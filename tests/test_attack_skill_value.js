'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Catalog = invoke('GameServer/Skills/SkillBookCatalog');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');

// Free class skills never create a book purchase, including for clan bots.
invoke('GameServer/Clan/ClanSupplyPolicy').publish({ id: 1, level: 1, state: {} }, []);
const mage = { characterId: 990013, phase: 'cold', activity: 'hunting', level: 45, adena: 0, sp: 1e6,
    inventory: {}, vitals: {}, stats: { classId: 12, clanId: 1, exp: Data.experience[44], coldCombat: {
        classId: 12, skillSource: 'database', skills: Profile.skillSnapshotsFromRecords([{ selfId: 1230, level: 1 }])
    }, persona: { understanding: .8, traits: { commitment: .5, caution: .5, resilience: .5,
        ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 } } } };
assert.deepEqual(Catalog.missingBooks(mage), []);
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const context = Economy.forState(mage);
assert(!context.projection.nodes.some(node => node.key.startsWith('book:')),
    'native skill gains do not cause purchases of automatically granted skills');
Economy.reset();
assert.equal(invoke('Database').isReady(), false);
console.log('Attack skills: no book purchase for granted skills passed');
