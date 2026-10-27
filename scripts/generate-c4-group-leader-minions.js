// Minion groups of ordinary (non-raid) group leaders from the pinned Lisvus
// minions table, in the raid-boss minion format (data/Npcs/Minions), for the
// leaders our world spawns. Minion templates the world does not define yet are
// added from Lisvus npc.sql in the shape the monster slices use.
const fs = require('fs');
const path = require('path');
const lib = require('./lib/generate-c4-monster-location');

const root = path.resolve(__dirname, '..');
const slug = 'c4_group_leader_minions';
const filename = `${slug}.json`;

// Group leaders of the Lisvus table that our world does not spawn (spawns come from
// L2J_Mobius C4, T43): 376, 398, 520, 522, 738 (not in Mobius spawns), Tanor Silenos
// (no spawn), five raid bosses without a spawn and four Four Sepulchers Shadows of Halisha.
const absentLeaderIds = [376, 398, 520, 522, 738, 936, 10273, 10290, 10296, 10306, 10316, 10339, 10342, 10346, 10349];
// Spawned leaders Mobius gives no minions (its 928/929 and 931/932 stand alone beside
// them): no group until T48 moves the minion rows to Mobius.
const loneLeaderIds = new Set([930, 933]);
const expectedNewMinionIds = [
    940, 942, 943, 945, 946, 948, 949, 951, 952, 954, 955, 957, 958, 960, 961, 962, 964, 965,
    967, 968, 970, 971, 972, 975, 976, 978, 979, 981, 982, 984, 985, 987, 988, 990,
    992, 993, 995, 1040, 1059, 1060, 1074, 1076, 1077, 1079, 1080, 1082, 1083, 1091,
    1092, 1313, 1344, 1346, 1348, 1349, 1370, 1372, 1374, 1375, 1542, 1543, 1545,
    1546, 1597, 1598, 1600, 1601
];

lib.assertLisvusRevision();

function jsonArrays(directory, excluded) {
    return fs.readdirSync(path.join(root, directory))
        .filter((name) => name.endsWith('.json') && name !== excluded)
        .map((name) => require(path.join(root, directory, name)))
        .filter(Array.isArray)
        .flat();
}

const raidMinionRows = require(path.join(root, 'data/Npcs/Minions/c4_raid_bosses.json'));
const raidBossIds = new Set(raidMinionRows.map((row) => Number(row.bossId)));
const sourceRows = lib.tuples('sql/minions.sql')
    .filter((row) => row.length === 4 && row.every(Number.isInteger)) // not the PRIMARY KEY line
    .map((row) => ({ bossId: Number(row[0]), minionId: Number(row[1]), min: Number(row[2]), max: Number(row[3]) }));
if (sourceRows.length !== 405) throw new Error(`Expected 405 Lisvus minion rows, found ${sourceRows.length}`);
const leaderRows = sourceRows.filter((row) => !raidBossIds.has(row.bossId));
if (leaderRows.length !== 121) throw new Error(`Expected 121 ordinary group leader rows, found ${leaderRows.length}`);

const knownNpcs = jsonArrays('data/Npcs', filename);
const knownNpcIds = new Set(knownNpcs.map((npc) => Number(npc.selfId)));
if (leaderRows.some((row) => knownNpcs.find((npc) => Number(npc.selfId) === row.bossId)?.template?.raidBoss === true)) {
    throw new Error('A raid boss leads an ordinary minion row');
}
const spawnedIds = new Set(jsonArrays('data/Npcs/Spawns')
    .flatMap((area) => area.spawns || [])
    .filter((spawn) => Number(spawn.total) > 0)
    .map((spawn) => Number(spawn.selfId)));

const absentIds = [...new Set(leaderRows.filter((row) => !spawnedIds.has(row.bossId)).map((row) => row.bossId))]
    .sort((a, b) => a - b);
lib.assertExact(absentIds, absentLeaderIds, 'absent group leaders');
const rows = leaderRows.filter((row) => spawnedIds.has(row.bossId) && !loneLeaderIds.has(row.bossId));
if (rows.length !== 90) throw new Error(`Expected 90 rows of spawned group leaders, found ${rows.length}`);

const newMinionIds = [...new Set(rows.map((row) => row.minionId))]
    .filter((id) => !knownNpcIds.has(id))
    .sort((a, b) => a - b);
lib.assertExact(newMinionIds, expectedNewMinionIds, 'new minion templates');

// Lisvus spawns most of them as L2Minion; the rest are plain monsters
// that only ever appear as someone's minion.
const { npcs, rewards, skillRows, dropRows, items: missingItems, unknownSkillIds } =
    lib.lisvusMonsters(newMinionIds, { slug, types: ['L2Minion', 'L2Monster'] });
if (skillRows.length !== 375) throw new Error(`Expected 375 minion skill rows, found ${skillRows.length}`);

// NPC Self Damage Shield (Lisvus skills 4100-4199.xml): a self buff, 600 s.
const skillTemplates = [{
    selfId: 4163,
    template: { name: 'NPC Self Damage Shield', passive: false, spell: false, distance: -1 },
    time: { hitTime: 1800, reuse: 8000, buff: 600000 },
    levels: [12, 19, 26, 35, 45, 55, 65, 69, 72, 75, 77, 78].map((mp, index) => ({
        level: index + 1, power: 0, mp, hp: 0, itemId: 0, itemCount: 0
    }))
}];
lib.assertExact(unknownSkillIds, skillTemplates.map((skill) => skill.selfId), 'missing minion skill templates');

if (dropRows.length !== 1050) throw new Error(`Expected 1050 minion drop rows, found ${dropRows.length}`);
// Recipe: Greater Spiritshot (B) Compressed Package (100%), recipe 505 of recipes.csv.
lib.assertExact(missingItems.map((item) => item.selfId), [5275], 'item dependencies');

lib.writeJson('data/Npcs/Minions/c4_group_leaders.json', rows);
lib.writeJson(`data/Npcs/${filename}`, npcs);
lib.writeJson(`data/Npcs/Rewards/${filename}`, rewards);
lib.writeJson(`data/Npcs/Skills/${filename}`, skillRows);
lib.writeJson(`data/Npcs/Skills/${slug}_templates.json`, skillTemplates);
lib.writeJson(`data/Items/Others/${filename}`, missingItems);

const leaderCount = new Set(rows.map((row) => row.bossId)).size;
console.info(`Generated ${rows.length} minion rows for ${leaderCount} group leaders, ${npcs.length} minion templates, ${skillRows.length} skill rows, ${skillTemplates.length} skill templates, ${dropRows.length} drop rows, ${missingItems.length} items.`);
