'use strict';
// A bot that wants a recipe (its shot plan is buying the scroll) learns the
// held scroll at its next visit, through the native learn transaction, and the
// learning fills the demand.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('wanted-recipe');
require('../src/Global');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
fixture.assertConfigured(options.default);

const SCROLL = 1805, ID = 3;
async function run() {
    Database.init();
    const recipe = Recipes.resolve(SCROLL);
    assert(recipe && recipe.recipeId === 21 && recipe.type === 'dwarven', 'the scroll teaches dwarven recipe 21');
    await Native.character(Database, ID, 'Wanted' + ID, 'bot_wanted_recipe');
    await Database.setSkill({ selfId: 172, name: 'Create Item', level: 9 }, ID);
    await Database.setItem(ID, { selfId: SCROLL, name: 'Recipe', amount: 1 });
    const scroll = { selfId: SCROLL, name: 'Recipe', amount: 1, kind: 'Other.Recipe' };
    await Life.upsertState({ characterId: ID, accountName: 'bot_wanted_recipe', name: 'Wanted' + ID, level: 60,
        exp: 0, sp: 0, adena: 0, phase: 'cold', activity: 'shopping', homeRegion: 'Giran', currentRegion: 'Giran',
        loc: { x: 83000, y: 148000, z: -3400 }, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { classId: 57, shotRecipeDemand: { itemId: SCROLL, amount: 1, maxSpend: 1000, at: Date.now() } },
        inventory: { [SCROLL]: scroll }, simulation: { revision: 0 },
        timing: {}, updatedAt: Date.now() }, 'wanted_recipe_fixture');
    const state = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [ID]]))[0]);
    assert.equal(Number(state.inventory?.[SCROLL]?.amount), 1);

    const learned = await Life.learnCraftableRecipes(state);
    assert((learned.stats?.lastRecipeBookLearning?.learned || []).some(row => Number(row.recipeId) === 21),
        'the wanted recipe is learned without an explicit recipe list');
    assert((await Database.fetchCharacterRecipes(ID)).some(row => Number(row.recipeId) === 21), 'recipe 21 is in the recipe book');
    assert.equal(learned.stats?.shotRecipeDemand ?? null, null, 'learning the demanded recipe fills the demand');
    assert.equal(Native.amount(await Database.fetchItems(ID), SCROLL), 0, 'learning consumes the scroll');
    console.log('Wanted recipe scroll: learned at the visit');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Commit.clear();
    await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
