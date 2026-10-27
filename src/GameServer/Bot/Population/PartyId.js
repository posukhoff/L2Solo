'use strict';
// Which party a bot is in: the one owner (game-decisions 10-26). Returns the
// party id as a string (`bgp_<ts36>_<leaderId>`, `bgp_hot_<uuid>`), '' when the
// bot has none.
// `state.party.partyId` is the current value: the saved row's partyId, and
// every join or release writes it. A flat `state.partyId` is a read-time copy
// (clan readers' candidate states, raw clan member rows, the hot actor's state
// with its hotBackgroundPartyId); a release clears only `party.partyId`, so the
// flat copy is read only when the state carries no `party.partyId`.
// No imports: every thread and module loads it at the top with no cycle.
function partyIdOf(state) {
    return String(state?.party?.partyId || state?.partyId || '');
}

module.exports = { partyIdOf };
