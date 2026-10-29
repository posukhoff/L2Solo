'use strict';
// The hunt cycle model (HuntCycle, T60): gear, henna and potions are worth
// the hunt income they add an hour, through the review's gear gain
// (WishProviders.gearGain) and the model's reader.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');
const timestamp = 1791335800000;
const template = id => Index.find(Data.items, id);
let owner = 953001;
// The author's kit of the class at the level, less the worn rows of `free`.
function bot(classId, level, free = []) {
    const state = HuntCycle.referenceState(classId, level);
    state.characterId = owner++;
    for (const [key, row] of Object.entries(state.inventory)) if (free.includes(Number(row.slot))) delete state.inventory[key];
    return state;
}
const ctx = { gearThreatMask: 1 };

// A level-30 warrior without a helmet: the D helmet of its kit pays a
// little of its hour, never most of it.
const bare = bot(1, 30, [6]);
const helmet = Providers.gearGain(bare, template(47), ctx, timestamp);
assert(helmet > 0 && helmet < 0.5, `a helmet for the empty head slot adds a sane share of the hour (${helmet})`);
const chest = Providers.gearGain(bot(1, 30, [10]), template(58), ctx, timestamp);
assert(chest > helmet, `a breastplate adds more than a helmet (${chest} vs ${helmet})`);

// A level-45 gladiator with no weapon: a C dual pays more than a D dual, both
// more than nothing, and neither multiplies the hour beyond reason.
const unarmed = bot(2, 45, [7, 8, 14]);
const dWeapon = Providers.gearGain(unarmed, template(2529), ctx, timestamp);
const cWeapon = Providers.gearGain(unarmed, template(2554), ctx, timestamp);
assert(dWeapon > 0 && cWeapon > dWeapon, `a C weapon adds more than a D one (${cWeapon} vs ${dWeapon})`);
assert(cWeapon < 20, `a weapon's gain stays bounded (${cWeapon})`);
// Worn already: no gain.
assert.equal(Providers.gearGain(bot(2, 45), template(2554), ctx, timestamp), 0, 'the worn weapon adds nothing');

// CON reaches the seated rest: the same kit numbers with one more CON rest
// shorter; a symbol that also takes 3 STR fights longer and earns less.
const fighter = bot(1, 30);
const { before, after } = Profile.candidateProfiles(fighter, timestamp);
const reader = HuntCycle.reader(fighter, ctx);
const sturdier = { ...before, con: before.con + 1 };
assert(reader.gain(before, sturdier) > 0, 'one more CON shortens the rest: it adds hunt income');
const symbol = invoke('GameServer/Henna/HennaRules').availableForClass(1).find(row => row.CON > 0 && row.STR < 0);
assert(reader.gain(before, after({ hennas: [symbol.id] })) < 0, 'CON +1 STR -3 costs a fighter more than it saves');
// Healing potions save the rest their heal would take, where the spot's
// fights drink them (a level-70 gladiator's best spots; on the T106 tables
// its level-50 spots no longer drink them).
const drinker = bot(2, 70);
const drinks = Profile.candidateProfiles(drinker, timestamp).before;
assert(HuntCycle.reader(drinker, ctx).potionGain(drinks, 336) > 0, 'healing potions save rest');
assert.equal(reader.potionGain(before, 336), 0, 'no potion worth where the fights drink none');
// The review's potions row (EconomyContext.basics stock) adds the rest saved
// to the deaths its potions avert.
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const deps = { spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), knowledgeEnabled: false };
const basics = Economy.basics({ ...drinker, adena: 100000, vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 } }, deps);
const potions = basics.stock('potions');
assert(potions.usePerHour > 0 && potions.benefitPerUnit * potions.usePerHour > basics.expectedDeathHours,
    `the potions row counts the rest its heal saves (${potions.benefitPerUnit} x ${potions.usePerHour} vs ${basics.expectedDeathHours})`);
// T108: mobs hit and cast; the table measures the part of the damage from
// spells (spellTaken). On rows where all of it is spells M.Def saves rest and
// P.Def nothing; where none of it is, the other way round.
const Table = require('../src/GameServer/Bot/AI/SpotValueTable');
const realCycle = Table.cycle;
const withSpells = part => {
    Table.cycle = (...args) => { const row = realCycle(...args); return row && { ...row, spellTaken: row.taken * part }; };
    // A reader is kept per state: a copy of the fighter reads the patched rows.
    try { return HuntCycle.reader({ ...fighter }, ctx); } finally { Table.cycle = realCycle; }
};
const thicker = key => ({ ...before, [key]: before[key] * 1.5 });
const casters = withSpells(1), hitters = withSpells(0);
assert(casters.gain(before, thicker('mDef')) > 0 && casters.gain(before, thicker('pDef')) === 0,
    'against spells M.Def pays and P.Def does not');
assert(hitters.gain(before, thicker('pDef')) > 0 && hitters.gain(before, thicker('mDef')) === 0,
    'against hits P.Def pays and M.Def does not');
for (const id of [bare, unarmed, fighter, drinker].map(state => state.characterId)) Profile.forgetBuild(id);
console.log('PASS hunt cycle: empty-slot helmet, D vs C weapon, CON henna and potions valued by the hunt income they add');
