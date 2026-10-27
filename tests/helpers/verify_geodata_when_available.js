'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function verifyGeodataWhenAvailable(engine, regions, label, verify, { preload = true } = {}) {
    if (process.env.L2NODE_SKIP_RAW_GEODATA_TESTS === '1') {
        console.log(`SKIP: ${label} raw geodata checks are in npm run test:geodata`);
        return false;
    }
    const missing = regions.filter(([regionX, regionY]) => preload
        ? !engine.loadRegion(regionX, regionY)
        : !fs.existsSync(path.join(engine.getGeodataDir(), `${regionX}_${regionY}.l2j`)));
    if (missing.length > 0) {
        const names = missing.map((region) => region.join('_')).join(', ');
        // The --geodata run (scripts/run-tests.js sets '0') must read every region it names: a pack without one is red.
        if (process.env.L2NODE_SKIP_RAW_GEODATA_TESTS === '0') throw new Error(`${label}: geodata region(s) ${names} missing from the installed pack`);
        console.log(`SKIP: ${label} raw geodata region(s) ${names} are not available`);
        return false;
    }

    verify();
    return true;
};
