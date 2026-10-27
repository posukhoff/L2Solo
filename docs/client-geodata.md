# Client-generated C4 geodata

The 2026-10-26 pack comes from the local C4 client and `m49n/l2mapconv-public` revision `bcc0bd22dbad8f444979718f38a4c7cb67d7ee1e`, with the generator fixes retained in the pack's `tools/` directory. Settings: actor height 48, radius 16, slope 45.5°, climb 2–16, cell size 16, cell height 1. Source packages were hashed before and after generation.

The client has 142 numbered maps. Map `15_21` places its terrain in `15_20` and is excluded. The resulting **141 regions total 714,003,094 bytes**. The retired server pack had 203 regions. Its 61 regions absent from this client had no dependencies in the audited spawns, available teleports, live actors or saved coordinates. The old `15_21` is also excluded from the new installation.

## Installation

Stop the server in the launcher. Preserve the entire existing `data/Geodata` directory outside the project. Install the pack's complete `geodata/` directory as `data/Geodata`, including the hidden `.l2solo-geodata-manifest.json`. Do not overlay new files on the old directory: unexpected regions are rejected.

Run `npm run geodata` to verify the exact region set, sizes and SHA-256 checksums, then `npm run test:geodata` to exercise the installed geometry. Start the server after both pass.

`L2NODE_GEODATA_DIR` selects an external installation. To install a ZIP into an empty directory, set both `L2NODE_GEODATA_URL` and `L2NODE_GEODATA_SHA256`. The ZIP must contain the complete directory and manifest, either at its root or inside one folder. The starter verifies the archive and every region before installing. It has no automatic fallback to the retired pack.

The supplied manifest uses `schemaVersion: 1`, `format: "L2J"`, an optional `profile`, and a `regions` array containing `{region, bytes, sha256}` for every file. Region names have the form `20_22`; hashes are 64 lowercase hexadecimal digits. Do not regenerate the manifest to accept damaged or mixed files.

## Rollback

The local cutover preserves all 203 old regions in `~/L2Solo-geodata-rollback-2026-10-26/Geodata`, with a verified manifest and the previous bootstrap source alongside it. The current starter accepts the rollback manifest without reverting code.

Stop the server, move the active `data/Geodata` aside, and copy the rollback `Geodata` directory into `data/Geodata`, including its hidden manifest. Run `npm run geodata`, then start with the same progression preset.

## Behavior and checks

Navigation enforces reciprocal NSWE, wall clearance, layer changes and virtual obstacles. Shop conversation can cross a low counter on the same floor, using a separate short visibility check. Movement still cannot cross the counter. Approach points require a street side connected to a counter arrival cell; narrow corridors retain independently checked alternative routes.

Integration tests exercise the installed geometry. Protocol conversion, counter-edge tolerance, queues, opaque walls and cross-floor rejection also have deterministic fixtures. Source spawn populations and coordinates are unchanged. Tests retain bounded coverage requirements for historical spawn heights rather than requiring the retired pack's exact values.
