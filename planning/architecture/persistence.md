# Persistence and long-lived systems

Checked at 9d6bf579a (2026-11-10).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift; search by name.
Scope: `src/Database*`, `src/History*`, journals, `Persistence/`, `database/sql`, saved games, Clan, ClanHall, Social,
Quest, Progression, class change, Items/Inventory/Warehouse, Knowledge, `data/` generators.

## Mechanisms

- **World DB** `src/Database.js` (12.0k lines, ~195 methods): one `node:sqlite` connection, WAL, every call through one
  promise queue (`enqueue`, `run`, `performTransaction`); its drain gives the event loop a turn after 12 ms of jobs,
  never inside one, so order and atomicity hold. Also holds game rules (clan join, AFK board, quest steps,
  NPC baskets, cold commits).
- **Schema:** `database/sql/sqlite.sql` re-run on every start + numbered migrations 1–83, then 8 named ones (PER-5; at ca97a5463), in
  `applySchemaMigrations` (`schema_migrations`, `named_migrations`); some migrations live in modules
  (`PartyCandidateProjection`, `PlayerWarehouse`, `ClanRaidFailureMigration`, `BotClanConversationStore`,
  `DatabaseRecommendations`, `ClanWarRepository`, `ClanWarCombat`, `ClanJoinPenaltyMigration`).
- **Repositories** get injected internals and are merged onto `Database` (`ClanMembershipRepository`,
  `DatabasePlayerWarehouse`, `ClanLevelSpRepository`, `ClanWarRepository`, `DatabaseRecommendations`,
  `ClanAllianceRepository`, `ClanHall/Repository`, trade meetings).
- **Buffered hot writes** `Persistence/CharacterWriteQueue`: per-character field patches (exp, location, vitals, karma,
  item amount) flushed every 750 ms; `withCharacterFlush` flushes before any transactional method, and that method's own job
  first writes what was buffered while it waited in the queue (`CharacterWriteQueue.applyInJob`). One character's
  bad patch never holds back the others: a failed batch is written again per character; a bad value (TypeError,
  SQLITE_CONSTRAINT) drops that patch, any other fault puts it back for the next tick; each is counted (FailureLog).
- **History DB:** second file `<world>.history.sqlite`; world transactions write `history_outbox`, `HistoryWorker`
  moves rows, main deletes them; retention in `HistoryStore`. The same thread writes the decision trace
  (`decisionTrace`, off by default: `Bot/DecisionTrace` → main → `src/DecisionTraceWriter.js`,
  `logs/decision-trace.jsonl`, 8 × 32 MB, 48 h at the retention tick; read by `scripts/trace.js`).
- **Party candidate projection** `bot_party_candidate_projection` (`PartyCandidateProjection`): one row per life row,
  kept by triggers on the life row (stats, account, level, phase, party, activity, spot) and the character (username,
  class, clan); `ordinaryEligible` = a generated bot, not a static craft service, not under a player party takeover.
  Read by party recruitment, the clan candidate trigger, clan recruitment rows, the clan raid roster, clan equipment
  and the clan share cap (`botPopulationUnsafe`), instead of parsing every bot's stats.
- **Journals:** `EconomyJournal` (TEMP triggers sum adena/item flow), `PvpJournal`; one outbox row per flush.
- **WAL checkpoints:** `DatabaseCheckpointCoordinator` + worker (≥ 4 MB, every 5 s); the WAL truncate
  (`PopulationService.runAdaptiveWalReset`) is tried when a passive one finishes (`Database.onCheckpoint`, limits.md),
  during play too, budgeted at the last completed truncate's hold on main's DB queue; a skipped truncate leaves state
  retention its turn. It and state retention (`runStateRetention`, every
  `PersistentStateRetention` statement bounded by a LIMIT on an indexed range or a cursor that resumes next run) are
  admitted by `BackgroundWorkGovernor` (resource `db_maintenance`, refused with a player when the governor is off), their refusals counted in `Database.stats().maintenance.refusals` (`job:reason`, diagnostics off
  too), the truncate's last try in `checkpoint.lastResetAttempt`; both in the perf report. Not `NativeWriteCheckpoint` (a
  revision fence for bot rows).
- **Saved games:** `scripts/saved-games.js` (v2 = world + history file) via the launcher; `DatabaseRestore` installs
  with a marker and rolls back on next init; lock in `scripts/database-access.js`, which also checks a launcher
  update's DB paths and marks its migration phase in the update journal (`beginUpdateMigrations`). The perf window
  runs load a save into their own folder (`scripts/perf/window.js`), the save is never touched.
- **Workers:** none write the world DB. Cold bot worker sends proposals → `commitAndReleaseColdSimulationLeases`,
  `handoffColdSimulationToMain`. Clan planning worker gets snapshots (a job's craft options and warehouse rows cross
  once, with its first plan; the board is kept once, in its `BoardIndex`).
- **Clan progression queue:** `ClanActionService` sends strategy reviews to `goal_plan` and native level payments to
  `contribution`. Disposable wake-ups opt into `Database.enqueueClanAction` coalescing: reuse a pending action of the
  same type for that autonomous clan, merging causes, the highest priority and the earliest due time. Running work is
  retained; completion commands keep their durable keys. `repairClanProgressionQueue` uses the same admission and
  settlement to recover saved duplicates at bootstrap, preserving player orders, leases and cancellation history.
  Main processes at most 64 actions per transaction with an 8 ms budget checked between actions, then yields
  through `setImmediate` and resumes from the returned cursor (limits.md). Admission adds DB lookups per queued
  wake-up; repair runs on main at bootstrap, with no new per-bot step work or worker messages.
  Claim (PR #217): `ClanActionScheduler.select` gives each ready action type a turn (cursor `world_meta`
  `clanActionScheduler:v1`, saved with the lease, refunded on an unstarted release). Debt: it reads every live row and
  writes the cursor per claim (was an indexed LIMIT 1); queue size has no limits.md row.
  Wakes: a timer re-plans every active-strategy clan each `goalReviewMs` 5 min (`ClanActionService` ~655; retries 1-60 s ~590/~659; storage-11); `ClanReviewEvents.changed` causes (member level, a tracked item's presence, warehouse, treasury, auction round, recruitment input, leader SP, membership, raid cancelled, lease end); the board wakes only autonomous level 2 clans, on a change of their proof's offers (`offer_posted`, `proofWaiters`); other offers are read when the clan decides. No `clan_call:duty`: the clan's write holds the member and forming judges it a seeker.
- **Systems:** quests `Quest/QuestService` + 133 scripts → `QuestStep` → `applyQuestStep`; class change
  `ClassTransfer`, `SecondProfession` → `completeSecondProfession`, trees `ClassProgression`; warehouses
  `Warehouse/*`; clans `Clan/*` (69 files); `ClanHall/*`; `Social/*`; `Progression/*`; `Knowledge/*` (runtime);
  generated `data/KnowledgeBase/*.json`.

## Data flow

- **Hot:** cheap fields → `CharacterWriteQueue` → `characters`/`items`. Value-moving operations (warehouse, NPC sell,
  craft, enchant, SA, quest step, private store) → one transactional Database method under `withCharacterFlush`.
  Some still use row CRUD (`setItem`, `updateItemAmount`, `deleteItem`) — PER-1..3.
- **Cold:** `bot_life_state` row is authoritative (level, exp, sp, adena, location, vitals, `inventorySummary`,
  `statsJson`, `mindJson`, `simulationRevision`). A proposal names its revision; stale is refused. Main's raise on a
  far row (`BotLifeState.raiseOnRow`, the one SQL writer of the woken bits, `Situations.delta`) ORs the bits into
  `mindJson` with no read of the rest and moves the revision, so a worker step begun before it rebases; a raise never
  rides a whole-row save (whose mind is fenced by the revision it was built on). A commit also
  writes `characters` in the same transaction (only the moved columns); a resolve copies level, EXP, SP and vitals
  in one guarded UPDATE (`updateCharacterProgress`, nothing written when nothing moved). Items ↔ summary synced both ways;
  a cold commit reads and compares only the stacks its step moved (`InventorySummary.bagChange` `changedItemIds`) while
  the rows still match the stored summary (`bot_items_synced`, named migration `bot-items-synced`: a row per bot written
  by the commit at its `inventoryRevision`, deleted by an `items` trigger on any write of a row the sync reads, raw SQL
  too; a summary moved by another writer leaves it behind), else every stack. An economy step's pending intent
  (`EconomyCommit`, written alone at admission) is a `bot_economy_intents` row (named migration
  `bot-economy-intents`), its completed receipt the stats leaf the step writes; `economyTupleUnsafe` reads the
  newer, and no state holds the intent. Every index on the row costs a WAL
  page per save (SQLite rewrites the entry of every column the UPDATE sets, changed or not), so no index holds
  `updatedAt` except the covering `bot_life_state_party_candidate_projection` (read with INDEXED BY), and the
  whole-row writers (`BotLifeState.save`, the cold commit) set the indexed `accountName`, `characterName`, `phase`,
  `partyId`, `nextResolveAt` only when the row does not hold the value (`HELD_ROW_COLUMNS`, read in the same job);
  `drop-unused-bot-life-indexes` dropped four that nothing read (42 MB/min, 14 % of the WAL). The save patches its
  row-owned stats members (economy receipt, takeover, const session, hennas) back in one `json_patch`
  (`EconomyCommit.preserveLeafSql` members), one pass over the stats text. The writers of the bag summary on the hot
  paths (the cold commit, the bag snapshot after a value move, `BotLifeState.save`) move `inventoryRevision` in
  their own UPDATE (`bagRevisionSet`), so the migration-68 trigger does not write the row a second time.
  A save rewrites the whole row whenever its length moves (almost always), so the WAL per save is the row's size:
  the kit's skill records are saved as their ranks (`SavedSkills`: `[[selfId, level], ...]` when every record is
  its rank's data, else whole), written by `SavedStats.compact` and the kit rebuild, unpacked by
  `SavedStats.body`/`merge` and the raw kit readers (clan candidate trigger, buff seller check, clan member combat);
  a bag item whose name, kind and rank are its template's is saved without them (`InventorySummary.saved`, `t: 1`),
  every reader of the column takes `InventorySummary.read`.
- **History:** outbox in the same transaction → worker moves → main deletes; `readHistory` flushes first.
- **Schema evolution — five mechanisms:** re-run `sqlite.sql`; numbered then named migrations; `maintenance_tasks`
  one-shots; `world_meta` flags; service start-up migrations (`ClanService.migrateAutonomousClanNames`,
  `AfkTradeService.migrateBoardWorld`, `GiranShopDistribution`), plus `cleanZeroAmountItems` every init.
- **Migration numbers collided with upstream** (upstream's migration 67 "numbered after ours", "Early cooldown deployments
  occupied 81"; 74 and 75 run the same function; 83 repairs 81).

## Canonical owners

| Rule | Owner | Status |
|---|---|---|
| SQL access, queue, transactions | `Database.enqueue`, `inTransaction` | single owner |
| Hot field buffering | `CharacterWriteQueue` + `withCharacterFlush` | bypassed (PER-3) |
| Value-moving item operation | one transactional Database method per operation (`sellItemsToNpc`, `buyFromLivePrivateStore`, `applyQuestStep`) | half-migrated |
| Cold persisted state | `bot_life_state` + revision fence | owner |
| Saved row layout (kit ranks, bag items without template fields) | `SavedSkills`, `InventorySummary.saved`/`read` | owner |
| Economy step tuple (receipt in stats, pending intent in `bot_economy_intents`) | `EconomyCommit`, `Database` `economyTupleUnsafe` | owner |
| Join cooldown | `Clan/ClanRules.JOIN_COOLDOWN_MS` | shared; the other C4 clan penalties absent (storage-7) |
| Clan war eligibility | `ClanWarRules.refusal` | one owner for both clans (`declaration` asks it); `canWage` = no own refusal (C4: level ≥ 3, 15 members; a manual declaration skips `MIN_MEMBERS`: storage-8) |
| Clan level Adena cost | `ClanRules.LEVEL_REQUIREMENTS` (player) vs `ClanContributionPolicy.scaledAdenaRequirement` (bots) | two owners (storage-1) |
| Clan warehouse stock change | 7 inline sites in `Database` | none (storage-2) |
| Bag credit inside a transaction | ~30 inline sites; helpers only for AFK trade | none (PER-3) |
| Clan membership | `characters.clanId`; copies `stats.clanId`, roster `memberIds` | three stores (storage-4) |
| Clan-hall visit hot/cold | `ClanHall/VisitPolicy`, `VisitNeed` | shared |
| Death EXP | `Progression/DeathExperience` | shared |
| Karma wash | `Karma.karmaWashForExperience` (hot `karmaLostForExperience`; cold `BotLifeState.prepareResolve`, `Database` `characterProgressStatement` from the stored-EXP gain) | shared; two stores (PER-6) |
| Class eligibility | `ClassTransfer.eligibility` + `ClassProgression` | partly duplicated (PER-8) |
| History rows | `historyOutboxUnsafe` → `HistoryStore.APPLY` | owner |
| Stopped-DB integrity check | `DatabaseRestore.quickCheckDatabase` | shared |
| Generated data | each `scripts/generate-*`; KB checked by `check:knowledge-base` | no manifest |
| Generated KB in memory | `KnowledgeBaseService` `loadData`: one load per data directory, shared by `NativeKnowledgeBase` (NPC dialogs, bot dialogue) and the observer's pages (icons per request). In memory: manifest, skills, item/mob rows for lists and summaries (traits computed once), item sources as mob ids (`itemSourceIndex`), reward groups as one Float64Array (`rewardGroupIndex`): ~6 MB heap + 1 MB typed arrays. Full item/mob/spawn records are read on demand by byte range (`KnowledgeBaseRecords`: ranges scanned at load from the generator's layout, fds held open; the generator replaces files by rename) | owner |

## Problems
Open problems of this area are lines of problems.md (`PER-*` and the census/pass ids it cites).

## Open questions

1. Move player NPC buy and player ↔ bot-store trades to the atomic methods and remove `TradeService` buy/sell?
2. Karma wash: with or without `MIN_KARMA_LOST`? One place for karma? (`MIN_KARMA_LOST` is 0, so "without"; the
   death wash is one rule; one rule since 2026-11-08, PER-6.)
3. Port `giveItem`/`takeItem` quests to `QuestStep.apply`, or accept as legacy?
4. Start-time repairs still needed? What produced zero-amount rows and duplicate stacks?
