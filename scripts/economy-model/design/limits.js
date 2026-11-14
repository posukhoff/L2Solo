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
    // Today's bots' road share of wall hours, printed beside the design's for comparison only.
    CURRENT_BOTS_ROAD_SHARE: row({ value: 0.41, source: 'a measured run of today\'s bots: target = threshold puts 41 % of the window on the road',
        readBy: 'run report (printed only)', hit: 'none: printed only' })
});

module.exports = LIMITS;
