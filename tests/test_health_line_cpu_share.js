const assert = require('assert');

require('../src/Global');

const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Status = invoke('GameServer/Bot/Population/PopulationStatus');
const threadCpuMeter = require('../src/GameServer/ThreadCpuMeter');

// The meter counts this thread's CPU since its previous read: a busy loop adds about its wall time, a wait adds
// close to none.
const meter = threadCpuMeter();
const spinUntil = performance.now() + 60;
while (performance.now() < spinUntil);
const spun = meter();
assert.ok(spun >= 30 && spun < 1000, `a 60 ms spin reads ${spun} CPU ms`);
const waitUntil = Date.now() + 60;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, waitUntil - Date.now()));
const waited = meter();
assert.ok(waited < 20, `a 60 ms wait reads ${waited} CPU ms`);

// The worker's CPU share sums over the same beats as its busy share: busy 0.50 with CPU 0.30 means 0.20 of the
// window the thread was on the clock without a core.
const coordinator = new ColdSimulationCoordinator();
const shared = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const originalTake = shared.takeBusyWindow;
shared.takeBusyWindow = () => coordinator.takeBusyWindow();
try {
    coordinator.noteBusy({ eluActiveMs: 600, eluIdleMs: 400, cpuMs: 300, eventLoopUtilization: 0.6, eventLoopLagMaxMs: 12 });
    coordinator.noteBusy({ eluActiveMs: 400, eluIdleMs: 600, cpuMs: 300, eventLoopUtilization: 0.4, eventLoopLagMaxMs: 5 });
    assert.equal(Status.workerBusyText(), 'workerElu=0.50 workerCpu=0.30 workerEluMax=0.60 workerLag=12ms');
    // A beat from a worker without cpuMs (an older build mid-restart) adds no CPU, not NaN.
    coordinator.noteBusy({ eluActiveMs: 500, eluIdleMs: 500, eventLoopUtilization: 0.5 });
    assert.equal(Status.workerBusyText(), 'workerElu=0.50 workerCpu=0.00 workerEluMax=0.50 workerLag=0ms');
    // No beat: no data, not an idle worker.
    assert.equal(Status.workerBusyText(), 'workerElu=- workerCpu=- workerEluMax=- workerLag=-');

} finally {
    shared.takeBusyWindow = originalTake;
}

// The goal line carries main's CPU share beside its busy share, over the busy share's wall window (the event
// loop's ELU counts from its first turn).
setTimeout(() => {
    const line = Status.goalText({}, {});
    assert.match(line, / mainElu=\d\.\d\d mainCpu=\d\.\d\d /);
    console.log('health line cpu share ok');
}, 50);
