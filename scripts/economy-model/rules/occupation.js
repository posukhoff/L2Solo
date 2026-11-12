'use strict';

// occupation (economy design, character plane; version 1): the spot a main
// hunts, by income per hour at known prices, open WTB lines included (an
// item someone bids for is worth the bid). Hunters re-choose rarely: only at
// grade_changed or when its spot leaves its line's levels (no spot hour at
// its level), never on price movement. Pure: the candidate spots' hours,
// the prices it knows and the bids it sees arrive as plain data.

// recipe_wanted: its account's workshop opened or closed a want for a recipe
// (raised only with the reading that counts wanted scrolls).
const SITUATIONS = Object.freeze(new Set(['grade_changed', 'spot_left', 'recipe_wanted']));

// main: { spot } (the spot it holds). view: { situation, rows: [{ spotId,
// adena (per hunting hour), items: [[id, per hunting hour]] }] (its line's
// top spots at its level), others: [{ ...row, scrolls: [id] }] (spots it
// can hunt at its level outside its top that yield the shot recipes'
// scrolls named: a candidate only while its workshop wants one of them or a
// bid it sees asks for one), prices: { id: known price, else the NPC's buy
// price }, bids: { id: the best open buy line or WTB in its town }, wants:
// { scroll id: the cap its own workshop puts on a recipe it decided to add }
// (the account knows its own want without a book; which recipe is the
// workshop's question), roll in [0, 1) (a seeded share that breaks a tie) }.
// Returns the spotId it hunts.
function occupation(main, view) {
    if (!SITUATIONS.has(view.situation) || !view.rows.length) return main.spot;
    const wants = view.wants || {};
    const income = row => row.adena + row.items.reduce((sum, [id, perHour]) => sum + perHour * Math.max(view.prices[id] || 0, view.bids[id] || 0, wants[id] || 0), 0);
    const sought = row => (row.scrolls || []).some(id => wants[id] > 0 || view.bids[id] > 0);
    // A row without an income (a price nobody can state) is no candidate.
    const ranked = [...view.rows, ...(view.others || []).filter(sought)].map(row => ({ spotId: row.spotId, income: income(row) })).filter(row => Number.isFinite(row.income));
    if (!ranked.length) return main.spot;
    const best = Math.max(...ranked.map(row => row.income));
    const tied = ranked.filter(row => row.income >= best - 1e-9 * Math.max(1, Math.abs(best)));
    return tied[Math.min(tied.length - 1, Math.floor(view.roll * tied.length))].spotId;
}

module.exports = { occupation };
