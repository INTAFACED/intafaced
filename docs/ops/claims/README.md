# Claim locks (`docs/ops/claims/<id>.md`)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Authority (spawn free / not free):** claim-lock files win over `residual-register.json` and over open-PR path collision for _closure_. Open-PR collision still **blocks dual-write** while a PR is open.

## residual-own

**residual-own** = this claim is closed without a further product PR: the tip already satisfies the DoD, with a **checkable proof string** on the claim file (not a vibe assertion).

Required fields:

```md
**status:** residual-own
**proof:** #468 · baseline rows removed · scan exit 0
```

Bad: `already honest` (assertion, not proof).  
Good: `#468 · baseline rows removed · scan exit 0` · `#462 · MinTrade mine_amount gone · gates 16/16`.

Other statuses: `claimed` (live writer), `pr-open` (link required), `merged` (PR number), `retired` (no target path).

Do not hand-edit `docs/LIVE-LANES.md` mid-wave — use these files.

## Close your claim when the PR merges

`claimed`, `pr-open` and `wip` on a `TRK-*` claim **hide that mountain from the free board**. Leave one behind and the next session cannot see real, buildable work — and `freeProduct = 0` is what SWARM-MANDATE reads as "mint Stage-N slices", so an empty board does not stall, it manufactures.

Measured on 2026-08-07: sixteen slices merged in one day, not one claim closed, **twelve mountains hidden** by sessions that no longer existed.

Closing is safe. A claim covers one **slice**; `merged` on a `TRK-` id does not close the tracker row, so the next stage goes straight back on the free board (`claimLockCloses` in `tooling/scripts/swarm.mjs`). `features.mjs` remains the authority on whether the mountain itself is finished.

```md
**status:** merged
**proof:** #1008 merged 2026-08-07 — affiliates Stage-2 members + freeze honesty
**branch:** feat/ops-affiliates-stage2
```

Include **`branch:`**. It is what makes a claim checkable after its session is gone:

```
node tooling/ci/claim-staleness.mjs      # report, exit 0
node tooling/ci/claim-staleness.mjs --strict
```

It lists claims still holding a mountain whose branch is already on main or deleted. It only reports — it cannot tell a dead claim from one whose owner is about to write it back, and a guard that blocks work when it guesses wrong is worse than no guard.
