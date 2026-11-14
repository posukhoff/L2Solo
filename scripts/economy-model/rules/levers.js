'use strict';

// The decision layer's registry of situations and levers (economy design):
// each id is a row of the model's specification (SPEC, beside engine.js), and the ids here are
// held equal to that file's situation and lever rows marked built
// (tests/test_economy_model_spec.js). Each lever points at the function that
// does it. Empty until the first row is built.

const SITUATIONS = Object.freeze({});

const LEVERS = Object.freeze({});

module.exports = { SITUATIONS, LEVERS };
