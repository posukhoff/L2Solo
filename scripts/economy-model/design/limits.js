'use strict';

// The design's limits for a solo bot in an NPC world: every threshold and
// bound the design reads or is judged by, with its source, its reader and how
// a hit shows. Frozen rows { value, source, readBy, hit }.

const row = fields => Object.freeze(fields);
const LIMITS = Object.freeze({
    // A consumable's purchase target: this many hunting hours of its use.
    OUTING_HOURS: row({ value: 2, source: 'ours: an outing of two hunting hours',
        readBy: 'needs.consumable (target), supply formula (loss horizon)', hit: 'a buy stops at the target: trips per outing in the run report' }),
    // The road's share of a bot's wall hours at levels 1-19 the design may reach.
    ROAD_SHARE_LIMIT: row({ value: 0.15, source: 'ours: the walk to and back over a 2 h outing from the starter towns',
        readBy: 'run report', hit: 'road hours / wall hours at levels 1-19 printed beside it' }),
    // Trips that bought none of the need they went for, as a share of consumable trips.
    EMPTY_TRIP_SHARE: row({ value: 0.05, source: 'ours: the design\'s acceptance bound',
        readBy: 'run report', hit: 'empty trips / consumable trips at levels 1-19 printed beside it' }),
    // The weight of a death's price in an hour's value.
    RISK_WEIGHT: row({ value: 1, source: 'ours; C4 not checked',
        readBy: 'value.hourValue', hit: 'none: a weight, not a bound' }),
    // A species is hunted (the hunt table's reader) when a kill costs at most this many deaths.
    KILL_DEATH_LIMIT: row({ value: 0.05, source: 'ours: a C4 player leaves a mob that kills him more than once in twenty kills',
        readBy: 'hunt table reader (admission); hunt-table.js (prints, check spots)', hit: 'cells over it counted by the hunt table build' }),
    // The hunt table's rest rule: the bot fights when its HP and MP above the potion line cover this many expected fights
    // with the mob (survival ratio), else it rests (or at a whole bar).
    FIGHT_COVER: row({ value: 1, source: 'ours: a C4 player sits rather than drinks, so the fight must end above the potion line',
        readBy: 'hunt-lift.js (the readiness lift)', hit: 'rest share per body printed by the hunt table build' }),
    // Today's bots' road share of wall hours, printed beside the design's for comparison only.
    CURRENT_BOTS_ROAD_SHARE: row({ value: 0.41, source: 'a measured run of today\'s bots: target = threshold puts 41 % of the window on the road',
        readBy: 'run report (printed only)', hit: 'none: printed only' })
});

module.exports = LIMITS;
