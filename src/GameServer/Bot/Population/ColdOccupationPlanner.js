'use strict';
const DiagnosticConfig = require('./PopulationConfig');
const Diagnostics = require('../Economy/EconomyDiagnostics');

const { performance } = require('node:perf_hooks');
const { unknownWorkshop } = require('./ColdEconomyDecision');
const MAX_CONTEXTS = 64, MAX_OWNERS = 8, OWNER_UNITS = 4, MAX_UNITS = 32, SLICE_MS = 4;
// A refresh (a far bot's economy plan) or a near bot's decision finishes on a
// read source that moved under it and publishes (its execution re-checks the
// lines it fills, withdraws and bids: a meeting's quote revision, the own
// line revision); the move makes the slot dirty after publish, so its next
// request builds once, many moves coalesced, never an immediate re-begin
// (design-rules Recompute: by events). Every other work begins again: a
// meeting's proof is its read tokens, a step awaits an action's workshop.
const finishesOnMove = input => input.mode === 'refresh' || input.mode === 'near';

// Incomplete contexts stay in slots through yield. Only completed derived
// entries are evictable. Waiting owners carry references to their existing
// native input, a 128 B numeric cursor and one completion callback, no graph.
class ColdOccupationPlanner {
    constructor({ capture, create, step, result, ownCurrent = () => true, sameInput = (left, right) => left === right,
        sourceToken, sourceScope = () => null, sourceScopeToken = () => 0,
        onSlots = () => {}, onWorking = () => {}, publish = () => {}, onPublishError = () => {}, now = () => performance.now(),
        schedule = callback => setImmediate(callback) } = {}) {
        Object.assign(this, { capture, create, step, result, ownCurrent, sameInput, sourceToken, sourceScope, sourceScopeToken, onSlots, onWorking, publish, onPublishError, now, schedule });
        this.slots = new Map(); this.waiting = new Map(); this.ready = new Set(); this.dependencies = new Map();
        this.workingContexts = 0;
        this.scopeDependencies = new Map();
        // Meeting readers share one representative item per category: their
        // token is the category fingerprint, not one item's revision.
        this.representatives = new Map();
        this.scheduled = false; this.stopped = false;
        this.stats = { portions: 0, units: 0, yields: 0, capacityDeferrals: 0, invalidations: 0,
            staleOwners: 0, replaced: 0, restarts: 0, unchanged: 0, maxUnitMs: 0, overBudgetUnits: 0, maxPortionUnits: 0 };
    }

    request(id, input, { awaitResult = true } = {}) {
        id = Number(id);
        if (!id || this.stopped) return Promise.resolve(unknownWorkshop());
        const existing = this.slots.get(id) || this.waiting.get(id);
        if (existing && this.sameInput(existing.input, input) && !existing.dirty) {
            if (existing.done) { existing.input = input; DiagnosticConfig.developerDiagnostics && (this.stats.unchanged++); return Promise.resolve(existing.value); }
            return awaitResult ? existing.promise : null;
        }
        if (existing && !existing.done) { DiagnosticConfig.developerDiagnostics && (this.stats.replaced++); this.cancel(id, 'owner_replaced'); }
        else if (existing) this.release(id);
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const entry = { id, input, resolve, promise, cursor: new Float64Array(16), dirty: false, done: false };
        this.waiting.set(id, entry);
        this.kick();
        return awaitResult ? promise : null;
    }

    kick() {
        if (this.scheduled || this.stopped || !this.waiting.size && !this.ready.size) return;
        this.scheduled = true;
        this.schedule(() => { this.scheduled = false; this.portion(); });
    }

    removeDependencies(entry) {
        for (const id of entry.reads?.keys() || []) {
            const owners = this.dependencies.get(id);
            owners?.delete(entry.id);
            if (!owners?.size) {
                this.dependencies.delete(id);
            }
        }
        entry.reads?.clear();
        if (entry.admissionScope != null) {
            const scope = entry.admissionScope;
            const owners = this.scopeDependencies.get(scope);
            owners?.delete(entry.id);
            if (!owners?.size) this.scopeDependencies.delete(scope);
        }
        entry.admissionScope = null; entry.admissionToken = null;
    }

    read(entry, id) {
        id = Number(id);
        if (!(id > 0) || entry.reads.has(id)) return;
        entry.reads.set(id, this.sourceToken(id, entry.input));
        let owners = this.dependencies.get(id);
        if (!owners) this.dependencies.set(id, owners = new Set());
        owners.add(entry.id);
    }

    readGroup(entry, id) {
        const scope = this.sourceScope(Number(id));
        if (scope === null) return this.read(entry, id);
        if (!this.representatives.has(scope)) this.representatives.set(scope, Number(id));
        this.read(entry, this.representatives.get(scope));
    }

    // A board row change in a category: per-item readers are rechecked by
    // sourceChanged(item); only the category representative is rechecked here.
    groupChanged(scope) {
        const id = this.representatives.get(scope);
        if (id !== undefined) this.sourceChanged(id);
    }

    // Producer dispatch names an item; it never walks all owners or a board.
    sourceChanged(id) {
        id = Number(id);
        for (const owner of this.dependencies.get(id) || []) {
            const entry = this.slots.get(owner);
            if (!entry) continue;
            const token = this.sourceToken(id, entry.input);
            if (entry.reads.get(id) === token) continue;
            // Coalesce by the exact used item revision. Updating this token is
            // safe only together with dirty: the obsolete work is never applied.
            entry.reads.set(id, token);
            if (this.keepsOn(entry)) continue;
            entry.dirty = true;
            entry.cursor[14] = 1; this.stats.invalidations++;
            if (!entry.done) this.ready.add(owner);
            else this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
        }
        this.kick();
    }
    // A read source or the admission scope moved under an unfinished refresh
    // or near work (finishesOnMove): it keeps on, marked once; false = the
    // caller's path (a done slot, any other work: dirty, begin again).
    keepsOn(entry) {
        if (entry.done || !finishesOnMove(entry.input)) return false;
        if (!entry.moved) { entry.moved = true; this.stats.invalidations++; }
        return true;
    }
    readScope(entry, scope) {
        if (scope == null || entry.admissionScope === scope) return;
        // Admission needs one scope. Do not turn discovery into a per-bot
        // catalogue of category dependencies.
        if (entry.admissionScope != null) throw Error('occupation_admission_scope_limit');
        entry.admissionScope = scope; entry.admissionToken = this.sourceScopeToken(scope);
        let owners = this.scopeDependencies.get(scope);
        if (!owners) this.scopeDependencies.set(scope, owners = new Set());
        owners.add(entry.id);
    }
    scopeChanged(scope) {
        const token = this.sourceScopeToken(scope);
        for (const owner of this.scopeDependencies.get(scope) || []) {
            const entry = this.slots.get(owner);
            if (!entry || entry.admissionToken === token) continue;
            entry.admissionToken = token;
            if (this.keepsOn(entry)) continue;
            const wasDirty = entry.dirty;
            entry.dirty = true; entry.cursor[14] = 1;
            if (!wasDirty) this.stats.invalidations++;
            if (!entry.done) this.ready.add(owner);
            else if (!wasDirty) this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
        }
        this.kick();
    }
    markReset(entry) {
        if (this.keepsOn(entry)) return;
        entry.dirty = true; entry.cursor[14] = 2; this.stats.invalidations++;
        if (entry.done) this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
    }
    // After a whole source table was replaced and its full copy applied: only
    // the slots whose read items or admission scope moved are marked, as
    // sourceChanged/scopeChanged mark them per row; a row the copy no longer
    // has reads as a moved token. Not during the copy: the table reads empty.
    recheckSources() {
        let moved = 0, kept = 0;
        for (const entry of this.slots.values()) {
            if (entry.input.mode === 'wish' || entry.dirty || entry.moved || !entry.reads) continue;
            let changed = entry.admissionScope != null && entry.admissionToken !== this.sourceScopeToken(entry.admissionScope);
            if (!changed) {
                for (const [id, token] of entry.reads) {
                    if (this.sourceToken(id, entry.input) !== token) { changed = true; break; }
                }
            }
            if (changed) { this.markReset(entry); moved++; } else kept++;
        }
        if (moved) Diagnostics.count('occupation', 'source_reset', 'moved', moved);
        if (kept) Diagnostics.count('occupation', 'source_reset', 'kept', kept);
    }

    admit() {
        let admitted = 0;
        for (const [id, entry] of this.waiting) {
            if (admitted === MAX_OWNERS) break;
            if (this.slots.size >= MAX_CONTEXTS) {
                let victim;
                for (const held of this.slots.values()) if (held.done) { victim = held.id; break; }
                if (victim === undefined) { DiagnosticConfig.developerDiagnostics && (this.stats.capacityDeferrals++); break; }
                this.release(victim);
            }
            this.waiting.delete(id); this.slots.set(id, entry); this.ready.add(id);
            this.onWorking(++this.workingContexts);
            this.onSlots(this.slots.size); admitted++;
        }
    }

    initialise(entry) {
        this.removeDependencies(entry);
        entry.reads = new Map(); entry.dirty = false; entry.moved = false; entry.cursor.fill(0);
        const read = entry.input.mode === 'meeting' ? id => this.readGroup(entry, id) : id => this.read(entry, id);
        entry.captured = this.capture(entry.id, entry.input, read, scope => this.readScope(entry, scope));
        entry.work = this.create(entry.captured);
        entry.validation = null;
    }

    finish(entry, value) {
        if (entry.done || this.slots.get(entry.id) !== entry) return;
        entry.done = true; entry.value = value ?? (entry.input.mode === 'action' ? null : unknownWorkshop());
        const moved = entry.moved === true;
        entry.work = null; entry.captured = null; entry.validation = null;
        // A completed route/workshop keeps compact evidence, no scratch graph.
        // Release its graph allowance while retaining the bounded scalar card.
        this.onWorking(--this.workingContexts);
        // Completion retains compact scalar evidence only, never an owner
        // inventory/recipe graph. The input reference is native lifetime-bound.
        entry.resolve(entry.value); entry.resolve = null; entry.promise = null;
        try { this.publish(entry.id, entry.input, entry.value); }
        catch (error) {
            entry.error = String(error?.message || error);
            this.onPublishError(error, entry.id, entry.input);
        }
        // Published from moved sources: the mark survives as dirty, so the
        // slot's next request builds once (finishesOnMove).
        if (moved) { entry.moved = false; entry.dirty = true; }
    }

    unit(entry) {
        if (!this.ownCurrent(entry.id, entry.input)) {
            DiagnosticConfig.developerDiagnostics && (this.stats.staleOwners++); this.cancel(entry.id, 'owner_stale'); return;
        }
        if (!entry.work || entry.dirty) { if (entry.work) DiagnosticConfig.developerDiagnostics && (this.stats.restarts++); this.initialise(entry); return; }
        if (entry.validation) {
            const next = entry.validation.next();
            if (!next.done) {
                const [id, token, scope] = next.value;
                entry.cursor[3]++;
                if ((scope ? this.sourceScopeToken(id) : this.sourceToken(id, entry.input)) !== token && !this.keepsOn(entry)) {
                    entry.dirty = true; entry.cursor[14] = 1; this.stats.invalidations++;
                }
                // A marked work has no more to check: it finishes.
                if (!entry.moved) return;
            }
            this.finish(entry, this.result(entry.work)); return;
        }
        // The cursor keeps the validation, invalidation and unit marks only:
        // nothing reads a per-unit copy of the work's own position fields.
        const done = this.step(entry.work);
        entry.cursor[15]++;
        if (done) entry.validation = (function* () {
            yield* entry.reads.entries();
            if (entry.admissionScope != null) yield [entry.admissionScope, entry.admissionToken, true];
        })();
    }

    portion() {
        if (this.stopped) return { units: 0, deferred: true };
        this.admit();
        // One clock read per unit: the end of a unit is the slice check of
        // the next one and, with diagnostics, the unit's own duration.
        let clock = this.now(); const started = clock; let units = 0, owners = 0;
        // Set insertion order supplies round-robin fairness across portions.
        for (const id of [...this.ready].slice(0, MAX_OWNERS)) {
            const entry = this.slots.get(id);
            this.ready.delete(id);
            if (!entry || entry.done) continue;
            owners++;
            for (let count = 0; count < OWNER_UNITS && units < MAX_UNITS; count++) {
                if (units && clock - started >= SLICE_MS) break;
                const unitStarted = clock;
                try { this.unit(entry); }
                catch (error) { entry.error = String(error?.message || error); this.finish(entry, entry.input.mode === 'meeting'
                    ? { refused: true, reason: entry.error, ...(typeof error?.cause === 'string' ? { cause: error.cause } : {}) }
                    : unknownWorkshop()); }
                clock = this.now();
                const duration = clock - unitStarted;
                DiagnosticConfig.developerDiagnostics && (this.stats.maxUnitMs = Math.max(this.stats.maxUnitMs, duration));
                if (duration > SLICE_MS) DiagnosticConfig.developerDiagnostics && (this.stats.overBudgetUnits++);
                units++; DiagnosticConfig.developerDiagnostics && (this.stats.units++);
                if (entry.done || this.slots.get(id) !== entry) break;
            }
            if (!entry.done && this.slots.get(id) === entry) this.ready.add(id);
            if (units >= MAX_UNITS || clock - started >= SLICE_MS) break;
        }
        DiagnosticConfig.developerDiagnostics && (this.stats.portions++); DiagnosticConfig.developerDiagnostics && (this.stats.maxPortionUnits = Math.max(this.stats.maxPortionUnits, units));
        if (this.ready.size || this.waiting.size) { DiagnosticConfig.developerDiagnostics && (this.stats.yields++); this.kick(); }
        return { units, owners, deferred: !units && !!this.waiting.size };
    }

    release(id) {
        id = Number(id);
        const entry = this.slots.get(id);
        if (!entry) return;
        this.removeDependencies(entry); this.slots.delete(id); this.ready.delete(id);
        if (!entry.done) this.onWorking(--this.workingContexts);
        this.onSlots(this.slots.size);
    }
    cancelState(id, state) {
        const entry = this.slots.get(Number(id)) || this.waiting.get(Number(id));
        if (!entry || entry.input.state !== state) return false;
        this.cancel(id);
        return true;
    }
    cancel(id) {
        const entry = this.slots.get(Number(id)) || this.waiting.get(Number(id));
        if (!entry) return;
        this.waiting.delete(Number(id));
        entry.resolve?.(unknownWorkshop()); entry.resolve = null;
        this.release(Number(id));
    }
    stop() {
        this.stopped = true;
        for (const id of [...this.slots.keys(), ...this.waiting.keys()]) this.cancel(id);
        this.ready.clear(); this.dependencies.clear(); this.scopeDependencies.clear(); this.representatives.clear();
    }
    snapshot() { if (!DiagnosticConfig.developerDiagnostics) return { enabled: false }; return { ...this.stats, contexts: this.slots.size, working: this.workingContexts, pending: this.waiting.size,
        active: this.ready.size, dependencies: this.dependencies.size, cursorBytes: (this.slots.size + this.waiting.size) * 128 }; }
}

module.exports = { ColdOccupationPlanner, MAX_CONTEXTS, MAX_OWNERS, OWNER_UNITS, MAX_UNITS, SLICE_MS };
