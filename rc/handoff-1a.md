# Handoff: release 1a (11-11, after V5.1 stabilization)

State: fork `ivan/batch-1a` = 95a12356b; workflow `ivan/workflow-v5.1` = da25f2b85, frozen (reports/workflow-v5.1-stabilization.md, reports/tools/token-usage.py). Night report: `ivan/workflow-v5.1-pilot` reports/workflow-v5.1-pilot.md. Local planning current (roadmap 1a rows, problems.md, architecture/findings-1a.md). Nothing in origin.

Next task (critical): DT-247/DT-248 "what in the bag is spare" has no single owner.
- DT-247 verified: after a buyer's funding_short (marks nothing; ColdMarketService ~881-899) the build alternates with a sale step that EconomyContext.saleSpent (397-408) refuses at once, because ItemDisposition.retryKinds (304-324) counts crystals/craft inputs that WishProviders.liquidationCandidates (1580-1592) excludes. Run 1a7619d3e: bot 2000465, 92 refusals in 40 s; B 178 flips / 1a 59.
- DT-248 unverified: bought D crystals still reach the bot's own sell line (2000465, 2001694; 1,971 units round-tripped vs 264 in B). Suspect MarketPricing 58-64 (reservation capped by the free bag, candidates on bag+escrow). DT-242 (95427f498) fixed only the card reservation.
- Readers deciding spare units: ItemDisposition, WishProviders.liquidationCandidates, EconomyContext.saleSpent, MarketListingPolicy.evaluate, MarketPricing, CraftInputReservations.
- Plan: read-only planner (all copies hot+cold, detail-trace one looping bot to settle DT-248) → one owner (ItemDisposition) read by build, sale step, listing, pricing; funding_short leaves a mark → implement → review → traced quiet run (no local tests during it).
- Data: runs tmp/perf/runs/1a7619d3e-script-online-player-20261111-070521 (QUIET2), 242299cf8-...-052400; verifier notes were in the old scratchpad (loop1458, loop1785) — may be gone.

Then: DT-231 rest, RA1-2, RA3-2, RA3-3, RM-20, DT-238; full CI on the final head; final A/B after code freeze (cold 30 min with player + hot 20 min, sequential, vs 9d6bf579a and 21ef29385, save d2f4aa5d).

Process (V5.1 as stabilized): stack only on reviewed+green; CI after a passed review; .claude/ci-dispatch.sh; record-land --remote fork --branch ivan/batch-1a; record-rebase carries the review on equal patch-id only when the base left the task files unchanged; reports ≤ 250 words; fix round = new narrow agent; Sonnet for low-risk mechanical work; freeze policy docs while records are open; coordinator hands off past ~200 k context.
