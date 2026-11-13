'use strict';

// The decision layer's registry of situations and levers (economy design):
// each id is a row of the model's specification (SPEC, beside engine.js), and the ids here are
// held equal to that file's situation and lever rows marked built or old
// (tests/test_economy_model_spec.js). Each lever points at the function that
// does it. Nothing calls this module yet.
// Temporary: today it holds only the old layer's shot levers, pointing at the
// code that does them before the decision layer exists; each pointer is
// replaced by the lever's own function when its row is built, and M0 is
// deleted then.

const { shotTown } = require('./trip');
const { huntDesign } = require('../engine');

const LEVERS = Object.freeze({
    // Its own twin holds the shot: shotTown's ownHeld branch names the town it stands in.
    'H.SHOTS.M1': shotTown,
    // The NPC of the town it stands in sells the shot at or under worth: shotTown's npcHere branch.
    'H.SHOTS.M3': shotTown,
    // Else the seller town of every trade town's line at or under worth with a payable fare: shotTown's line read.
    'H.SHOTS.M0': shotTown,
    // No trip: it hunts its spot's bare hour once its shots run out (huntDesign's huntBare).
    'H.SHOTS.S': huntDesign
});

module.exports = { LEVERS };
