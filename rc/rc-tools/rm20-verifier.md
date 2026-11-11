# RM-20 verifier (run 3c164d3cc-script-rm20-player-20261111-165035, ~34 min incl. warmup, 30.1 min window, ~1780 bots)
Handles: logs/decision-trace.jsonl, server.log (summary situations= is CUMULATIVE: enemy_met:clan_war 1 -> 2), world.sqlite (interaction_journal, clan_war_*), summary.json .player

## 1 enemy_met
- total 2 (both worker/cold, clan_war, kind outcome=cold), 0 grievance, 0 hot, 0 player-vs-bot, 0 mixed. rate ~0.07/bot-hour... (2 / ~(1780*0.5h)) = 0.002/bot-h
  - at 1794408699206 bot 2001433 Overkill (6000001) vs 2000175 TRELOSpk (6000000), spot 29_3
  - at 1794410094524 bot 2000477 SNakE (6000000) vs 2001286 Zangetsu (6000001), spot 27_-2
- Decided: no resulting fight evidence: 0 pvp journal rows between clans 6000000/6000001, clan_war_combat 0 rows, no enemy_met:started/outmatched/etc counters, pk/pvp/karma of the four unchanged (0). Cold outcome of the two pairs not traced (trace stops at the raise).
- enemy_met:capped cumulative 45 (spots over 36 standing bots): worker-side only.
- Player: enemy_met:player_capped / playerSeen outcomes: none. PerfPlayer1 never met (0 deaths, summary.player.deaths 0, isOnline=1 end, hp 50/80, pk/pvp/karma 0). Alive and visible whole window (hotAvg 63 bots in view, 30 pkt/s).
- Other PvP in window (not enemy_met, clanless bots): 24 attacked + 5 killed in interaction_journal, 0 involve PerfPlayer1; 5 bot deaths by char (spot 29_7/30_6), 14 main + 11 worker deaths total (mostly mobs). 1 bot with karma 240 (Cobra, killed by bot).

## 2 Hall rebuff
- decisions rebuff: 2095 (none 1987, buffer 88, guide 19, hall 1). Hall: 1 decision, bot 2000175 TRELOSpk (6000000) at 1794410048390 after buffs_expired; then moved_by_world (main) 30 s later, earning_spot resumed 29_3 at +32 s. Visit result, buffs received, refusals: not traced (no handle). clan_hall_events has only clan_dues rows (14), none for hall 39.
## 3 ClanPartyHelp
- 0 pleas. request() is called only from BotClanChat struggling_solo/struggling_group (BotClanChat.js:168); no such topic line in the log. Listener precondition was met (PerfPlayer1 online with socket in clan). Party requests in trace are clan_equipment 35/craft_material 17 etc. (bot party board), not pleas.
## 4 Clan chat (BotClanChat diagnostics, recipients=1 = PerfPlayer1)
- 3 lines, 3 bots: Ogon task_hunt x2 (2 lines same clan hunt, different text: "Clan hunt for Sealed Dark Crystal Leggings: heading out with Sombra and DunkelZauber." / "Gathering Sealed Dark Crystal Leggings for the clan with Sombra, DunkelZauber and 1 others."), KOShei goal_adena "Working on an adena reserve before spending more." Rate 0.1/min whole clan, max 2 per bot, no repetition/spam. bot_clan_dialogue_messages 0 (LLM table, n/a).
## Errors
- none: failures worker faults 0, DB errors 0, swallowed 0, afterCommit 0; only warn lines are the "forced inventory cleanup" info. No loop from war/hall/player. player.over: schedule max 479.9 ms > 150 (single spike).
