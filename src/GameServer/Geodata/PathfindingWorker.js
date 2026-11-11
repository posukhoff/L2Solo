require('../../Global');

const { parentPort, workerData } = require('worker_threads');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = workerData?.developerDiagnostics === true;
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
GeodataEngine.attachShared(workerData?.sharedGeodata);
const TownPathCorridor = invoke('GameServer/Geodata/TownPathCorridor');
const { heapRecord, observe } = invoke('GameServer/Bot/Population/WorkerHeapTelemetry');
if (workerData?.developerDiagnostics === true) observe(); // major-GC window for the v8Heap record (WorkerHeapTelemetry)

GeodataEngine.init();
// One turn of the worker runs a search for at most this long, then lets the
// event loop run and continues the same search on the next turn.
const SLICE_MS = 150;
// Path messages in arrival order; the first one is the running search.
const pending = [];
let loadedRevision = null; // navigation revision the engine was last initialised for
let newestRevision = null; // newest navigation revision any town request asked for
let job = null;

parentPort.on('message', (message) => {
    if (!message || message.type !== 'path') return;
    if (message.request.townCorridor) newestRevision = message.request.navigationRevision;
    pending.push(message);
    if (pending.length === 1) start();
});

function* search(request) {
    const path = yield* GeodataEngine.findPathSteps(
        request.startX,
        request.startY,
        request.startZ,
        request.endX,
        request.endY,
        request.endZ,
        request.maxNodes,
        {
            debug: false,
            goalRadius: request.goalRadius,
            goalZTolerance: request.goalZTolerance,
            heuristicWeight: request.heuristicWeight
        }
    );
    return request.townCorridor ? yield* TownPathCorridor.buildSteps(path) : path;
}

// The engine is re-initialised only between searches, so a paused search
// never continues on changed navigation data.
function start() {
    const { id, request, cancelBuffer } = pending[0];
    if (request.townCorridor) {
        if (loadedRevision !== null && loadedRevision !== request.navigationRevision) GeodataEngine.init();
        loadedRevision = request.navigationRevision;
    }
    job = {
        id,
        request,
        cancelFlag: cancelBuffer ? new Int32Array(cancelBuffer) : null,
        steps: search(request),
        // Work time over all turns; the pool charges town work by it.
        timed: request.townCorridor || workerData?.developerDiagnostics === true,
        workMs: 0
    };
    runSlice();
}

function stale(message) {
    return Object.assign(new Error(message), { code: 'STALE_PATH' });
}

function runSlice() {
    const sliceStart = performance.now();
    let reply;
    try {
        // A newer revision arrives only between turns: a town search for an
        // older one would answer for navigation data that no longer exists.
        if (job.request.townCorridor && job.request.navigationRevision !== newestRevision) {
            throw stale('navigation revision changed');
        }
        for (;;) {
            if (job.cancelFlag && Atomics.load(job.cancelFlag, 0) !== 0) throw stale('path cancelled');
            const step = job.steps.next();
            if (step.done) {
                reply = { id: job.id, ok: true, path: step.value };
                break;
            }
            const elapsed = performance.now() - sliceStart;
            if (elapsed >= SLICE_MS) {
                job.workMs += elapsed;
                setImmediate(runSlice);
                return;
            }
        }
    } catch (error) {
        reply = { id: job.id, ok: false, code: error?.code, error: error?.message || String(error) };
    }
    job.workMs += performance.now() - sliceStart;
    reply.workerMs = job.timed ? job.workMs : null;
    if (reply.ok && workerData?.developerDiagnostics === true) reply.v8Heap = heapRecord();
    parentPort.postMessage(reply);
    job = null;
    pending.shift();
    if (pending.length) setImmediate(start);
}
