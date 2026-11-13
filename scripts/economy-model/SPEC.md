# Economy model: what a bot decides

This file states the rules of the model's decision layer: what a hunter ("main") and a crafter ("twin") decide in design mode. The snapshot (inputs.js), kit hours, the event engine, the ledger and its closures and today mode are not rebuilt from it. No new decision code without a row here.

How the rows read:
- Every normative row is a line of a table that starts with its id in backticks. spec-rows.js reads these lines; a person reads plain tables.
- A table with a `kind` column holds levers; a table with a `fact` column holds situations.
- status is one of: `planned`, `built`, `old`.
  - planned: no code follows the row yet as written; for a situation or a lever, rules/levers.js holds no id for it (today's code may do a part of it outside the registry).
  - built: the code follows the row as written; a situation or a lever has its id in rules/levers.js; the test cell names the case that pins it (`<test file>: <case>`).
  - old: a lever today's code does before the decision layer exists, not in the row's form; rules/levers.js points at the function that does it until the lever is rebuilt to its row or deleted. For a situation: today's code names it outside the frame; rules/levers.js points at that function until the slice that builds its levers rebuilds it.
- tests/test_economy_model_spec.js holds the situation and lever rows marked built or old equal to the ids of rules/levers.js.
- A C4 source marked "not verified" is from memory and is checked on l2hub C4 or the Lisvus datapack before its row is built.

## 1. Form of the decision layer (the reason holes become visible)
| id | rule | status | test |
|---|---|---|---|
| `FORM.1` | A situation is a physical fact of one bot (held shots under the reserve, bag full, arrived in a town, a line of mine sold). No price, clock, board or another decision's answer inside it. | planned | — |
| `FORM.2` | For each situation the spec lists its levers in order. A lever is a pure function of the bot's own view: it returns an action, or "no" with a named reason. | planned | — |
| `FORM.3` | Levers are of two kinds. FREE levers cost no hunting time (a shout in trade chat, a whisper): every one that applies is taken. MOVE levers take the bot off its spot (a trip): at most one is taken, the first in order that returns an action; with none, the bot stays at its spot in the state the row names (hunting without shots). So a bot can shout WTB, keep hunting without shots and walk to a seller once one answers. | planned | — |
| `FORM.4` | The run counts, per situation and lever: taken, and refused by reason. This is the lever report; a lever that never fires, or a situation that ends in "hunt without" most of the time, is a printed line, not a discovery. | planned | — |
| `FORM.5` | No situation may have "wait" as its only lever unless the row states why a C4 player would also wait. | planned | — |
| `FORM.6` | One test holds the code's situation and lever list equal to this file's rows. | built | test_economy_model_spec.js: a row or a lever on one side only fails with its id |

## 1a. A bot's time
| id | rule | status | test |
|---|---|---|---|
| `TIME.1` | At any moment a bot is in exactly ONE state: hunting at its spot; on the way (walk or gatekeeper hop, hours from the route); in town (the visit's time); resting or dead time the hunt cycle already holds. | planned | — |
| `TIME.2` | The hunt credits only hunting hours. | planned | — |
| `TIME.3` | The run prints hours per state per band. | planned | — |
| `TIME.4` | Shot coverage = shots fired over shots wanted in HUNTING hours. | planned | — |
| `TIME.5` | The cost of a trip is its hours on the way and in town (lost hunt), printed beside it. | planned | — |

## 2. What a bot knows (one rule for shots, gear, materials)
| id | knowledge | how it is gained | how it ends | status | test |
|---|---|---|---|---|---|
| `KNOW.PRIOR` | Prior: which towns are the trade towns of a grade; NPC lists and prices; gatekeeper fares; walking hours | given at start (a C4 player reads a guide) | never | planned | — |
| `KNOW.SEEN` | Seen: the sellers and buyers standing in a town (who, item, price, units) | the bot stands in that town (hot: runs through the market; cold: the visit's time) | replaced whole at its next visit to that town; one row ends when a whisper to that seller gets "sold" or no answer | planned | — |
| `KNOW.HEARD` | Heard: trade chat (WTS and WTB shouts) | a shout made in the bot's region while the bot is in that region | as a seen row | planned | — |
| `KNOW.TWIN` | Own twin: its stock, seat, lines | always (same player) | never | planned | — |
| `KNOW.UNSEEN` | Not known: any line in a town it has not visited and has not heard. The live books of all towns are not read. | never gained without a visit or a shout heard | as a seen row, at the visit or the shout | planned | — |

## 3. Hunter
### 3.1 Shots low (held < the reserve of the next outing) and shots out (held 0)
| id | actor | fact | levers | status |
|---|---|---|---|---|
| `H.SIT.SHOTS_LOW` | hunter | held shots under the reserve of the next outing | F1, F2, M1, M2, M3, S in that order (the target order: M0, old, stands after M1 and M3 until it is deleted). Not a lever: paying above worth (worth is the break-even price). | old |
| `H.SIT.SHOTS_OUT` | hunter | held shots become 0 (running out is one situation) | F1, F2, M1, M2, M3, M4, S in that order (the target order: M0, old, stands after M1 and M3 until it is deleted). Not a lever: paying above worth (worth is the break-even price). | old |

| id | situation | kind | lever | condition | waking event | C4 source | status | test | counter |
|---|---|---|---|---|---|---|---|---|---|
| `H.SHOTS.F1` | H.SIT.SHOTS_LOW, H.SIT.SHOTS_OUT | free | Shout WTB at its worth in the region it stands in (from the field too) | nothing known at or under worth | the situation; a town visit of another cause while short, after it looks at the market (updates "seen") | WTB in trade chat | planned | — | lever report |
| `H.SHOTS.F2` | H.SIT.SHOTS_LOW, H.SIT.SHOTS_OUT | free | Whisper a known seller (seen or heard), ask ≤ worth; the seller holds the units for this buyer | a known row at or under worth; purse covers units + way | the situation; a town visit of another cause while short, after it looks at the market (updates "seen") | not verified: whisper "keep 5k shots, coming" | planned | — | lever report |
| `H.SHOTS.M1` | H.SIT.SHOTS_LOW, H.SIT.SHOTS_OUT | move | Go to own twin | twin holds the shot; way payable or walkable | the situation; a town visit of another cause while short, after it looks at the market (updates "seen") | ours: the twin is the model's stand-in for a player's second character | old | — | none per lever yet |
| `H.SHOTS.M2` | H.SIT.SHOTS_LOW, H.SIT.SHOTS_OUT | move | Go to the seller that holds its units (F2 answered, or a crafter answered F1) | a held deal | an answer to its whisper or its shout | not verified: a seller holds units for its buyer | planned | — | lever report |
| `H.SHOTS.M3` | H.SIT.SHOTS_LOW, H.SIT.SHOTS_OUT | move | Go to the NPC that sells it at or under worth | prior knowledge | the situation; a town visit of another cause while short, after it looks at the market (updates "seen") | not verified: grocer sells no-grade shots | old | — | none per lever yet |
| `H.SHOTS.M4` | H.SIT.SHOTS_OUT | move | Go and look once: the trade town of the grade it has never seen, else the one seen longest ago; if nothing there, F1 is shouted there and it returns to its spot | at the moment it runs out (held becomes 0), nothing known, no deal; one look, not a loop | held becomes 0 | not verified: runs to Giran and looks | planned | — | lever report |
| `H.SHOTS.S` | H.SIT.SHOTS_LOW, H.SIT.SHOTS_OUT | stay | Hunt without shots at its spot; hours counted. A bot back from an empty town hunts without shots until an answer to its shout or a town visit of another cause; no "look again after N" | no move lever taken | no move lever taken | not verified: hunts on without shots | old | — | hours in S (lever report) |
| `H.SHOTS.M0` | H.SIT.SHOTS_LOW, H.SIT.SHOTS_OUT | move | Go to the cheapest seller town read from every trade town's book; deleted when F2 and M2 are built | after M1 and M3: a line of the shot at or under worth in the town it stands in or a trade town of the shot's grade and above, whose gatekeeper fare there and back the purse pays; the town it stands in, else the one with the least fare | the situation's hour, or any later event while low or out | none: it reads towns the bot has not seen (against the KNOW rows) | old | — | none per lever yet |

| id | rule | status | test |
|---|---|---|---|
| `H.SHOTS.WAY` | The way: gatekeeper if the purse covers it there and back with the purchase; else walk (hours); else sell the bag in the nearest town first. | planned | — |
| `H.SHOTS.HOLD_END` | A held deal ends at: the buyer's arrival (bought), its death, its trip changed, the seller's line withdrawn. No timer. | planned | — |

## 4. Crafter (twin)
### 4.1 What wakes it
| id | actor | fact | levers | status |
|---|---|---|---|---|
| `T.WAKE.1` | crafter | its main arrived | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.2` | crafter | a line of its sold | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.3` | crafter | a batch ended | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.4` | crafter | it hears a WTB in its region | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.5` | crafter | it receives a whisper in its region | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.6` | crafter | its shelf of a product is empty | T.CRAFT.1 to T.CRAFT.4 in that order | planned |

### 4.2 What to craft next
| id | situation | kind | lever | condition | waking event | C4 source | status | test | counter |
|---|---|---|---|---|---|---|---|---|---|
| `T.CRAFT.1` | T.WAKE.1-6 | not stated | What its own main needs | recipe, materials | a T.WAKE situation | none named | planned | — | lever report |
| `T.CRAFT.2` | T.WAKE.1-6 | not stated | What was asked: whispers held, then WTBs heard in its region at or above its cost | recipe, materials | a T.WAKE situation | none named | planned | — | lever report |
| `T.CRAFT.3` | T.WAKE.1-6 | not stated | What sold since its last batch, up to the shelf target | recipe, materials | a T.WAKE situation | none named | planned | — | lever report |
| `T.CRAFT.4` | T.WAKE.1-6 | not stated | Nothing: MP stays | no demand heard at or above cost | a T.WAKE situation | none named | planned | — | lever report |

### 4.3 Where it sits
| id | rule | status | test |
|---|---|---|---|
| `T.SEAT` | The trade town of its main product's grade (prior knowledge). It moves when its product changes grade. | planned | — |

### 4.4 Its price
| id | rule | status | test |
|---|---|---|---|
| `T.PRICE` | Ask: first price from cost; falls a step when a batch ended with the shelf unsold and no sale since; rises a step when the shelf emptied before the batch ended; never under cost. | planned | — |
