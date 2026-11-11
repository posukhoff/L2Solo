# Roadmap: small releases every few days
The one queue (CLAUDE.md "Problems, plans and the roadmap"): rows cite problems.md ids or a plan file. P = player impact, S = server impact; order (maintainer 11-05): server works → performance → one rule → game gaps; economy second, right after 1b, clan aggregate in 1b (maintainer 11-11); Who: ivan / slava, empty = free (name and push first). 5's CMB items before the typed core.
## 1a. Bug fixes from release 1's final runs (maintainer 11-10)
| Item | P | S | Who |
|---|---|---|---|
| World test: RM-20 | mid | low | |
## 1b. Parties and spots, split by kind (maintainer 11-09/10: one kind per release)
| Item | P | S | Who |
|---|---|---|---|
| 1b.1 architecture, parties on the worker (maintainer 11-10: one release): forming: the region × band seeker pool and the roster verdict on the worker, a new party written by one atomic worker commit; main's forming and recruit passes deleted (DT-44, A-11, DT-46); hot party decisions: members post facts, the worker takes party_stay/party_spot for a party near a player, main executes (DT-49, DT-89, DT-190); DT-209; pays parties-6; DT-244, DT-246, RA1-6 | mid | **high** | |
| 1b.2 architecture, needs 1b.1: the clan as one aggregate on the worker (maintainer 11-11: not economy): roster, leader, level, settings record; facts member_joined/left, member_grade_changed, leader_changed raise to members, parties and the board; `clan_call` replaces `ClanPartyHelp` pleas and the `ClanPartyDuty` 30 s retry (situations step 9); clan evidence on the worker (DT-114, `ClanSocialEvidence` off main's `ClanWarRuntime`); clan planners on their events, windows deleted: DT-27, storage-11, SR-9, DT-92, D7; clan money (donations, wants, spend) stays economy E9 on this aggregate; clocks it removes: DT-250, DT-251 | mid | **high** | |
| 1b.3 feature, needs 1b.1, 1b.2: retake a spot (maintainer 11-09): a displaced bot (persona, grievance, someone to call) asks friends/clanmates for a party aimed at that spot with strength above the holder; each helper decides by relation and its own cost; outcome by the arrival contest with PvP; one attempt per outing; standing parties displaceable (DT-105) | mid | low | |
| 1b.4 feature: spot room from respawn (maintainer 11-09): room = clamp(round(0.6 × respawn output ÷ the spot's solo kills/h), 3 (9 party grounds), 36), contest splits room by species respawn share; sim + step run first (DT-121); arrivals past room DT-121; raid room test DT-133; a hold cleared only by an arrival: RA1-1 | mid | low | |
| 1b.5 feature: spots from C4 spawn territories, not the 6000 grid (maintainer 11-09: plan later): a bot belongs to a camp, activation places it there; spot ids and tables change; sight scan and roam over its spawn points (DT-152, DT-125) | **high** | mid | |
| 1b.6 feature: draw distance as a launcher setting (maintainer 11-09, deferred): presets ~4000/6000/8000 the server visibility radius follows, activation/cooling radii derived (+3000/+5000); first verify the C4 visibility radius and that the client sends no draw-distance packet | low | mid | |
## 2. Economy (a redesign: target-architecture/economy.md; maintainer 11-07: no economy work outside it; 11-11: second, after 1b)
| Item | P | S | Who |
|---|---|---|---|
| FIRST (maintainer 11-09): D-grade shots never restocked: RM-45 | **high** | low | |
| Sure-price owner draft (ivan/economy-prices 94ac9f1cb): DT-67 | high | mid | |
| Fixed buy stores (decide with Slava): RM-15 | high | high | |
| Field trade both ways, contention as trade: economy.md "Leanings" | mid | mid | |
| One free-units and bids rule: DT-118, DT-145, DT-149, DT-151, DT-162, DT-165, DT-186, DT-188, DT-144, DT-213, DT-218, DT-224, DT-233, DT-240, DT-254, DT-256, DT-258 | mid | low | |
| Design inputs: ECO-2, ECO-3, ECO-4, ECO-5, ECO-6, ECO-7, ECO-8, ECO-10 (bid worth), ECO-13, ECO-14, ECO-15, ECO-16, SR-6, SR-7, SR-10, BA-3, PL-11, DT-63, DT-64, DT-66, DT-68, DT-74, RM-14, town-5, DT-22, DT-79, DT-40, PL-6, RA-12, DT-70, DV-6, RM-41, RM-46, DT-219, DT-222, DT-229, DT-249, DT-252 | mid | mid | |
## 3. The server works: owners, handovers, failures that show
| Item | P | S | Who |
|---|---|---|---|
| Run tooling (maintainer 11-10): `perf.js --trace` (no reliance on local.ini) and a first-minute self-check (trace, diagnostics, world kept) that stops a wrong run; behaviour runs on fork CI runners in parallel (workflow + saves as an artifact) and on the team VPS; DT-139, DT-167, DT-175, DT-177, DT-210 | low | mid | |
| Behaviour bugs: DT-112, DT-120, DT-171, DT-216, DT-220, DT-226, DT-257; placement: DT-129, DT-170, DT-183placement: DT-129, DT-170, DT-183, DT-173 | | mid | low | |
| Fence without an owner, activation window: L26, races-R6 | mid | mid | |
| Supply errand with two owners: races-R15 | low | mid | |
| Hot/cold handover windows: races-R5, races-R7, POP-4, POP-5, POP-22, threads-9, DT-127, DT-223, DT-236, DT-241 | low | mid | |
| Cold command dropped without an ack: S3 | low | mid | |
| Uncounted failures: threads-4, town-12, parties-12, DT-1, S2, X6, X17, SF-4, DT-130, DT-110, DT-168, DT-212, DT-245 | low | mid | |
| Refusals by one classifier hot and cold, not faults: RM-34, DT-142, DT-148, DT-150, DT-234, DT-235, RA3-1 | low | mid | |
| Trace gaps: RM-37, DT-86, DT-128, DT-178, DT-179, DT-215, DT-259 | low | mid | |
| Main writes far rows on a raise (release 1 exception, rule 15 away, maintainer 11-09): `raiseOnRow`/`raiseOn` → a named raise message the worker applies in its commit; RC-2, RC-4, SF-2, threads-7 | low | mid | |
| Situation raises and failures that do not show: RC-2, RC-3, RC-4, SF-1, SF-2, SF-3, SF-5, SF-6, ECO-10 (own move), A-12, BA-6, RA-9, DT-111, DT-147, DT-176 | low | mid | |
| One store per membership: parties-13, storage-4 | low | mid | |
| One worker restart rule: DT-16, races-R16, DT-98 | low | mid | |
| One-time migrations under the governor: DT-2 | low | mid | |
| Restart / Logout teardown: X16 | mid | low | |
| rules-check after the V5.1 freeze (maintainer 11-11: changes the policy digest): Trade line check RA3-3; design-id CITE check (RA3-2 tail); CITE over commit bodies: RA3-4 | low | mid | |
| Flaky tests, CI time, tests of internals: RM-4, DT-15b, TS1, TS2, TS4, RA-14, RA3-5, DT-225, DT-260, DT-262; a comment in a table input costs a rebuild: DT-261 (then DT-132) | mid | low | |
| Statement cache cleared by long SQL: DT-51; recorder heap window leak: DT-50 | low | mid | |
| Polls standing in for missing events (rule 2): POP-24, POP-25, AI-14, AI-15, threads-5, DT-77, DV-3, DT-185, DT-217, RA1-4 | low | mid | |
## 4. Main thread and memory for 3-5k bots
| Item | P | S | Who |
|---|---|---|---|
| FIRST (maintainer 11-08): memory as the source of truth, the DB a write-behind store, then the DB writer worker (plan.md "Order" 1, "DB writer worker") | high | **high** | |
| Scaling limits by population: C12, C17 | low | **high** | |
| Memory track: per-thread and process budgets in limits.md, afterGc-per-thread + rss line in `perf.js report`/`compare`, the always-on `caps=` segment (memory.md "Budgets"); memory.md ranks 1-2 measured; cuts ranks 3-10, first 5 (`parsedColumns`), 8 (shop projections), 10 (boot peak) | low | **high** | |
| Heap holders: DT-155, DT-156, DT-166, DT-157, DT-160, DT-161, DT-158 | mid | **high** | |
| Big rows and writes on main: RM-17, C1, C11, RM-18, F8, RM-28, RM-29, RA2-3 | mid | **high** | |
| Main redoes work: storage-10, PC-16, DT-65; cache keys: DT-83, A-10, DT-103 | low | mid | |
| Worker step costs: PC-4, PC-5, PC-7, PC-8, PC-9, RM-2, PC-12, DT-135, DT-140, DV-4, RM-30; boot and worker start: DT-136, DT-137, DT-138 | low | mid | |
| Visible bot routes to the path pool: WOR-2 | mid | **high** | |
| Main-thread step costs: WOR-11, C8, WOR-4, C10, C13, C14, C15, C16, CMB-27, PL-18, RM-40, DT-180, RA2-4 | low | mid | |
| Later perf: RM-19; merchants hot: POP-21 | low | mid | |
| Delete dead features: WOR-5, POP-17 (one batch) | low | mid | |
| Dead code, fields and knobs (one batch, re-check by search): DT-6, DT-82, AI-8, POP-15, POP-20, F12, F13, L6, DB2, DB3, DB4, DB6, TBL-5, DT-52, DT-113, DT-37, storage-14, RM-36, DT-124, DT-134, DT-126, DT-93, DT-232, DT-253, DT-255, RA1-8 | low | low | |
## 5. One rule hot and cold
| Item | P | S | Who |
|---|---|---|---|
| Hot travel and activation as cold: WOR-7, town-2, town-3, threads-1 | **high** | low | |
| Skill reuse, MP cost, cast time, attack speed, raid forecast: CMB-1, CMB-2, N11, N12, combat-8 | mid | low | |
| Exposure to aggressive mobs: combat-3 | **high** | low | |
| Death wait and restart: combat-1 (decided 11-03) | **high** | low | |
| PvP stay/flee/retreat, consumables: combat-4, combat-5 | mid | low | |
| Swing loops and weapon spread: CMB-7, CMB-3, CMB-11; estimates through HitRules: CMB-6; stat assembly: CMB-8, CMB-9 | mid | low | |
| Archers, bag slots: N3, N9, races-R19 | mid | low | |
| Rest, heal and raid lines: N4, N6, N8, combat-6, combat-7, combat-11, RM-1 | mid | low | |
| Copied rule numbers: N13, N15, N16, N17, N18, N19, CMB-19, WOR-9, DT-80, RA-8, parties-11, parties-15, combat-10, DT-119, DT-163, DT-221, DV-5, RA1-3, RA1-5 | low | low | |
| One town identity and arrival rule: WOR-6, town-4 | mid | low | |
| One "is a bot" rule: WOR-3 | mid | low | |
| Hot/cold logic drift: L28, L5, PER-6, POP-6, POP-8, CMB-10, CMB-17, PER-8, threads-10, DT-59, DT-61, DT-73, RM-44, DT-237 | mid | low | |
| Seeded rolls and pure rules: purity-R1, purity-R2, purity-R3, purity-R4, purity-R12, purity-R7, purity-R8, purity-R9, purity-R10, purity-R11, PU3, PU5, RA-10 | mid | low | |
| Party want and grouping predicate: parties-9, parties-10, AI-6 | mid | low | |
| One PvP owner: SR-12; magic flag vs damage formula: D-4 | low | low | |
| PR passes: RM-6 (#213), RM-7 (#215) | mid | low | |
| Chat commands one meaning: AI-1; companions on shared policies: AI-4 | mid | low | |
| Disabled quests: D4 (decided 11-03) | mid | low | |
## 6. Game gaps vs C4
| Item | P | S | Who |
|---|---|---|---|
| Clan rules vs C4: storage-1, storage-7, storage-8, storage-9, town-11 | mid | low | |
| D-S shots only via craft/board: DB1 (decided 11-03) | high | low | |
| Player-visible item bugs: X2, X3, X4, X11, X12, X15, X18, X19, R-A | high | low | |
| Reads of missing methods or unwritten keys: F2, F3, F4, F5, F6, F10 | mid | low | |
| Bot knowledge and spot value: RM-8, RM-9, RM-10, RM-11 | mid | low | |
| Soul crystal quest: F1; clan warehouse reservations: D2 | mid | low | |
| Data against C4: D-8, D-9, D-10, D-11, D-12, D-13 | low | low | |
| Game logic: L8, L9, L29, S6, CMB-15, POP-10, DT-228 | mid | low | |
| PvP and combat tails: CMB-21, CMB-22, CMB-28, CMB-29, CMB-30, DT-14, CMB-24, CMB-25, DT-9, DT-227 | mid | low | |
| Drop tooltip pages: DT-18; arrow stock: DT-19; Giran crystallization: RM-12 | low | low | |
## 7. Value safety (DB migrations; after the named-migration scheme is agreed with Slava)
| Item | P | S | Who |
|---|---|---|---|
| Duplicates from merged copies: races-R8, storage-6 | **high** | low | |
| Revision-less writes: races-R2, races-R10, DT-71, DT-72 | mid | low | |
| Clan money: races-R12, DT-78, races-R17 | mid | low | |
| Invented 1-HP mob: S1 | mid | mid | |
| Atomic value moves: PER-1, PER-2, PER-3, storage-2, storage-12, storage-13, X13, races-R3, races-R4, races-R14 | **high** | low | |
| One stacking rule: PER-11 (P-1 urgent), D-5 | **high** | low | |
| Bots on the account warehouse: PER-9; social graph dropped: PER-4 | low | low | |
## 8. Parties like players (maintainer 11-08: after the economy release)
| Item | P | S | Who |
|---|---|---|---|
| Party town break: RM-24 | **high** | low | |
| Parties through relationships: RM-25 | mid | low | |
## Large, own plan
- Components, typed arrays, sharding: plan.md; POP-23.
- Situational e2e scripts: architecture/e2e.md (six to write, step timeouts, "precondition failed"), after release 2.
- Spot choice like a player (maintainer 11-09): one solo spot search, the habit band for the gear source too: DT-102.
- Board publication by the worker only: ECO-1. Cold-bot record audit: PER-7. One movement engine: WOR-1. Schema mechanisms into one list: PER-5. Cold walker on its road: RM-27.
- Gear progression and market demand from the hunt tables: TBL-3; table generator coupling and unread kit surface: TBL-2, TBL-4, TBL-8.
- Clan share from personas (discuss with Slava): RM-26.
- Bot memory on situations: DT-101; pausable economy build: DT-141; shot recipe class: DV-2.
