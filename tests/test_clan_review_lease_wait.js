// A clan review that meets an action still leased waits for the lease end, the
// event that ends the wait, instead of being raised again on every pass.
const assert = require('assert');
require('../src/Global');

const Database = invoke('Database');
const ReviewEvents = require('../src/GameServer/Clan/ClanReviewEvents');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');

async function main() {
    const original = { execute: Database.execute, enqueueClanAction: Database.enqueueClanAction };
    const queued = [];
    let rows = [], absorbed = 0;
    const updates = [];
    try {
        Database.execute = async ([sql, params]) => /^\s*UPDATE clan_actions/.test(sql)
            ? (updates.push(params), { affectedRows: absorbed }) : (String(sql).includes('clan-review') || String(sql).includes('FROM clan_actions')
            ? rows.filter(row => params.includes(row.clanId)) : []);
        Database.enqueueClanAction = async row => { queued.push(row); return { ok: true }; };
        await ReviewEvents.drain(null, 1000);

        const leaseUntil = Date.now() + 40;
        rows = [{ clanId: 7, actionType: 'goal_plan', status: 'running', leaseUntil },
            { clanId: 7, actionType: 'supplies', status: 'running', leaseUntil }];
        ReviewEvents.changed(7, 'recruitment_input');
        await ClanActionService.scheduleReviews();
        assert.strictEqual(queued.length, 0, 'a leased action keeps its captured input');
        assert.strictEqual(ClanActionService.hasEvents(), false, 'the parked review does not keep the job spinning');
        await ClanActionService.scheduleReviews();
        assert.strictEqual(queued.length, 0, 'still before the lease end');

        await new Promise(resolve => setTimeout(resolve, 60));
        rows = [];
        await ClanActionService.scheduleReviews();
        assert.deepStrictEqual(queued.map(row => [row.clanId, row.actionType, row.payload.reasons]),
            [[7, 'goal_plan', ['recruitment_input']], [7, 'supplies', ['recruitment_input']]],
            'the lease end raises the review once, with the cause it held back');

        // A lease already over at the read: raised again for the next pass, as before.
        queued.length = 0;
        rows = [{ clanId: 8, actionType: 'goal_plan', status: 'running', leaseUntil: Date.now() - 1 }];
        ReviewEvents.changed(8, 'clan_input');
        await ClanActionService.scheduleReviews();
        assert.strictEqual(ClanActionService.hasEvents(), true, 'an expired lease is retried at the next pass');
        await ReviewEvents.drain(null, 1000);

        // A pending action takes a later cause into its own reasons; one that
        // left 'pending' since the read takes none and the cause is raised again.
        queued.length = 0;
        rows = [{ id: 31, clanId: 9, actionType: 'goal_plan', status: 'pending', payloadJson: '{"reasons":["clan_input"]}' },
            { id: 32, clanId: 9, actionType: 'supplies', status: 'pending', payloadJson: '{"reasons":["recruitment_input"]}' }];
        absorbed = 1;
        ReviewEvents.changed(9, 'recruitment_input');
        await ClanActionService.scheduleReviews();
        assert.strictEqual(queued.length, 0);
        assert.deepStrictEqual(updates.map(params => [params[1], JSON.parse(params[0]).reasons]), [[31, ['clan_input', 'recruitment_input']]],
            'the pending plan absorbs the new cause; the one that holds it already is not written');
        assert.strictEqual(ClanActionService.hasEvents(), false);
        absorbed = 0; updates.length = 0;
        ReviewEvents.changed(9, 'recruitment_input');
        await ClanActionService.scheduleReviews();
        assert.strictEqual(updates.length, 1);
        assert.strictEqual(ClanActionService.hasEvents(), true, 'a row that moved since the read loses no cause');
        await ReviewEvents.drain(null, 1000);
    } finally {
        Object.assign(Database, original);
        ClanActionService.stopEvents();
    }
    console.log('test_clan_review_lease_wait: park until the lease end, release once, expired lease retried');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
