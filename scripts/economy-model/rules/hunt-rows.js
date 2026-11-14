'use strict';
// The model's hour at a spot from its hunt table (hunt-table.js): pure, plain
// data in (the table's cells and statics), the game's walk rule passed in.

// The combination of species on time for an admitted set of a spot: species
// drawn by their density share p, the time per kill the share-weighted fight,
// rest and other time plus the walk at the set's density over its pull
// (walkMs: BackgroundResolver.soloWalkMs, the game's rule), kills an hour at
// most the set's production. cells: selfId -> [form cells]; form: its index;
// fields: the table's cell fields; admitted: selfIds. Null for an empty set.
function combine({ spot, cells, body, form, fields, admitted, walkMs }) {
    const at = Object.fromEntries(fields.map((field, index) => [field, index]));
    const total = Object.values(spot.species).reduce((sum, held) => sum + held.count, 0);
    let count = 0, production = 0, capped = true;
    for (const selfId of admitted) {
        count += spot.species[selfId].count;
        if (spot.species[selfId].production === null) capped = false;
        else production += spot.species[selfId].production;
    }
    if (!count) return null;
    let perKill = 0, deaths = 0, pull = 0;
    for (const selfId of admitted) {
        const share = spot.species[selfId].count / count, cell = cells[selfId][form];
        perKill += share * (cell[at.fight] + cell[at.rest] + cell[at.other]);
        deaths += share * cell[at.deaths];
        pull += share * cell[at.pull];
    }
    perKill += walkMs(spot.density * count / total, body.runSpd, spot.area, body.reach) / 1000 / pull;
    const kills = 3600 / perKill;
    return { kills: capped ? Math.min(kills, production) : kills, deaths };
}

module.exports = { combine };
