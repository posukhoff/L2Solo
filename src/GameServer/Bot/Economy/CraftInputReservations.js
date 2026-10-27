'use strict';

// Which held items the bot's goals keep from sale. The one answer is the wish
// network's split of held stock across every live goal (WishNetwork.build
// heldClaims, before the priority filter): a goal out of focus keeps its
// inputs too, and a missing recipe/material leaves its collected inputs kept.
// A claim is the need on the goal's chosen path; what is kept of it is the
// bag at the read, never a count stamped at the build.

// Rows a card carries (its 800 B budget, ColdEconomyDecision MAX_BYTES):
// the claims come the focused goal's own first, then dearest (WishNetwork
// claimRows), so the cut keeps the activity's inputs, then the most valuable,
// and the card is never dropped for its rows.
const CARD_ROWS = 8;
const bagCount = (state, id) => Number(state.inventory?.[id]?.amount || 0);

// The claims of items in the bag (the claim rows themselves, amount = the
// need; reservedAmounts caps it by the bag it reads), at most `limit`: the
// decision's held claims (every row: stats.heldClaims, the build's stats
// packet) and the craftReservations of the decision card and the held build
// (CARD_ROWS).
function heldCraftRows(state, claims, limit = CARD_ROWS) {
    const rows = [];
    for (const row of claims || []) {
        if (rows.length >= limit) break;
        if (bagCount(state, row[0]) > 0) rows.push(row);
    }
    return rows;
}
// The reserved units {id: amount} a sale, a warehouse or a craft keeps: the
// claims of the decision the state carries (stats.heldClaims, written with
// its stats packet on either thread and saved with it), each capped by the
// bag now. Nothing is walked or rebuilt here.
function reservedAmounts(state) {
    const reserved = {};
    for (const [id, claim] of state?.stats?.heldClaims || []) {
        const amount = Math.min(bagCount(state, id), claim);
        if (amount > 0) reserved[id] = amount;
    }
    return reserved;
}

module.exports = { heldCraftRows, reservedAmounts };
