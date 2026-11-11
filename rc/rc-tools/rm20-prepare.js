// RM-20 world prep (outside the repo): run with cwd = a game checkout (rel1a), args: <save dir>.
// Works on a scratch copy of the save's two files, runs the real character creation and clan join code, then
// writes the hall and war rows and puts the files back (the caller refreshes save.json checksums).
const fs = require('fs'), nodePath = require('path'), os = require('os');
const saveDir = nodePath.resolve(process.argv[2]);
const work = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rm20-'));
fs.copyFileSync(nodePath.join(saveDir, 'database.sqlite'), nodePath.join(work, 'world.sqlite'));
fs.copyFileSync(nodePath.join(saveDir, 'history.sqlite'), nodePath.join(work, 'world.history.sqlite'));
require(nodePath.resolve('src/Global'));
options.default.Database.path = nodePath.join(work, 'world.sqlite');
options.default.General.progressionPreset = 'x50';
const Database = invoke('Database'), DataCache = invoke('GameServer/DataCache'), Shared = invoke('GameServer/Network/Shared');
const createNewChar = invoke('GameServer/Network/Request/CreateNewChar');
const ACCOUNT = 'perf_player1', NAME = 'PerfPlayer1', CLAN = 6000000, HATERS = 6000001, HALL = 39;
process.on('unhandledRejection', e => { console.error('UNHANDLED', e); process.exit(2); });
(async () => {
    DataCache.init();
    Database.init();
    await new Promise(r => setTimeout(r, 1500));
    if (!(await Database.fetchUserPassword(ACCOUNT))[0]) await Database.createAccount(ACCOUNT, 'perf');
    if (!(await Database.fetchCharacters(ACCOUNT)).length) {
        const parts = [Buffer.from([0x0b]), Buffer.from(NAME, 'ucs2'), Buffer.alloc(2)];
        for (let i = 0; i < 12; i++) parts.push(Buffer.alloc(4));
        Shared.enterCharacterHall = () => {};
        const done = new Promise(res => createNewChar({ accountId: ACCOUNT, dataSendToMe: p => res(p[0]) }, Buffer.concat(parts)));
        console.log('create packet', await done);
        await new Promise(r => setTimeout(r, 1000));
    }
    const [row] = await Database.fetchCharacters(ACCOUNT);
    console.log('character', row.id, row.name, row.level, row.classId);
    const joined = await Database.updateCharacterClan(row.id, CLAN, 0, 0, 0);
    console.log('clan join', JSON.stringify(joined).slice(0, 200));
    console.log('sync', JSON.stringify(await Database.syncPlayerManagedClan(CLAN)));
    const T = Date.now(), DAY = 86400000;
    await Database.close?.();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(nodePath.join(work, 'world.sqlite'));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const leader = id => db.prepare('SELECT leaderId FROM clans WHERE id=?').get(id).leaderId;
    db.exec('BEGIN');
    db.prepare("UPDATE clan_halls SET ownerId=?, rentDueAt=?, serviceDueAt=?, auctionEndsAt=0, functionsJson=? WHERE id=?")
        .run(CLAN, T + 7 * DAY, T + 3 * DAY, JSON.stringify({ support: 8 }), HALL);
    for (const [from, to] of [[CLAN, HATERS], [HATERS, CLAN]]) {
        const ev = db.prepare("INSERT INTO clan_war_events(fromClanId,toClanId,actorId,action,reason,createdAt) VALUES (?,?,?,'declare','rm20',?)")
            .run(from, to, leader(from), T);
        db.prepare('INSERT INTO clan_war_declarations(fromClanId,toClanId,active,revision,declaredAt,updatedAt) VALUES (?,?,1,?,?,?)')
            .run(from, to, Number(ev.lastInsertRowid), T, T);
    }
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    for (const f of ['world.sqlite', 'world.history.sqlite']) for (const s of ['-wal', '-shm'])
        if (fs.existsSync(nodePath.join(work, f + s))) console.log('leftover', f + s, fs.statSync(nodePath.join(work, f + s)).size);
    fs.copyFileSync(nodePath.join(work, 'world.sqlite'), nodePath.join(saveDir, 'database.sqlite'));
    fs.copyFileSync(nodePath.join(work, 'world.history.sqlite'), nodePath.join(saveDir, 'history.sqlite'));
    console.log('done', work);
    process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
