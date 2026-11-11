Night 11-11 00:45-06:30 UTC, from transcripts (per-message usage, deduped by message id):
| | input | cache write | cache read | output | messages | input-equivalent (1 / 1.25 / 0.1 / 5) |
|---|---|---|---|---|---|---|
| subagents (54 transcripts) | 5.3 k | 8.12 M | 305.1 M | 1.70 M | 2642 | ≈ 49.1 M |
| coordinator | 1.2 k | 0.85 M | 251.6 M | 0.37 M | 547 | ≈ 28.1 M |
by role (subagents): implementers cache read 101.2 M / out 0.54 M (864 msgs); verifiers 64.5 M / 0.43 M (556); reviewers 53.3 M / 0.37 M (577); audit 44.6 M / 0.13 M (300); analysis 28.1 M / 0.13 M (171).
median context per message: verifier 114 k, implementer 93 k, reviewer 78 k, analysis 130 k, audit 155 k; coordinator ~460 k.
The night report's "8.35 M subagent tokens" summed the harness `subagent_tokens`, which is the last message's context size, not consumption; resumed agents' values are a later context size, so the sum was neither total nor per-run.
