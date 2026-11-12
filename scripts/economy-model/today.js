'use strict';

// Today mode of the economy model: the mechanisms of today's world the model
// imitates so that it can reproduce a real run's ledger, and the two numbers
// per stage band it fits on one. Every constant is a named field of TODAY or
// of the fitted rates, printed with each run.
//
// Today's-world mechanisms (each goes when the design replaces it):
//   fixed buyers       the 14 configured city buy stores pay every bot the
//                      line's price, without a count limit;
//   static shot lines  the configured city sell stores sell a bot shots (and
//                      only shots) at the line's price, without a count limit;
//   kit buys at the scaled NPC price: a kit piece comes from a town NPC at
//                      the rate-scaled, taxed price of the snapshot's preset;
//   fitted arrivals    a main comes to town at its band's fitted visits per
//                      bot-hour (nextArrival), today's trip triggers folded in.
// Crafting is not imitated: today's crafts are a few per cent of the shots
// fired and no flow of the ledger depends on them.
const Engine = require('./engine');

// MerchantStoreConfigs store types.
const SELL = 1, BUY = 3;
const TODAY = Object.freeze({
    // Kit pieces at the snapshot preset's NPC prices (NpcShopBuyLists, scaled by NpcShopPriceScale).
    npcPrices: 'preset',
    // A fixed buyer pays at most this share of the item's cheapest repeatable
    // supply (StaticMerchantPricing BUYBACK_RATIO).
    buybackRatio: 0.9,
    // Shot restock: below this many hunting hours of use, up to the use of the hunting hours since the last visit (the engine's rule).
    shotLineHours: Engine.SHOT_LINE_HOURS,
    // When a main comes to town: periodic at the band's visits per bot-hour, fitted on a real run (nextArrival).
    arrivals: 'fitted periodic'
});

// Today's arrivals (the engine's nextArrival): every 1 / visitsPerBotHour
// hours, the first at a seeded share of that interval so mains do not all
// arrive at once; none at a rate of 0. A level-up changes no trip: the
// arrival already pending stays.
function nextArrival(main, { event, now, pending, rate, roll }) {
    const visits = rate?.visitsPerBotHour;
    if (!(visits > 0)) return null;
    if (event === 'level_up') return pending;
    return now + (event === 'start' ? roll : 1) / visits;
}

// A configured line's price (StaticMerchantPricing.configuredPrice): the
// item's reference price times the line's rate, scaled by the adena rate and
// floored, at least 1.
function configuredPrice(line, ref, adenaRate) {
    if (line.price !== undefined) return Number(line.price);
    const base = ref > 0 ? ref * (line.priceRate ?? 1) : 1;
    return Math.max(1, Math.floor(base * adenaRate));
}

// What a fixed buyer pays a bot (StaticMerchantPricing.botPriceFor): its
// configured price, at most the buyback share of the cheapest repeatable
// supply (a fixed sell line or a town NPC), so no bot buys and sells back at a profit.
function fixedBuyerPrice(line, ref, adenaRate, cheapestSupply, buybackRatio = TODAY.buybackRatio) {
    return Math.min(configuredPrice(line, ref, adenaRate), Math.floor(cheapestSupply * buybackRatio));
}

const isShot = item => item?.kind === 'Other.Shot';

// The fixed stores as the engine's market: buy { town: { item: price } } from
// the buy stores, sell { town: { shot: price } } from the sell stores.
function marketOf(snapshot, config = TODAY) {
    const adenaRate = Math.max(0.01, Number(snapshot.header.rates?.adena || 1));
    const refOf = id => Number(snapshot.items[id]?.ref || 0);
    const supply = new Map();
    const lower = (id, price) => supply.set(id, Math.min(supply.get(id) ?? Infinity, price));
    for (const store of snapshot.stores) {
        if (store.storeType !== SELL) continue;
        for (const line of store.items) if (Number(line.count ?? 1) > 0) lower(Number(line.selfId), configuredPrice(line, refOf(line.selfId), adenaRate));
    }
    for (const [id, rows] of Object.entries(snapshot.npcOffers[config.npcPrices] || {})) for (const row of rows) lower(Number(id), row.price);
    const buy = {}, sell = {};
    for (const store of snapshot.stores) {
        if (!store.town) continue;
        for (const line of store.items) {
            const id = Number(line.selfId);
            if (!(Number(line.count ?? 1) > 0)) continue;
            if (store.storeType === BUY) {
                const price = fixedBuyerPrice(line, refOf(id), adenaRate, supply.get(id) ?? Infinity, config.buybackRatio);
                const town = buy[store.town] ||= {};
                town[id] = Math.max(town[id] || 0, price);
            } else if (store.storeType === SELL && isShot(snapshot.items[id])) {
                const town = sell[store.town] ||= {}, price = configuredPrice(line, refOf(id), adenaRate);
                town[id] = Math.min(town[id] ?? Infinity, price);
            }
        }
    }
    return { buy, sell };
}

// The hunting share and visits per bot-hour of each stage band, fitted on a
// real run's ledger: the share is the band's realized exp per bot-hour over
// the cohort's mean exp per hunting hour at its start levels (each main at
// the spot row the engine hunts: its own spot's, else its line's best);
// visits are the run's town arrivals per hunting main, one value for every
// band (the ledger counts visits for the world only). A band the run did not
// populate takes its nearest populated band's numbers. Printed beside the
// fit, never fitted to: the share at the best spots, the end snapshot's
// hunting and grouped fractions, and the members at their own spot.
function fit(baseline, accounts, view, bands) {
    const mains = accounts.map((account, index) => Engine.mainOf(account, index, view, bands)).filter(main => !main.station);
    const visitsPerBotHour = Number(baseline.visits?.perHour || 0) / Math.max(1, mains.length);
    const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const basis = {};
    for (const [band] of bands) {
        const real = baseline.progress?.stageBands?.[band];
        const members = mains.filter(main => main.band === band);
        const meanExp = mean(members.map(main => Engine.spotRowOf(view, main)?.exp || 0));
        const bestExp = mean(members.map(main => view.hours[main.line]?.[main.level]?.best?.exp || 0));
        if (!real || !members.length || !(meanExp > 0)) continue;
        const activity = real.activityAtEnd || {}, of = count => (real.bots ? (count || 0) / real.bots : null);
        basis[band] = { realExp: real.expPerBotHour, meanExp, huntShare: real.expPerBotHour / meanExp, bestExp, bestShare: real.expPerBotHour / bestExp,
            activityHunting: of(activity.hunting), activityGrouped: of(activity.grouped), activityResting: of(activity.resting),
            atOwnSpot: members.filter(main => main.spot).length, bots: members.length };
    }
    const fitted = Object.keys(basis);
    if (!fitted.length) throw new Error('the baseline populates no stage band the cohort has');
    const rates = {};
    bands.forEach(([band], at) => {
        const nearest = fitted.reduce((best, name) => {
            const distance = Math.abs(bands.findIndex(([b]) => b === name) - at);
            return best === null || distance < best.distance ? { name, distance } : best;
        }, null).name;
        rates[band] = { huntShare: basis[nearest].huntShare, visitsPerBotHour, fittedOn: nearest };
    });
    rates.default = rates[fitted[0]];
    return { rates, basis, visitsPerBotHour };
}

module.exports = { TODAY, configuredPrice, fixedBuyerPrice, marketOf, fit, nextArrival, SELL, BUY };
