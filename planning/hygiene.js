#!/usr/bin/env node
'use strict';
// Planning and workspace hygiene (maintainer, 2026-11-06): no stray files, no unbounded growth.
// Run at every task boundary: `node planning/hygiene.js` (exit 1 = something to prune before going on).
//   1. planning/ is a closed list (ALLOWED, the same as the list in .claude/workflow/git.md): a file outside it or over its KB budget fails.
//   2. The step plan (target-architecture/step.md) whose work is merged and measured is deleted (history lives in git).
//   3. Worktrees under .claude/worktrees whose branch is merged into the integration/release branch, with a clean tree,
//      are listed for removal (`--remove` removes them; never one with uncommitted changes or unmerged commits).
// Budgets are KB an agent reads (planning.md: dense form, pruning); views lc renders have none.

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLANNING = __dirname;
const INTEGRATION = process.env.HYGIENE_BRANCH || 'ivan/batch-6';
// Branches whose worktrees are never removed here (the integration branch itself; perf-tooling per .claude/workflow/git.md).
const KEEP = new Set([INTEGRATION, 'ivan/next-release', 'perf-tooling', 'main', 'ivan/perf-remote']);
const STALE_DAYS = 1;
// CLAUDE.md is read by every agent (KB); policy is budgeted per role (CLAUDE.md + routes + evidence + the role's rows of
// CLAUDE.md's table), not as the folder's total.
const CLAUDE_MD_KB = 14; // compact entry point; detailed policy lives in .claude/workflow/
const ROLE_KB = 32; // measured 11-11: 24-32 KB per role
const ROLE_FILES = {
    implementer: ['coding.md'], landing: ['git.md', 'testing.md'], planner: ['agents.md', 'planning.md'],
    release: ['testing.md', 'release.md', '../../planning/perf-tooling/test-recipe.md']
};

// The closed list (git.md "Where things are"): every file allowed under planning/ with its KB budget; any other fails.
// A new file only with the maintainer's ok, in git.md's list and here together.
const ALLOWED = {
    'hygiene.js': 10,
    'rules-check.js': 7,
    'tests-for.js': 5,
    'coverage.js': 8,
    'roadmap.md': null, // rendered by .claude/lc.js: checked for freshness (lc render --check), not size
    'perf-tooling/test-recipe.md': 9,
    'architecture/README.md': 9,
    'architecture/check.js': 6,
    'architecture/bot-ai.md': 20,
    'architecture/combat.md': 26,
    'architecture/economy.md': 40,
    'architecture/population.md': 40,
    'architecture/persistence.md': 16,
    'architecture/world.md': 11,
    'architecture/limits.md': 66, // code names stay in backticks: check.js reads them
    'architecture/tables.md': 28,
    'architecture/e2e.md': 12,
    'architecture/problems.md': null, // rendered by lc, grepped by id; agents read lc show; code names in backticks for check.js
    'target-architecture/plan.md': 8,
    'target-architecture/situations.md': 8,
    'target-architecture/economy.md': 60,
    'target-architecture/memory.md': 7,
    'target-architecture/step.md': 12, // the open step's plan; deleted when the step lands
    'target-architecture/decision-registry.js': 10,
    'target-architecture/decision-registry.json': 380
};

const problems = [], sizes = []; // sizes warn with numbers (diagnose: lc status/check, context-cost); they never fail
function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(path.relative(PLANNING, full));
    }
    return out;
}
for (const file of walk(PLANNING)) {
    const budget = ALLOWED[file];
    const kb = Math.ceil(fs.statSync(path.join(PLANNING, file)).size / 1024);
    if (budget === undefined) problems.push(`file outside the closed list: planning/${file} (${kb} KB): delete it (a new file needs the maintainer's ok in .claude/workflow/git.md's list)`);
    else if (budget !== null && kb > budget) sizes.push(`planning/${file}: ${kb} KB (guide ${budget} KB)`);
}

// A step plan is finished when it says "Measured" and "Done": its binding decisions go to the map, the file is deleted.
const stepFile = path.join(PLANNING, 'target-architecture/step.md');
if (fs.existsSync(stepFile)) {
    const text = fs.readFileSync(stepFile, 'utf8');
    if (/^## Measured/m.test(text) && /^## Done/m.test(text)) problems.push('planning/target-architecture/step.md is merged and measured: move its binding decisions to the map, then delete it');
}

const git = cmd => execSync(`git -C ${JSON.stringify(ROOT)} ${cmd}`, { encoding: 'utf8' }).trim();
const remove = process.argv.includes('--remove');
const merged = [], stale = [];
for (const block of git('worktree list --porcelain').split('\n\n')) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!wt || wt === ROOT) continue;
    if (!wt.includes('/.claude/worktrees/')) {
        // A scratch worktree (perf side, merge, squash) outside .claude/worktrees: listed once a day old (dir mtime).
        const days = (Date.now() - fs.statSync(wt).mtimeMs) / 86400000;
        if (days > STALE_DAYS) stale.push({ wt, branch: branch || 'detached', days: Math.floor(days) });
        continue;
    }
    if (!branch || KEEP.has(branch)) continue;
    let ahead, dirty;
    try {
        ahead = Number(git(`rev-list --count ${INTEGRATION}..${branch}`));
        dirty = execSync(`git -C ${JSON.stringify(wt)} status --porcelain`, { encoding: 'utf8' }).trim().length > 0;
    } catch (_) { continue; }
    if (ahead === 0 && !dirty) merged.push({ wt, branch });
    else if (!dirty) {
        // Squash-merged topics never read as merged: a clean worktree with no commit for STALE_DAYS is listed for review.
        const last = Number(git(`log -1 --format=%ct ${branch}`));
        if (Date.now() / 1000 - last > STALE_DAYS * 86400) stale.push({ wt, branch, days: Math.floor((Date.now() / 1000 - last) / 86400) });
    }
}
if (merged.length) {
    if (remove) {
        for (const { wt, branch } of merged) {
            git(`worktree remove ${JSON.stringify(wt)}`);
            console.log(`removed ${path.relative(ROOT, wt)} (${branch}, merged into ${INTEGRATION})`);
        }
    } else {
        problems.push(`${merged.length} worktrees are merged into ${INTEGRATION} and clean (run with --remove):\n    `
            + merged.map(m => `${path.relative(ROOT, m.wt)} [${m.branch}]`).join('\n    '));
    }
}

if (stale.length) {
    // Removing a clean worktree loses nothing: its branch stays (delete branches only when proved merged).
    if (remove) for (const { wt, branch } of stale) { git(`worktree remove ${JSON.stringify(wt)}`); console.log(`removed ${path.relative(ROOT, wt)} (${branch} kept)`); }
    else problems.push(`${stale.length} clean worktrees with no commit for ${STALE_DAYS}+ days (run with --remove; branches stay):\n    `
        + stale.map(m => `${path.relative(ROOT, m.wt)} [${m.branch}] ${m.days} d`).join('\n    '));
}
const wtDir = path.join(ROOT, '.claude/worktrees');
if (fs.existsSync(wtDir)) for (const e of fs.readdirSync(wtDir, { withFileTypes: true })) {
    if (!e.isDirectory()) problems.push(`stray file .claude/worktrees/${e.name}: delete it (scratch goes to the session scratchpad)`);
}
const claudeKb = Math.ceil(fs.statSync(path.join(ROOT, 'CLAUDE.md')).size / 1024);
if (claudeKb > CLAUDE_MD_KB) sizes.push(`CLAUDE.md: ${claudeKb} KB (guide ${CLAUDE_MD_KB} KB; every agent reads it)`);
const workflowDir = path.join(ROOT, '.claude', 'workflow');
if (fs.existsSync(workflowDir)) {
    const size = f => { const p = path.join(workflowDir, f); return fs.existsSync(p) ? fs.statSync(p).size : 0; };
    const every = fs.statSync(path.join(ROOT, 'CLAUDE.md')).size + size('routes.md') + size('evidence.md');
    const named = new Set(['routes.md', 'evidence.md', ...Object.values(ROLE_FILES).flat()]);
    for (const f of fs.readdirSync(workflowDir).filter(f => f.endsWith('.md') && !named.has(f))) problems.push(`.claude/workflow/${f}: in no ROLE_FILES role`);
    for (const [role, files] of Object.entries(ROLE_FILES)) {
        const kb = Math.ceil((every + files.reduce((n, f) => n + size(f), 0)) / 1024);
        if (kb > ROLE_KB) sizes.push(`${role} reads ${kb} KB of policy (guide ${ROLE_KB} KB)`);
    }
}
const lc = path.join(ROOT, '.claude', 'lc.js'); // after the cutover the views must be the lc render
if (fs.existsSync(lc)) {
    try { execFileSync(process.execPath, [lc, 'render', '--check', '--repo', ROOT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { const msg = String(e.stderr || '').trim(); if (/not the lc render/.test(msg)) problems.push(msg.replace(/^lc: /, 'planning views ')); }
}
const runsDir = path.join(ROOT, 'tmp/perf/runs');
// Perf runs kept (maintainer, 2026-11-06): the last release's end (its sha in BASELINE_RUNS) and the newest measurement
// (the newest sha's runs per scenario). Everything else is listed for deletion.
// Release 1's end (9d6bf579a) and its A sides on v0.1.2, the version players have until release 1 ships.
const BASELINE_RUNS = ['9d6bf579a-script', '9d6bf579a-hot', '21ef29385-script', '21ef29385-hot'];
if (fs.existsSync(runsDir)) {
    const runs = fs.readdirSync(runsDir).filter(r => /-(cold|hot)-\d{8}-\d{6}$/.test(r));
    const newest = {};
    for (const r of runs) { const [, sha, kind, at] = /^(.+)-(cold|hot)-(\d{8}-\d{6})$/.exec(r); if (!newest[kind] || at > newest[kind].at) newest[kind] = { sha, at }; }
    const keep = r => BASELINE_RUNS.some(b => r.startsWith(b + '-')) || ['cold', 'hot'].some(k => newest[k] && r.startsWith(`${newest[k].sha}-${k}-`));
    const extra = runs.filter(r => !keep(r));
    if (extra.length) problems.push(`tmp/perf/runs: ${extra.length} runs beyond the release baseline and the newest measurement (delete them):\n    ${extra.join('\n    ')}`);
}
if (sizes.length) console.log(`hygiene: size notes (no action forced; diagnose with lc status/check and context-cost)\n- ${sizes.join('\n- ')}`);
if (problems.length) {
    console.log(`hygiene: ${problems.length} to prune\n- ${problems.join('\n- ')}`);
    process.exit(1);
}
console.log('hygiene: clean');
