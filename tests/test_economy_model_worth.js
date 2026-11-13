'use strict';
// The economy design's worth of a gear piece on inline kit hours, and the
// buyer's cap it sets against the seller's floor.
const assert = require('node:assert/strict');
const Worth = require('../scripts/economy-model/rules/worth');
const Bounds = require('../scripts/economy-model/rules/bounds');
const { priceStep } = require('../scripts/economy-model/rules/priceStep');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} vs ${expected}`);

// The rows a buyer's worth reads off a kit's swaps: the worn kit's hour and
// per piece the hour of the kit with it; a kit with no hour stated gives no
// row, and nothing is stated over a worn kit with no hour.
{
    const read = { hour: 1000, swaps: [{ hour: 1300 }, { hour: 1100 }, { hour: null }] };
    const rows = Worth.swapRows(read);
    assert.deepEqual(rows.worn, { hour: 1000 });
    assert.deepEqual(rows.rows.slice(0, 2), [{ hour: 1300 }, { hour: 1100 }]);
    assert.equal(rows.rows[2], null, 'a kit with no hour stated: no row');
    assert.deepEqual(Worth.swapRows({ ...read, hour: null }), { worn: null, rows: [null, null, null] }, 'a worn kit with no hour: nothing stated');
}

// A cap under the floor is reported as it is: the buyer's line never climbs
// over its cap, the seller's never drops under its floor, and no deal meets.
{
    const cap = Bounds.cap({ worth: 100, npcSell: 70000 }), floor = Bounds.floor({ npcBuy: 30000, crystallizerBids: [33000] });
    assert.deepEqual(cap, { cap: 100, by: 'worth' }, 'the worth caps the buyer');
    assert.ok(cap.cap < floor, `cap ${cap.cap} under floor ${floor}`);
    const persona = { looksToFloor: 3, buyerStart: 0.8 };
    let buy = priceStep({ side: 'buy' }, { look: 0, cap: cap.cap, capBy: cap.by, first: 60000, persona });
    let sell = priceStep({ side: 'sell' }, { look: 0, floor, first: 60000, persona });
    for (let look = 1; look <= 4; look++) {
        buy = priceStep(buy, { look, cap: cap.cap, capBy: cap.by, persona });
        sell = priceStep(sell, { look, floor, persona });
        assert.ok(buy.price <= cap.cap && sell.price >= floor && buy.price < sell.price, `look ${look}: no deal under the floor`);
    }
    assert.equal(buy.close, 'parked', 'the want is parked after two looks at its worth');
}

// The shots a main fires (firing): a kind it knows no price of (null or
// undefined) is no option, a price of 0 a free shot. The kit's hour: 1000
// firing none; shot 1 at 1600 gross over 100 shots, shot 2 at 2000 over 100.
{
    const hour = { none: 1000, shots: [{ id: 1, kind: 'a', gross: 1600, units: 100 }, { id: 2, kind: 'b', gross: 2000, units: 100 }] };
    const unknown = Worth.firing(hour, id => (id === 1 ? 2 : null));
    assert.deepEqual([unknown.id, unknown.units, unknown.net, unknown.worth], [1, 100, 1400, 6], 'shot 2 has no price: shot 1 (1600 - 100 x 2) over none (1000), worth (1600 - 1000) / 100');
    assert.equal(Worth.firing(hour, id => (id === 1 ? 2 : undefined)).id, 1, 'an undefined price is no price either');
    assert.deepEqual(Worth.firing(hour, () => null), { id: 0, units: 0, net: 1000, worth: 0 }, 'no price for any shot: none');
    const free = Worth.firing(hour, id => (id === 1 ? 2 : 0));
    assert.deepEqual([free.id, free.net, free.worth], [2, 2000, 6], 'a price of 0 is a free shot: shot 2 nets 2000, worth (2000 - 1400) / 100');
    assert.equal(Worth.firing({ none: null, shots: hour.shots }, () => null), null, 'no hour firing none and no priced shot: no answer');
}

// A bow's options net their arrows (kit-hours: { id, units } an hour; null:
// the attacks are not stated, never zero arrows): none 1000 with 100 arrows
// against a shot of 1500 gross over 1000 shots with 700 arrows, the shot at
// 0.3 and the arrow at 1 an arrow. Gross the shot nets 1200 over none's 1000;
// net of arrows it nets 500 and none 900: firing none.
{
    const bow = { none: 1000, noneArrows: { id: 9, units: 100 }, shots: [{ id: 1, kind: 'a', gross: 1500, units: 1000, arrows: { id: 9, units: 700 } }] };
    const price = arrow => id => (id === 1 ? 0.3 : id === 9 ? arrow : null);
    const dear = Worth.firing(bow, price(1));
    assert.deepEqual([dear.id, dear.net], [0, 900], 'arrows at 1: none nets 900, the shot 500');
    const cheap = Worth.firing(bow, price(0.1));
    assert.deepEqual([cheap.id, cheap.units], [1, 1000], 'arrows at 0.1: the shot nets 1130 over none 990');
    near(cheap.net, 1500 - 300 - 70, 'net of shots and arrows');
    near(cheap.worth, (1430 - 990) / 1000, 'worth: the shot margin net of its arrows over the rival');
    assert.equal(Worth.firing(bow, id => (id === 1 ? 0.3 : null)), null, 'an arrow it cannot price: no option, no answer');
    const unstated = Worth.firing({ ...bow, shots: [{ ...bow.shots[0], arrows: null }] }, price(0.1));
    assert.deepEqual([unstated.id, unstated.net], [0, 990], 'arrows null on the shot: that option is none');
    assert.equal(Worth.firing({ ...bow, noneArrows: null, shots: [{ ...bow.shots[0], arrows: null }] }, price(0.1)), null, 'arrows null on every option: no answer');
}

// The worn kit's hunt over the reference kit's per form, by kind of shot: a
// lower-grade weapon fires another id of the same kind; a form either hour
// does not state the shares of has no factor.
{
    const share = (killShare, shotShare) => ({ killShare, shotShare });
    const worn = { none: 1, noneShare: share(0.4, 0.3), shots: [{ id: 2509, kind: 'spiritshot', ...share(0.5, 0.6) }, { id: 3947, kind: 'blessedSpiritshot', ...share(0.9, 0.9) }] };
    const reference = { none: 1, noneShare: share(0.8, 0.6), shots: [{ id: 2510, kind: 'spiritshot', ...share(1, 1.2) }, { id: 3948, kind: 'blessedSpiritshot', ...share(null, null) }] };
    assert.deepEqual(Worth.huntFactors(worn, reference), { bare: { kills: 0.5, shots: 0.5 }, shots: { kills: 0.5, shots: 0.5 }, blessed: null },
        'each form the worn share over the reference\'s, matched by kind; the reference states no blessed shares: none');
    assert.deepEqual(Worth.huntFactors(null, reference), { bare: null, shots: null, blessed: null }, 'no worn hour: no factor');
    assert.equal(Worth.huntFactors(worn, { ...reference, noneShare: share(0, 0) }).bare, null, 'a reference share of 0: no factor');
}

console.log('test_economy_model_worth: ok');
