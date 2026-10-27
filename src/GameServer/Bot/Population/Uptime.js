// The start of the server process, the same in its worker threads (the
// boot's downtime measures end at it: BotLifeState.bootPause, MarketCounters.load).
const SERVER_STARTED_AT = Date.now() - process.uptime() * 1000;

// The running time between two moments of the market's clock (its rows'
// deal times): the boot replay moves the journal's deals by the downtime
// (MarketCounters.load), so a span is plain time, the previous run's included.
function between(from, to) {
    const start = Number(from);
    const end = Number(to);
    return end > start ? end - start : 0;
}

module.exports = { SERVER_STARTED_AT, between };
