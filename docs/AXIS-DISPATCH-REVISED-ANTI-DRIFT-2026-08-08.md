> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Revised five dispatches — anti-drift pass (2026-08-08)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** C1 is **executing in-repo** (not paste-only). Holds the five C1–C5 briefs that the axis planner planned to release after Nitro’s full green light, revised after a four-lane anti-drift audit, then **re-verified at tip 2026-08-08** (errata below).

**Parent session:** Code session `bbaab7e1-2319-432c-ba6f-0c97cf7bb44d` (axis planner). Died mid-synthesis on org subscription disable; four subagent reports completed, two parents failed. Synthesis completed here from those reports + live re-check.

**Plan home:** [`docs/AXIS-IMPROVEMENT-PLAN-2026-08-08.md`](AXIS-IMPROVEMENT-PLAN-2026-08-08.md) · PR [#1090](https://github.com/Phantom-X-007/intafaced/pull/1090)

**Nitro green light (session):** all seven decisions yes — money wave for trading/marketplace, release his name on the listed rows including `pay.gateway`, customer-platform alerts, staging host (purchase still his), money audits, docs count-fix not move, schedule worktree GC.

---

## What the anti-drift pass found (plain)

| Dispatch        | Verdict                    | One-line fix                                                                                                                                                                                                    |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 board**    | RISKY / half invents wave  | Money allowlist **is** the wave-open act (already approved). Fill `requires` **first**. Leave `trade.forex` out of the allowlist (horizon **LAW**). Extend `sync-github-issues.mjs`, do not write a new closer. |
| **C2 customer** | Mostly clean               | Cite Phase C / leverage path; do not invent a NOTICE generator; do not add jars to force compile.                                                                                                               |
| **C3 money**    | **Violates as written**    | Do **not** build a new reconciler — extend `svc-ledger`’s existing one. Audits first. Custody-side definition is Class **X3** if still unset.                                                                   |
| **C4 shipping** | **Invented deploy policy** | **ADR first.** `workflow_dispatch` only until branch protection (G1). No deploy-on-merge-to-main. No host yet → capability is file + recommendation, not go-live.                                               |
| **C5 estate**   | **Violates as written**    | Do **not** build a second blocker report — widen `swarm.mjs` socket filters + use `BOARD-CLEAR-HUMAN-BLOCKERS.md`. Never unattended `wt:gc --apply`. Do not touch `value-gate` thresholds.                      |

**The earlier “apps/web was built when the vendored exchange already existed” framing is false on chronology** — `apps/web` landed two days _before_ the vendored tree. Real failure modes: assessment treated as decision; work continued on scaffold after superior product arrived; decision lived only in ADR for a day and craft still landed in the retired path.

---

## Shared block — paste at the top of every coordinator brief

```
LEVERAGE LAW — before first product edit (docs/INTERNET-LEVERAGE-LAW.md §2):
1. Phase A audit: name the in-repo asset for this work.
2. Full-horizon: find your tracker id row and path letter.
   Map is STALE — 15 open ids have no row. No row = say "unmapped", do not assume IN.
3. LAW = Denon first. S = Shehzad only. X = human; never close it as agent-done.
4. PR body names the leverage used, or one line justifying greenfield.
5. About to write a second shell, second book, second reader, or second report? Stop.
Run `pnpm claim:check <your paths>` before the first edit.

Shared zone (nobody owns; everyone appends carefully): tooling/tracker/features.mjs,
docs/TRACKER.md, docs/LIVE-LANES.md, docs/ops/claims/**, and swarm-generated FREEZE-LIVE /
DASHBOARD / R00 / R01 / R02.

Standing fences for all five:
- Do not touch docs/audit/2026-08-08-* (finished record).
- Do not implement services/svc-protocol or protocol./chain./launch./mining./bridge. (Shehzad).
```

---

## C1 — the board

```
You are coordinator C1 in docs/AXIS-IMPROVEMENT-PLAN-2026-08-08.md (+ anti-drift:
docs/AXIS-DISPATCH-REVISED-ANTI-DRIFT-2026-08-08.md). You own A5 (A1 follows). Nitro green-lit.

LEVERAGE LAW block from that doc — paste it first.

Order (do not reorder):
1) Fill features.mjs `requires` for trade.ccxt-api, p2p.merchants, market.vendors, venue.aggregation
   from the paths their own specs name. MUST land before any money allowlist change — empty
   requires makes claim-check/swarm hand workers a .md path so collision detection misses live
   services/svc-trade work.
2) Open the money wave as a hard allowlist of EXACTLY these ids (Nitro wave open):
   trade.ccxt-api, venue.aggregation, p2p.merchants, market.vendors
   Do NOT include trade.forex — horizon path is LAW (wait Denon). Do not generalise the list.
3) Delete dead MONEY_TRACKER_RE / WAVE1_EXCLUDE decoys only if zero call sites; update
   swarm.mjs worker-paste + docs/ops/SWARM-MANDATE.md:46,52 in the same PR so "closed" and
   the allowlist cannot disagree. Append one row to docs/BOARD-CLEAR-DECISION-LOG.md.
4) Issue closer: extend tooling/scripts/sync-github-issues.mjs (already has gh(), --dry-run,
   [id] title map). Do not write a new script.
5) Owner release (Nitro): remove owner "Nitro" only from rows that are ready/wip per plan
   (pay.gateway, infra.i18n, trade.mm-bot, ops.admin, trade.copy, trade.algo, web.terminal,
   ws.gateway, academy.ambassadors). Leave socket.dex-venue-set owned — deliberate decision
   seat, not unclaimed engineering.

Fence: tooling/scripts/swarm.mjs, tooling/ci/claim-check.mjs, tooling/ci/claim-staleness.mjs,
docs/ops/SWARM-MANDATE.md, docs/ops/trk/**, GitHub issues, tooling/tracker/features.mjs (shared).
Forbidden: services/**, vendor/**, docs/audit/**, .github/workflows/**.
pnpm claim:check before first edit. One service/path-cluster per PR (reviewability — Actions thrift deleted 2026-08-07).
```

---

## C2 — the customer surface

```
You are coordinator C2 in docs/AXIS-IMPROVEMENT-PLAN-2026-08-08.md (+ anti-drift doc). Own A2
and dependency half of A7. Nitro green-lit.

LEVERAGE LAW block first. Path already assigned: Phase C §2 (EXT · NOW · owner N) —
Dependabot + OSV/Trivy/Grype + actionlint/zizmor. Cite that row; work ext-infra-adopt lane.
Also implement ADR docs/adr/2026-08-04-java-dual-book-residual.md "What done requires" items
2–3.

Do:
1) maven ecosystem entry in .github/dependabot.yml for both pom roots — grouped, weekly, low
   PR limit, majors ignored (match existing file's review-capacity rationale).
2) vendor compile job continue-on-error: true, only on PRs touching vendor/**. Proves source
   compiles; nothing else. If a compile error would require adding/vendoring/publishing a jar,
   STOP and record it — ADR reserves that for the owner ("Do not add a jar to make something boot").
3) NOTICE: no generator exists. Hand-update only if you can name exact missing attributions;
   never rewrite or transliterate upstream LICENSE/NOTICE (docs/LICENCE-POSITION.md).

Fence: vendor/**, .github/dependabot.yml, .github/workflows/supply-chain.yml, new vendor
workflow, NOTICE.
Forbidden: services/**, tooling/scripts/**, docs/ops/**, docs/audit/**.
pnpm claim:check before first edit.
```

---

## C3 — money correctness

```
You are coordinator C3 in docs/AXIS-IMPROVEMENT-PLAN-2026-08-08.md (+ anti-drift doc). Own A4
and review half of A7. Nitro green-lit and released claims on svc-trade / svc-pay when C1 lands.

LEVERAGE LAW block first.

CRITICAL — do not rebuild:
- A reconciliation job ALREADY exists: services/svc-ledger/src/ledger/reconcile.ts (hourly
  scheduler, freeze-on-failure, admin endpoint). Shape = add a fourth check + one field on
  ReconciliationReport when custody side is readable — implement Accepted ADR
  docs/adr/2026-08-04-cross-plane-bridge-accounting.md (D-S-12): compare, halt on divergence,
  halt when a side is unreadable, never continue-and-alert. Never cache external figure as a
  balance (doctrine §0.6).
- No custody balance reader yet — add balanceOf to CryptoChainPort only if audits prove need.
  ops.custody on-chain half and socket.price-oracle are shehzad002 — read, do not build.

Order:
1) Promise-falsification audits first and independently (svc-trade → svc-pay → svc-identity),
   each finding as test or tooling/ci scan. May kill the reconciliation premise before you
   extend it.
2) Only after audits: either (a) one narrow ADR if "what custody is reconciled against / what
   mismatch does" is still unset — Class X3 if real keys; or (b) the fourth check if the ADR
   already answers it.
3) Do not invent custody product law. AGENT_PROTOCOL §0: never guess on money, custody,
   jurisdiction.

Fence: services/svc-{trade,pay,identity,agents,notify}/**, packages/ledger-client/**,
services/svc-ledger/**, docs/audit/2026-08-09-* onward, tooling/ci/*-scan.mjs.
Forbidden: vendor/**, tooling/scripts/swarm.mjs, docs/ops/**, .github/workflows/**,
docs/audit/2026-08-08-*.
pnpm claim:check before first edit. Class M self-audit + second-pass on money PRs.
```

---

## C4 — shipping (held as capability until host; ADR + parameterised workflow allowed)

```
You are coordinator C4 in docs/AXIS-IMPROVEMENT-PLAN-2026-08-08.md (+ anti-drift doc). Own A3.
Nitro green-lit a staging path; host purchase is still his Class X money act.

LEVERAGE LAW block first. Phase A: "Existing Dockerfiles — rebuild not redesign."

YOUR FIRST PR IS AN ADR. Do not open a workflow file before that ADR is merged.
Doctrine already decides: §1 Kubernetes for prod (staging host ≠ prod path — say so);
§9 secrets via vault (GitHub Actions secrets = named deviation); §11 drop sequence is config
not deploy risk (core.drop-flags still a counted gap); §14.6 kill-switch ≠ image-tag rollback.

After ADR merges:
- Consume Dockerfile + docker-compose.apps.yml as they are. Start from
  tooling/ci/compose-secret-parity.mjs, not a blank workflow.
- workflow_dispatch ONLY until OWNER-GITHUB-CONFIG G1 (branch protection) is set.
  Do NOT wire deploy-on-merge-to-main (G5: operator and swarm share one identity).
- APP_ENV=staging is fail-closed policy (sanctions + rail sandbox rules). Setting APP_ENV=dev
  on a reachable staging host to make it boot is FORBIDDEN.
- Real staging credentials = Class X2 → append BOARD-CLEAR-HUMAN-BLOCKERS.md; keep shipping
  the parameterised workflow; do not invent placeholder secrets.
- Come back with provider/size recommendation. No host → you ship a file + ADR, not a live deploy.

Fence: new .github/workflows/deploy.yml (after ADR), Dockerfile, docker-compose*.yml, tooling/infra/**,
docs/adr/** for the deploy ADR.
Forbidden: services/*/src/**, vendor/**, docs/ops/** (except HUMAN-BLOCKERS append).
pnpm claim:check before first edit. Respect open PRs holding .env.example / compose.
```

---

## C5 — the estate

```
You are coordinator C5 in docs/AXIS-IMPROVEMENT-PLAN-2026-08-08.md (+ anti-drift doc). Own A6,
A8, A9. Nitro green-lit.

LEVERAGE LAW block first. Do NOT build a second report machine.

A9 first (what he asked for):
- Widen coverage of EXISTING swarm/tracker output so socket rows appear on the human ladder —
  swarm.mjs filters ready&&!owner and tracker subtracts sockets from the denominator.
  Report basis from features.mjs + coverage.yaml; never re-decide socket basis; never edit
  features.mjs from a reporting script alone without mountain event rules.
- docs/ops/README.md already names BOARD-CLEAR-HUMAN-BLOCKERS.md as the one blockers inbox
  ("not a second file"). Prefer extending that surface / swarm:lanes over a new script.
  If you must add a thin printer, it is read-only derivation, fails open, never a gate.

A6: fix how documents are counted in reports only (exclude docs/ops/claims, slices, trk) and
add two lines to docs/ops/README.md naming them as state directories. MOVE NO FILES.
If a change would touch tooling/ci/value-gate.mjs thresholds — STOP (AGENT_PROTOCOL §3 never
weaken a gate). Append DECISION-LOG row for the counting change.

A8: schedule worktree-gc with --check only on any automation; --apply stays workflow_dispatch
or human-attended. worktree-gc is local-machine (git worktree list) — GitHub cron cannot run
it meaningfully. Never unattended --apply (known high-severity risk path in that script).

Fence: docs/** except docs/audit/**, docs/ops/trk/**, SWARM-MANDATE, shared zone;
tooling/agent-protocol/**, tooling/scripts/worktree*.mjs, tooling/scripts/swarm.mjs only for
socket-filter widen if required for A9.
Forbidden: services/**, vendor/**, docs/audit/**, value-gate threshold edits.
pnpm claim:check before first edit.
```

---

## What no machine can catch (honest list)

These recurred in ADR/docs forensics and still have no full machine guard:

1. **Ritual compliance** — CI only proves leverage law _text is present_, not that an agent _ran_ the pre-code ritual. Checkbox in PR template is unread by any scan.
2. **Assessment read as decision** — status-line "Assessment / Decision is the repo owner's" still drove days of craft (`apps/web` path).
3. **Decision living only in an ADR for a day** — craft landed in a retired path until SWARM-MANDATE prose existed; no path-block CI for `apps/web/**` (directory gone is the real guard).
4. **Promise as interface / scan proves symbol, not execution** — gate can go green on code that never runs; worst form: honest red record deleted to green a gate.
5. **Scanned source ≠ running binary** — vendor Java residual; dual-book scan green while jars unbuilt.
6. **Stale hold obeyed** — cost is idle capacity, not broken holds (Class M hold language incident).
7. **Recommendation mistaken for decision** — dual-book sat "in progress" three days across eleven docs.
8. **Owner-gated product numbers with no D-S id** — agents stall or invent; horizon map missing ~15 rows.
9. **Locally correct layers, silent global drift** — market-id authority class; two sources of truth disagree inside one CI run.
10. **Docs-only PR can still delete markdown law** until `agent-autoload-scan` is also wired into `docs-format.yml` (proposed one-line fix — cheap, fail-closed like peer gates).

**Machine fix worth doing once (not a human ritual):** add `node tooling/ci/agent-autoload-scan.mjs` to `.github/workflows/docs-format.yml` so docs-only PRs cannot delete the cold-start law.

---

## Collision / live state notes (re-check before each dispatch)

- Plan PR **#1090** must be on `main` (or path reachable) before pastes that cite the plan path.
- Open product work already exists (bank hold, market vendors, shell index, house-desk ADR) — C1 must fill `requires` before opening money rows so claim-check sees real service paths.
- Main checkout on Nitro’s laptop may be hundreds of commits behind tip — coordinators work from **worktrees at `origin/main` tip**, never the stale main checkout.
- Shehzad plane remains babysit-only.

---

## Provenance (subagent reports — inert history)

| Lane                                  | Agent id          | Status       |
| ------------------------------------- | ----------------- | ------------ |
| Lane 1 leverage law vs dispatches     | a97143ebf06a24548 | completed    |
| Lane 2 anti-drift machinery parent    | a312cdceb688219ae | failed (API) |
| Lane 2 child: drift incidents in docs | a13e211743c1df7fc | completed    |
| Lane 3 spec vs work orders            | a33c99862264e7283 | completed    |
| Lane 4 past drift parent              | a832200f316206079 | failed (API) |
| Lane 4 child: ADR reversal forensics  | a778301fe8f2041c4 | completed    |

Synthesis confidence: high on C2–C5 shape and C1 forex exclusion; medium on exact owner-row status until C1 re-derives `features.mjs` at tip.

---

## Errata — tip re-verify after first synthesis (same day)

The first banked synthesis was incomplete. Re-derived against `origin/main` after #1090/#1130:

| Claim in first synthesis                           | Live tip fact                                                                                                                   | Correction                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Leave `trade.forex` out of allowlist (horizon LAW) | Horizon still says LAW→IN/GF; **D-S-05 ADR is Accepted/done**; product law is "model yes / production list no until fiat rails" | **Include `trade.forex` in OPEN_MONEY** with that fence in the note — cutting it was over-caution, not fidelity to green light |
| Release `pay.gateway` owner                        | Already `ready`/unowned at tip                                                                                                  | Owner work already done; still needed **allowlist entry** or money gate keeps hiding it                                        |
| Release `ops.admin`                                | Already free                                                                                                                    | No-op                                                                                                                          |
| Five features only                                 | Green light also unlocked payments                                                                                              | Allowlist = five **+ `pay.gateway`**                                                                                           |
| `p2p.merchants` free to open                       | `wip` / `owner: nitro-agent`                                                                                                    | Allowlist ready when free; do not steal live claim                                                                             |
| `market.vendors` needs greenfield service          | `services/svc-market` exists; Stages 1–3 largely on main; #1128 closes tracker to `done`                                        | Do not rebuild; collision risk with open #1128 on `features.mjs`                                                               |
| Stop at "paste five chats"                         | Green light was to **open the machine**                                                                                         | **C1 ships as a PR from this resume**, not a paste handoff                                                                     |
