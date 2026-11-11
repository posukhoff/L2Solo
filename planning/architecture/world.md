# World, movement, runtime loop

Checked at 9d6bf579a (2026-11-10).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift; search by name.
Scope: `World`, `Geodata`, `Network`, `Automation`, `Timer`, `EventLoopTurn`, `DataCache`, `WorldObserver`, `Server`,
`NodeL2`, `Global`, `Packet`, `AuthenticationServer`, town navigation, spots.

## Mechanisms

- **Boot** `src/NodeL2.js`: Global → DB lock → `Database.init` → `DataCache.init` → clan planning worker →
  `compactStackableInventory` → `ClanService.init` → `GeodataEngine.init` → `NpcInteractionGeometry.init` (a pack without verified counter geometry logs why, once) →
  `World.init` → runtimes (recommendations, clan hall) → `BotLifeState.init` (before the boot passes that write life
  rows) → AFK trade, personas, KB warmup → TCP servers →
  `BotManager.init` → `WorldObserver.init` → `DevConsole`. `World.init`: indexes, raid state, `spawnNpcs`, minions,
  grid, day/night, aggro ticker. Pathfinding pool starts lazily (first `request`). The perf recorder
  (`Perf/LiveRecorder`, `[Perf] live`) starts before any worker. Backstop: an unhandled rejection is counted by
  site, the first of each logged with its stack (`FailureLog`, the shared failure rule; status `swallowed=`); an uncaught exception, or any failure before startup finishes, flushes
  `CharacterWriteQueue`, closes the DB and exits 1. Shutdown (`NodeL2` `shutdown`): service drains capped at 10 s,
  then flush + close, forced exit by 16 s (limits.md).
- **Launcher** (`launcher/`, merged from develop): desktop server management, saves, preview releases; starts the
  server through `scripts/start.js` / `scripts/run-server.js` (SIGKILL 20 s / 18 s after a stop request);
  update startup checks the DB paths and marks migrations in its journal (`scripts/database-access.js`).
- **Globals** `src/Global.js`: `invoke`, `utils`, INI layering (default → `L2NODE_SHARED_CONFIG_FILE` → local.ini, or
  `L2NODE_CONFIG_FILE` instead of local), `path.*`. Also holds
  game data: `PEACE_ZONES` circles and `utils.isInPeaceZone`.
- **Network:** `Server.packetReceiver` splits the stream; `Packet/Frame` owns the unsigned 2-byte length both ways
  (game, login, bot sessions; over a frame: refused and counted); `Session.dataReceive` → `Network/Opcodes` →
  `Network/Request/*` (87); out `Packet/Send`, `Network/Response/*`. Auth separate. The packet trace names server packets by the
  `Network/Response/*` file that sends them (`Session` `SERVER_PACKET_NAMES`, kept in step by
  `tests/test_server_packet_names.js`).
- **World singleton** `World/World.js`: user sessions + `CharacterLocationIndex` (and a legacy `World.user.sessions`
  array), `npc.spawns`, NPC grid (6000), `NpcObjectIndex`, `RaidEntityIndex`, and party/invite/bot-chat logic that
  belongs to bots.
- **`World/WorldConstants`:** `CLIENT_VISIBILITY_RADIUS` 6000, `inClientView` ("the one rule of the view"). Worker-safe.
- **Geodata** `Geodata/GeodataEngine`: shared regions, `getHeight`, `hasLineOfSight`, A* `findPath`,
  `VirtualObstacles/*` per town.
- **Pathfinding pool** `Geodata/PathfindingWorkerPool` (≤ 2 workers) → `PathfindingWorker`. Callers: `MoveTo`
  (companions, long routes; town routes through the `TownNavigation.forPool` wrapper), NPC chase (`Npc.fetchCombatPathAsync`).
  A crashed worker is logged and respawned forever after the shared `WorkerRestartBackoff` (the cold worker's rule).
- **Movement — three engines (WOR-1):** players client-driven (`MoveToLocation` → broadcast; `ValidatePosition` →
  `UpdatePosition`); bots server-simulated `MoveTo.startPathMovement`; NPC/summon/pawn `Automation.scheduleAction`/
  `scheduleMoveToCoords`/`startMoveInterpolation`. Wander `NpcWander` is not its own engine: it drives
  `Automation.scheduleMoveToCoords` (and teleports home by `setLocXYZ`).
- **Town navigation (under Bot/AI, but world rules):** `TownPathfinder`, `TownTransitPolicy`, `TownNavigation`,
  `TownTraffic`, `TownNpcApproach` (`canInteract`), `TownNpcSlots`, `TownGateCatalog`, `TownGatekeeperCatalog`,
  `BotTownTravel` (hot town trips), `BotSpotTravel` (hot spot trips), `CompanionTownTransit`. The trip rule (method,
  legs, time, fare) is `Population/ColdTrip` over `Travel/TravelRoutes` + `TripPayment`, read by cold only (WOR-7, town-2).
- **Spots** `Bot/AI/SpotService`: `ensureIndexed` builds spots from `SpawnNpcs.catalogueSpawns(World)`; **without World
  (no `World.npc.definitions`) it returns `[]`** — in the worker that is an empty list, not an error.
- **Visibility:** packet side effects, not a known-list object. `Session.dataSendToMe` hooks (`CharacterVisibility`,
  `NpcVisibility`, `GroundItemVisibility`, clan war); area refresh `UpdateEnvironment` on ≥ 1000 moved (NpcInfo only to a real client: a bot session skips it). No DeleteObject
  when someone walks out of range.
- **Spawns:** `SpawnNpcs`, `RemoveNpc`, `NpcDecay`, `DayNightSpawnManager`, `RaidBossMinionManager`, `RaidBossState`.
  An NPC's model inherits its template (`SpawnNpcs.npcModel`: the row flattened once per frozen datapack row, 2.7k
  for 33k NPCs); every write lands on the NPC's own model. Own-key reads of a model (keys, spread, JSON, clone, a
  worker message) miss template fields and `delete` uncovers them: no code does either; keep it so. Its combat and
  movement parts (`automation`, `attack`, `timer`, hate and skill-reuse maps) are built on first use (`Npc` getters);
  a read that only looks (hate, reuse, a walk to resume) builds none. `state` stays eager: scans near hot actors read it.
- **Timers:** no central scheduler. `Timer.js` (reads Node internals `_idleStart`/`_idleTimeout`, used by Automation only), `EventLoopTurn`
  (setImmediate yield), tickers: `NpcAggro` 1 s (also drives wander), `EffectTicker`, `PopulationService` (6
  intervals), per-session `moveTimer`.
- **DataCache:** frozen datapack; two lookup styles.
- **WorldObserver:** dev HTTP UI (3.2k lines), reads World, DB, bots; own town list. Its knowledge pages read the
  game's one loaded KB (`KnowledgeBaseService`, persistence.md); its detail calls are uncached (one mob/spawn read
  from disk per `npcDetail`).

## Data flow

- **Player move:** client 0x01 → `PlayerMoveDestination` (Z only) → `MoveTo` checks → broadcast. **No server path for
  players.** 0x48 `ValidatePosition` → `UpdatePosition`: set loc → `CharacterWriteQueue.location` →
  `updateEnvironment` → companions → replay stored actions. Every `setLoc*` updates the World index.
- **Bot move** (`MoveTo`): nearest real player by raw scan → low-LOD warp if nobody can see either end → town egress
  replay | worker path (companion or `maxNodes` > companion cap; a short LOS hop goes `short_direct`) | **sync
  main-thread `findPath`** (the rest) → fallbacks `TownPathfinder`, then straight LOS line, else no move. Segment loop on 100/250 ms with Z snap and `TownTraffic.steer`. Bots skip
  `updateEnvironment` while moving; their aggro comes from the 1 s ticker.
- **NPC chase:** worker path → `Automation.scheduleMoveToCoords` (linear, no Z snap) → `scheduleAction` approach.
  A request with no usable way (an empty path, one the target outran by 120, a pool error; `Npc` `pathFailed`, counted
  `noPath`) retries after 0.5/1/2/4 s; the mob keeps hating until the 2 min attack timeout drops that target (Lisvus).
- **Broadcast:** `dataSendToMeAndOthers` → `World.fetchVisibleRealPlayers` (the index's real-player cells +
  `inClientView`; no hot bot is walked); bots `BotSession.dataSendToOthers` (real sockets only). NPC vitals
  (`BroadcastVitals`): the same query cut to 3500, one StatusUpdate for all (C4 informs the players targeting it).

## Canonical owners

| Rule | Owner |
|---|---|
| Is visible | `WorldConstants.inClientView` |
| Who is near | `World.fetchVisibleUsers/fetchVisibleRealPlayers/actorSessionsNear/nearestRealPlayer` |
| NPC by id / near a point / nearest of a template | `NpcObjectIndex.find` (`World.fetchNpc`) / `World.fetchNpcsInRadius` / `NpcObjectIndex.nearestOfTemplate` (town service targets) |
| NPC add/remove | `World.addNpcToGrid/removeNpcFromGrid` + `World.removeNpc` |
| Height, LOS, A* | `GeodataEngine`; off-thread `PathfindingWorkerPool` |
| Bot movement | `MoveTo` |
| NPC/summon approach | `Automation.scheduleAction` |
| Player position | `ValidatePosition` → `UpdatePosition` |
| Bot talk-to-NPC | `TownNpcApproach.canInteract` (player: `AttackRange.TALK_RANGE` 36) |
| Spawn/respawn | `SpawnNpcs` + `RemoveNpc` |
| Ground items: add, take, a party's drops by leader | `World/GroundItems` (`put` from SpawnItem, `take` from PickupItem; `ownedBy` read by the party loot scan) |
| Event-loop yield | `EventLoopTurn` |
| Process failure backstop, shutdown order | `src/NodeL2.js` (`shutdown`, `writeFinalState`; failures through `src/FailureLog.js`) |
| Is a bot | **none** (WOR-3) |
| Town identity | **none** (WOR-6) |
| A bot's trip (method, legs, landing, time) | **none**: cold `ColdTrip.spotPlan`/`townPlan`; hot `BotSpotTravel`, `BotTownTravel` (WOR-7) |

## Problems
Open problems of this area are lines of problems.md (`WOR-*` and the census/pass ids it cites).

## Open questions

1. Should NPC, summon and bot movement converge on one engine (MoveTo segment loop or Automation)? Players stay
   client-trusted (no server path check)? — decided 2026-11-03, see WOR-1.
2. All hot-bot A* through the pool, or sync for short routes on purpose?
3. Actor-publication pipeline (WOR-5): coming back, or delete with its tests? — decided 2026-11-03: delete (WOR-5).
4. Which "is a bot" predicate is the one?
5. Single owner of "town" (center, polygon, peace zone, respawn)? Towns are the C4 town outlines (Lisvus `townZones.xml` → `data/World/c4_town_zones.json`, `scripts/generate-c4-town-zones.js`), each with its `peace` flag (Floran is PvP-open, Lisvus; AFK trade opens in any town zone); center and respawn still have their own copies (WOR-6).
6. Player talk range and bot `canInteract`: one rule?
7. Town navigation: move under `Geodata/`/`World/`, or stays bot-owned?
