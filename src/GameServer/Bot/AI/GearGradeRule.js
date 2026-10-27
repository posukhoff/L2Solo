// The gear grade a character level is expected to wear (C4: D from 20, C from 40, B from 52, A from 61, S from 76).
// The one level->grade table: KnowledgeLearning's stages and every gear grade ceiling read it.
const GRADE_LEVELS = Object.freeze({ d: 20, c: 40, b: 52, a: 61, s: 76 });
// Grades in wear order, from 'none' (level 1).
const GRADES = Object.freeze(['none', ...Object.keys(GRADE_LEVELS)]);
// The wear-order index of each grade: none 0, d 1 .. s 5.
const GRADE_RANK = Object.freeze(Object.fromEntries(GRADES.map((grade, at) => [grade, at])));
// Top of the S band for gradeBand's span; the level cap itself is ProgressionCap.js C4_MAX_LEVEL.
const S_BAND_MAX_LEVEL = 99;

function gradeForLevel(level) {
    const value = Number(level || 1);
    if (value >= GRADE_LEVELS.s) return 's';
    if (value >= GRADE_LEVELS.a) return 'a';
    if (value >= GRADE_LEVELS.b) return 'b';
    if (value >= GRADE_LEVELS.c) return 'c';
    if (value >= GRADE_LEVELS.d) return 'd';
    return 'none';
}

// The first level that wears a grade ('none' from level 1).
function levelForGrade(grade) {
    return GRADE_LEVELS[grade] || 1;
}

// The level span a character level's grade covers: { rank, min, max } ('none' from level 1, S up to S_BAND_MAX_LEVEL).
function gradeBand(level) {
    const rank = gradeForLevel(level);
    const next = GRADES[GRADES.indexOf(rank) + 1];
    return { rank, min: levelForGrade(rank), max: next ? levelForGrade(next) - 1 : S_BAND_MAX_LEVEL };
}

// Where each grade's gear comes from (user 10-26: grades differ only by
// their input sources, no grade-specific code): the NPC shop sells NG and D
// gear, the luxury shop C (for D and C crystals), craft and drop serve B up.
// Every grade cap of a source reads this table (topGradeOf).
const GRADE_SOURCE = Object.freeze({ none: 'npc', d: 'npc', c: 'luxury', b: 'craft', a: 'craft', s: 'craft' });

// The highest grade a source serves ('npc' -> 'd', 'luxury' -> 'c'), null for none.
function topGradeOf(source) {
    let top = null;
    for (const grade of GRADES) if (GRADE_SOURCE[grade] === source) top = grade;
    return top;
}

// A representative level inside each grade's band (none = a starter), read by MarketDemand
// where a table is read per grade, not per level.
const GRADE_SAMPLE_LEVEL = Object.freeze({ none: 10, d: 30, c: 46, b: 56, a: 68, s: 78 });

module.exports = { GRADES, GRADE_RANK, GRADE_SAMPLE_LEVEL, GRADE_SOURCE, gradeForLevel, gradeBand, levelForGrade, topGradeOf };
