'use strict';

// Retain physical inputs of the crafts the bot still wishes for (the selected native
// craft or equipment exchange DAG, and the ones it selected before). A missing
// recipe/material remains an errand; it does not release the ingredients already
// collected toward that profitable equipment funding.

// The selected root's craft inputs before the bag caps them: [id, need]
// rows by id. One walk per build: the compact network keeps them (craftNeeds).
function selectedCraftNeeds(network) {
    const root = network?.activity?.rootKey || network?.focus?.[0];
    const plan = network?.queue?.find(row => row.key === root)?.plan || network?.plans?.get(root);
    const needs = new Map(), visited = new Set();
    function visit(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);
        // A crystallization's source gear is an input as a recipe's material is: bought for
        // the conversion, it is not offered for sale before it is crystallized.
        if (['craft', 'luxury_exchange', 'mammon_unseal', 'crystallize'].includes(node.kind)) for (const row of node.grossRequirements || node.requirements || []) {
            const id = Number(String(row.key).replace(/^item:/, ''));
            if (!id) continue;
            const count = Number(row.amount || 0) * (row.once ? 1 : Math.max(1, Number(node.batches || 1)));
            needs.set(id, (needs.get(id) || 0) + count);
        }
        for (const row of node.requirements || []) visit(row.plan || network.plans?.get(row.key));
    }
    visit(plan);
    return [...needs].sort((a, b) => a[0] - b[0]);
}

// The bot's standing craft hold (stats.craftHold): [[rootKey, [[id, need], ...]], ...], oldest
// first, at most CRAFT_HOLD_ROOTS roots. Written only by the build (its stats packet), read by
// every sale through ItemDisposition.saleCandidates. Inputs bought for a craft the bot still
// wishes for stay out of every sale until a build no longer wishes for that craft: a root
// switch alone (a hunt taken while the shot stock still waits) releases nothing. The build's
// rule (pure): the selected root's craft needs replace that root's row (none: the row goes);
// every other row stays while its root is still one of the build's wishes (its queue) and goes
// once it is not (the stock filled, the product owned, the gear or grade moved the wish away);
// past the cap the oldest row goes, told to dropped(). Equal rows give the previous object back,
// so a build that changed nothing writes nothing new. Our choice after C4 play: a player who
// bought Soul Ore for his shots and goes to level keeps it until he stops making those shots.
const CRAFT_HOLD_ROOTS = 4;
function nextHold(previous, network, dropped = null) {
    const root = network?.activity?.rootKey || network?.focus?.[0] || null;
    const needs = network?.craftNeeds || selectedCraftNeeds(network);
    const wished = new Set((network?.queue || []).map(row => row.key));
    const rows = (Array.isArray(previous) ? previous : []).filter(row => row[0] !== root && wished.has(row[0]));
    if (root && needs.length) rows.push([root, needs.map(([id, need]) => [Number(id), Number(need)])]);
    if (rows.length > CRAFT_HOLD_ROOTS) {
        dropped?.(rows.length - CRAFT_HOLD_ROOTS);
        rows.splice(0, rows.length - CRAFT_HOLD_ROOTS);
    }
    if (!rows.length) return Array.isArray(previous) && previous.length ? [] : previous;
    return JSON.stringify(rows) === JSON.stringify(previous) ? previous : rows;
}
// The hold over the bag a reader walks: {id: amount}, per item the largest need of any held
// root, capped by what that bag holds (a bag with escrow lines in it holds them too).
function holdAmounts(state) {
    const reserved = {};
    for (const [, needs] of Array.isArray(state?.stats?.craftHold) ? state.stats.craftHold : [])
        for (const [id, need] of needs || []) {
            const amount = Math.min(Number(state.inventory?.[id]?.amount || 0), Number(need) || 0);
            if (amount > 0) reserved[id] = Math.max(reserved[id] || 0, amount);
        }
    return reserved;
}

module.exports = { CRAFT_HOLD_ROOTS, selectedCraftNeeds, nextHold, holdAmounts };
