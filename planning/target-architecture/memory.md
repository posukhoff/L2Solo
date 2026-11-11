# Memory: every thread and the whole process (census 2026-11-05)

Maintainer: manage the heap of each thread and of the process. Census of 7e2be3a44 cold (1731 bots) vs R2 985e4b6af
and 29ae424cd; sampled heap profiles split by allocating stack (no snapshot: retainers unconfirmed), per-bot figures
from the code. Scripts: session scratchpad memory/ (series.js, owners.js, sites.js, tree.js, above.js, byfile.js).

## Process (end of window)

rss 1991 MB (1931 → 1991, max 2029; R2 2559, 29ae 2121) = heaps committed 1446 (main 575, worker 574, clan 209,
perf-chunks 69 perf only, history 11, checkpoint 8) + geodata touched 152 (one SharedArrayBuffer; 716 MiB reserved
address space, never read `arrayBuffers` as resident) + V8 external 122 (main 56, worker 66; each thread's 33 MB spot
table typed arrays) + other ~271 (clan external, node text, isolate malloc, SQLite ~15-20 MB, stacks, pages freed by
V8 not yet returned). rss follows the heap peak: main's boot peak (756 used, R2 979) leaves freed pages in rss.

Limits: main none set (V8 default from RAM, 4096 old + 192 young here); OOM aborts the server, nothing restarts it
(`scripts/run-server.js` ~37/49-60). Cold worker old 512 / young 192 (`ColdSimulationCoordinator` ~398, `PopulationConfig`
~59/63, keys not in default.ini); OOM → restart with backoff forever (`onWorkerExit` ~2303) → crash loop if live stays
above the cap. Clan worker old 256 / young 48 (`clanWorkerHeapMb`/`clanWorkerYoungMb`); terminated → plans
rejected, retry 5 s, restarts always counted (`clanRestarts=`) and logged. History, checkpoint, perf-chunks, pathfinding (≤2), market overview: defaults. SQLite: WAL,
temp_store=MEMORY, no cache_size/mmap (`Database` ~4873). External memory and geodata: uncapped.

## Per thread

- **Worker** 285 afterGc ≈ 96 MB fixed + 109 KB/bot: states from main 29 KB/bot (46 MB, uncapped), kernel upserts/acks
  7, held builds 25 (wish projection 14.9 MB, income search 11.4, planOf 8.6, heldWorkshop 8.0; `RETAIN_LIMIT` 2048),
  planner cards + sale holds 14 (uncapped), kit profiles 8 (cap 2125), solo searches 5, simulation 6, advisory 4,
  table mirror 6, readers 5; fixed: code + datapack 36 (DataCache 25), pure memos 40 (SpotValueTable 18, SpotReward 10,
  C4SkillRules 6.6, SourceCatalog 5). Off-heap +66. Flat in the window (fills in warm-up).
- **Main** 323 afterGc ≈ 161 fixed + 91 KB/bot: BotLifeState cache 27 KB/bot, states from worker 18, AfkTrade shop
  projections 17 (~30 KB per seller), Database rows 12, coordinator 6, kit profiles 5 (from cold commit prep); fixed:
  code ~45, datapack 17.5, NPC spawns 37, first prices 17, memos ~38. Grows +1.3 MB/min in the window (shop projections,
  commit canonicalize, DB rows): a 60-min run decides whether it levels.
- **Clan** live 59-81 (committed 209): catalogs/board pages 22, code 14.5, spot table 33 off-heap; by clans, not bots.
- **Duplicated:** spot table 33 × 3, SpotValueTable memos 18/18/5, datapack 17.5/25/22, SpotReward 9/10/1, C4SkillRules,
  SourceCatalog, ColdOccupationSources, kit profiles: ~100 MB of read-only copies + ~50 MB memos. Bot states held
  twice: ~75 KB per bot for the process.
- vs 29ae: worker +21 (planner cards/sale holds +10.7, solo searches +5.7, advisory +3.6, income candidate models +6.8,
  readers +2.9, state copies +5.7, valueBytes key walk +2.8; SpotReward −7); main −30 (KB, BotLifeState, SpotReward).

## Scaling

Worker 96 MB + 109 KB/bot (≈30 KB under 2048 caps; past them served steps become 20 ms rebuilds); main 161 + 91 KB/bot.
3000 bots: worker 387-415 (76-81 % of 512), main ~430, rss ~2.5 GB. GC thrash ~450 MB at ~3.3k (caps scaled) / ~3.8k;
OOM ~3.9k / ~4.6k. 5k needs 2 shards (~300 MB rss each today). Main's risk is its boot peak (~2.3× steady). Other walls:
maxPlayingPopulation clamp 2000 (`PopulationConfig` ~323), RETAIN_LIMIT / SOLO_SEARCH_LIMIT 2048, kitProfiles 2125.

## Ranked targets

1-2. Landed, measure in the world test: spot table in one SharedArrayBuffer (`SpotValueTable`; −66 MB rss expected, −33 per shard, no 20 MB JSON parse at worker/clan boot); clan worker resourceLimits old 256 / young 48 + always-on restart count (−100 MB rss expected).
3. Held builds trimmed to the decision (not done by the situations work; `RETAIN_LIMIT` 2048 still in `EconomyContext`): −15-20 KB/bot, the 2048 cliff goes. To delete:
   held-build re-proof reads, held income candidates (crowd replay, `modelOf`), held sale dispositions, the solo-search
   hold, the forming-verdict hold, workshop `servesUntil`, kept source facts / gear candidates where only re-ask proofs.
4. Planner cards: one per bot (its current mode); sale holds gone or numeric-keyed: −6-10 KB/bot.
5. Main without full cold-state copies (components, plan §4.6): main −20-30 KB/bot, worker −5-10; cold commit prep on
   main (`GoalService.choose`/`SurvivalFloor`, 7.8 MB) to the worker. Quick piece: `BotLifeState` ~636 `parsedColumns`
   keeps a hash + length, not the texts: −8-10 MB main.
6. Income candidate models as one slab per record (if still held): −5 MB. One slab per table, not many
   small typed arrays (~150-200 B per backing store).
7. Main-sized memos and kit profiles (or the worker publishes the survival floor): −15-20 MB main.
8. AfkTrade shop projections as compact rows, Actor built when a player is near: −15-25 MB main.
9. Worker datapack: only what it reads: −8-12 MB per shard.
10. Main boot peak: heap dump at ~2× steady, then page the warm-up work: −200-400 MB rss after boot.

## Budgets and what to watch

1731 bots (afterGc / committed / external MB; alarm on afterGc): main ≤ 340 / ≤ 650, boot peak ≤ 800, 60-min growth
≤ 0.3 MB/min (alarm 400); worker ≤ 300 / ≤ 600 / ≤ 70 (≤ 40 after 1) (alarm 400 = 78 % of old gen); clan ≤ 100 / ≤ 260
(≤ 130 after 2); small threads ≤ 15; geodata ≤ 200; rss ≤ 2.05 GB in the window (≤ 1.85 after 1-2).
5k after 1-9: worker per 2500-bot shard ≤ 300 / ≤ 600 / ≤ 40 (or one worker ≤ 480 with old gen 1024); main ≤ 450 /
≤ 800, boot peak ≤ 1000; clan ≤ 130 committed; rss ≤ 3.0 GB.
Perf report/compare: one line per thread (afterGc start → end (max), used, committed, external, limit old+young, % of
old gen; workers' timeline needs external/limit/afterGc from WorkerHeapTelemetry), an rss breakdown line (never
`arrayBuffers`), per-bot KB, worker GC pauses by kind. Always-on `caps=` status segment: evictions at RETAIN_LIMIT,
SOLO_SEARCH_LIMIT, kitProfiles, SpotValueTable, SpotRewardExpectation, C4SkillRules clears, FORMING_HOLD_LIMIT,
occupation card count, clan worker restarts. limits.md rows: main heap (no cap, OOM aborts), clan heap, worker external,
geodata arena, kitProfiles cap, population clamp 2000; worker heap row "binds at" rewritten with the numbers above.
