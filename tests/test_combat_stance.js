// A mob miss is an exchange too (C4): it renews the victim's combat stance,
// the stop comes 15 s after the last miss. The rest of the stance rules is
// covered by test_player_combat_stance.js.
const assert = require('assert');

require('../src/Global');

// Edge stub: the clock. Only timers due by the fake time run.
let now = 0;
let nextHandle = 1;
const timers = new Map();
global.setTimeout = (fn, ms, ...args) => {
    const delay = Math.max(0, Number(ms) || 0);
    const handle = {
        id: nextHandle++,
        unref() { return this; },
        ref() { return this; },
        refresh() { timers.set(this.id, { at: now + delay, fn, args }); return this; }
    };
    timers.set(handle.id, { at: now + delay, fn, args });
    return handle;
};
global.clearTimeout = (handle) => { if (handle) timers.delete(handle.id); };
function advanceTo(time) {
    for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
            if (timer.at <= time && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if (!due) break;
        timers.delete(due.id);
        now = due.timer.at;
        due.timer.fn(...due.timer.args);
    }
    now = time;
}

const State = invoke('GameServer/Model/State');
const Attack = invoke('GameServer/Actor/Attack');
const Npc = invoke('GameServer/Npc/Npc');
const ServerResponse = invoke('GameServer/Network/Response');
const Generics = invoke(path.actor);

const PLAYER_ID = 2000001;
const STOP = ServerResponse.autoAttackStop(PLAYER_ID);

function player() {
    const session = {
        persistenceMode: 'ephemeral',
        packets: [],
        messagesAt: [],
        dataSendToMe() { this.messagesAt.push(now); },
        dataSendToMeAndOthers(data) {
            this.packets.push(data);
        }
    };
    const actor = {
        state: new State(),
        session,
        hp: 1000,
        fetchId: () => PLAYER_ID,
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        fetchMaxHp: () => 1000,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8,
        fetchCollectiveAtkSpd: () => 333,
        fetchCollectiveEvasion: () => 0,
        fetchPvpFlag: () => 0, fetchKarma: () => 0, setPvpFlag() {},
        isDead() { return this.state.fetchDead(); },
        statusUpdateVitals() {},
        backpack: { fetchTotalWeaponKind: () => 'Weapon.DualFist' },
        attack: new Attack(),
        automation: { replenishVitals() {}, aborted: 0, abortAll() { this.aborted++; }, scheduleAction() {} }
    };
    session.actor = actor;
    return actor;
}

const mob = { fetchKind: () => 'Monster', fetchId: () => 1000001 };


// Edge stub: the roll. Near 1 every swing misses (no damage path).
const originalRandom = Math.random;
function withMisses(run) {
    Math.random = () => 0.999;
    try { run(); } finally { Math.random = originalRandom; }
}

function stops(actor) {
    return actor.session.packets.filter((data) => Buffer.compare(data, STOP) === 0).length;
}

function hit(actor, time) {
    advanceTo(time);
    Generics.receivedHit(actor.session, actor, 10, { source: mob });
}


{
    // A mob miss is an exchange too: hit at 0 s, miss at 10 s, stop at 25 s.
    now = 0;
    const victim = player();
    const attacker = new Npc(900000, {
        selfId: 900000, kind: 'Monster', name: 'Stance Test Mob', title: '', level: 1, hostile: true,
        str: 1, dex: 30, con: 1, int: 1, wit: 1, men: 1, pAtk: 100, pAtkRnd: 0, pDef: 100, mAtk: 100,
        mDef: 100, accur: 4.75, atkSpd: 253, castSpd: 333, atkRadius: 40, walk: 60, run: 120,
        maxHp: 100, maxMp: 100, revHp: 1, revMp: 1, corpseTime: 7, radius: 10, size: 20, weapon: 0,
        shield: 0, reuseTime: 0, exp: 0, sp: 0, locX: 20, locY: 0, locZ: 0, head: 0
    });
    hit(victim, 0);
    advanceTo(10000);
    withMisses(() => attacker.meleeHit(victim.session, attacker, victim));
    advanceTo(10000 + 5000); // the miss lands at its draw point, well before 15 s
    assert.strictEqual(stops(victim), 0, 'no stop 15 s after the hit when a mob missed since');
    // The miss lands at the swing's draw point, where the player gets its
    // "missed" message.
    const missAt = victim.session.messagesAt[victim.session.messagesAt.length - 1];
    assert(missAt > 10000 && missAt < 15000, 'the mob swing missed the player');
    advanceTo(missAt + 14999);
    assert.strictEqual(stops(victim), 0);
    advanceTo(missAt + 15000);
    assert.strictEqual(stops(victim), 1, 'the stance ends 15 s after the mob miss');
}

console.log('test_combat_stance: ok');
