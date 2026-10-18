# Swarm mandate scope

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

## ONE SURFACE — read before any front-end work (mandatory)

`vendor/upstream-exchange/05_Web_Front`, served on `:8090`, is the **sole product surface**.
Law: ADR [`../adr/2026-08-03-retire-apps-web-port-to-vue-shell.md`](../adr/2026-08-03-retire-apps-web-port-to-vue-shell.md) (Accepted, owner decision) and doctrine §5.3. **Settled — implement it, do not re-litigate it.**

> **Path note, corrected 2026-08-07.** The directory on disk **is** `vendor/upstream-exchange`
> — the rename landed in #771. The warning that stood here until now claimed the opposite, and a
> later brand-scrub rewrote its counter-example too, leaving it asserting that
> `vendor/upstream-exchange` does not exist and that the real path is `vendor/upstream-exchange`.
> It sent agents to a path that is gone. There is one vendor tree and this is its name.

| Rule                      | What it means in a PR                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`apps/web` is retired** | No craft, no fixes, **no new tests** there. A PR touching `apps/web/**` is rejected on sight — "shell craft" in the body does not make it the shell.                                                                                                                                                                                                         |
| **Audience**              | Pro trader workbench. Retail arrives via **Convert**; "retail IA as terminal default" is a listed anti-pattern, not a direction.                                                                                                                                                                                                                             |
| **One kit**               | iView 3, restyled through CSS variables in `intafaced.css`. Never fork the kit. No Tailwind / shadcn / Radix / Element / Ant / Naive / Quasar.                                                                                                                                                                                                               |
| **Palette**               | **Black + orange** — owner's standing direction, restored 2026-08-02 (`intafaced.css:21`), superseding the provisional P21 teal. Re-picking it is **Nitro-only** — agents never decide taste. A repaint is **not** a token swap: 402 hex literals across 65 files, and a half-applied swap is worse than either colour (`COLOR-LOCK-P21-PROVISIONAL:22-34`). |
| **Honesty**               | No fake prices · empty ≠ zero · loading / failed / empty are three states · brand scrub · Nitro is never the runner.                                                                                                                                                                                                                                         |
| **Still to port**         | Runtime shape validation of edge responses; decimal-safe desk arithmetic (`bignumber` is vendored but `ix-trade.js` does not use it). Live WS depth client landed in #748.                                                                                                                                                                                   |

This section exists because the decision lived only in an ADR for a day, and in that day
a PR put six files of craft into `apps/web` and called it shell work. If it is not in
this file, the coordinator does not know it.

---

**Shell product craft** (REGROUP / AFK residual / LANDER / INTEGRITY) **plus non-money implementable tracker rows** is the swarm free-product board.

| Signal              | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `freeShell`         | REGROUP/AFK/LANDER/INTEGRITY only — shell craft                                      |
| `freeImplementable` | Tracker rows that pass the implementable gate                                        |
| `freeProduct`       | `freeShell` **+** `freeImplementable` (spawn total)                                  |
| `freeShell=0`       | No shell craft — **not** all-clear if `freeImplementable>0` or path-clear P1 remains |
| `freeProduct=0`     | Both shell and implementable empty — **not** “platform done”; run P1–P5              |
| `freeTracker`       | Ready/unowned tracker rows that are **not** implementable (dep-blocked, thin spec)   |

### Tracker implementable gate

A tracker row is **IMPLEMENTABLE** when `status` is `ready`, `owner` is none, and every `dependsOn` is `done`. Spec depth is optional — thin specs are a research hint, not a start blocker.

Implementable rows enter **freeProduct**: path-disjoint, worktrees, claim files optional.

Machine: `pnpm swarm:status` lane line is always:

`free=N freeShell=N freeImplementable=N freeTracker=N blocked=N`

`freeProduct` appears only on the spawn line as shell+implementable. **`freeShell=0` / `freeProduct=0` must never be read as all-clear** when `freeImplementable>0` or stranded P1 remains.

## AFK priority ladder (anti-drift — mandatory)

When `freeProduct=0`, **do not** burn the night on tip-bump stamp PRs (R07/R01/P-WS “cycle N” with identical board).  
**Re-freeze only on board delta** (new free product, implementable TRK, partner PR state change, invent findings >0).

| Priority | Lane                   | What counts as real work                                                                  | Ban                                 |
| -------- | ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| **P0**   | SPAWN_NOW free product | Claim + worktree + ship Class N/P path-disjoint residual **or implementable TRK Stage-1** | stamp mill while free product waits |
| **P1**   | Stranded branches      | Rebase/land `origin/feat/*` / `fix/*` after path-intersect vs open partner PRs            | dual-edit Denon file sets           |
| **P2**   | Partner unblock        | Exact CI fail extract; one NEW comment only; never merge partners                         | dual-edit / merge Denon·Shehzad     |
| **P3**   | Tracker                | Deepen thin specs **or** implement Stage-1 from implementable TRK                         | stamp mill; invent money-class      |
| **P4**   | Integrity              | Invent re-scan only if shell code changed; P-WS only if partner matrix changed            | cycle stamp with no delta           |
| **P5**   | Hygiene                | Claims truth; merge per AGENTS.md                                                         | R07 peace rows for unchanged board  |

**Night/AFK after freeProduct=0:** P1→P5 above. Merge per AGENTS.md. **Not** invent depth UI. **Not** R07 cycle spam.

### Allowed vs forbidden when freeProduct=0

| Allowed                                                   | Forbidden                                               |
| --------------------------------------------------------- | ------------------------------------------------------- |
| P1 land stranded branches (path-clean)                    | R07/R01/P-WS cycle PRs with same freeProduct=0 board    |
| P2 exact partner CI fail comments                         | Merging Denon/Shehzad PRs                               |
| P3 code-grounded TRK research deepen                      | Dual-edit partner open PR paths                         |
| P4 invent/P-WS **only if** code or partner matrix changed | Invent/P-WS stamp with no Board-Delta                   |
| P5 claims truth + merge per AGENTS.md                     | freeProduct=0 as session kill **or** as license to spam |

### Machine enforcement (not a banner)

| Mechanism                                      | What it does when context degrades                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`tooling/ci/value-gate.mjs` on Docs format** | **Retired 2026-08-21** — was stamp-mill enforcement; removed for ship speed.                                                                                                                                                                    |
| **`tooling/ci/value-gate.mjs` on CI `gates`**  | **Retired 2026-08-21** — same. Local optional: `pnpm value-gate:self-test`.                                                                                                                                                                     |
| **Zero-walk guard (both wirings)**             | No subject / no diff / no ancestors / broken symbol walk ⇒ **exit 1, advisory included**. Both checkouts pin `fetch-depth: 0`; under the `actions/checkout` default of 1 this gate printed `OK` having compared nothing to nothing.             |
| **`.githooks/pre-push`**                       | `format:check` + refuse direct push to `main`. **Nothing counts runs.** Delivery is never blocked by a volume number.                                                                                                                           |
| **CI triggers**                                | `push: main` **and** `pull_request` (push:main restored 2026-08-07 — only a push check proves the trunk is green). Docs-format is PR-only and skips FREEZE/claims/R00–R02/DASHBOARD-only. Manual: `workflow_dispatch`.                          |
| **Main CI no-cancel**                          | `ci.yml`: `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`. Every merge to main is allowed to finish CI (public Actions free). PR branches still cancel superseding runs. **Not a merge throttle** — unlimited parallel ship stays. |
| **Red tip repair**                             | Coordinate a focused fix without competing edits. Independent work and verified merges continue when their required checks pass. Failures affecting the change must be resolved. Full text: `CONTRIBUTING.md` §1.                               |
| **Coordination PR ban**                        | No PR whose sole job is R07/peace/cycle/FREEZE tip-bump/claims meter/status. Those stay files; ship only with a real product/law delta.                                                                                                         |
| `pnpm swarm:status` ops-churn / Actions 24h    | Informational counts only — the bill is zero, parallel work stays, a 403 or 429 is a stop                                                                                                                                                       |
| `pnpm swarm:lanes`                             | **Discoverability only** — enumerates P0–P3                                                                                                                                                                                                     |

Self-test (fixtures, no network): `pnpm value-gate:self-test`.

### F-STANDBY (finish type when freeProduct=0) — corrected

When the primary board finish is met but the session continues (AFK / “never stop”), the state is **F-STANDBY** ([`FINISH-ONTOLOGY.md`](./FINISH-ONTOLOGY.md) §1, §3 — in-repo home; readable by every teammate and every machine).

**Idle is valid ONLY when you can name why no lane has work.** Before any “idle OK” / “board unchanged” report, state in one line each:

| Line            | Required content                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| **P1 stranded** | N path-clear branches vs open partners, and **why each is not landable this cycle** (or “landed #…”) |
| **P2 partner**  | Which partner PRs changed state since last cycle (or “matrix unchanged”)                             |
| **P3 TRK**      | How many specs remain under 100 lines                                                                |

**If P1 path-clear count > 0, IDLE IS NOT A VALID OUTPUT. Land one** (smallest first). One branch → one PR. Re-verify path-clear at the tip you branch from.

- “No delta” justifies **not opening a stamp PR**. It **never** justifies not doing real P1–P3 work.
- Any ship must still be P1–P5 with a real **Board-Delta** (or code). Metric: value-gate (L0 in `docs/BOARD-CLEAR-PROCESS-LOOPS.md`).
- **Report format every cycle:** `P1 N clear / M landed this cycle · P2 <changes> · P3 <thin count> · tip <sha>`

**Spawn width (heuristic):** use available capacity for path-disjoint, high-leverage writers when `freeProduct>0`; the historical 6–8 figure is a planning target, never a cap or reason to delay work. When `freeProduct=0`, continue **P1–P3** only when they are substantive and path-clear; the 3–6 figure is also a planning heuristic, not a mandate.

### AFK PR law (mandatory)

**There is no PR budget and no Actions budget.** The bill is zero; parallel work stays; a 403 or
429 is a stop. Old spend thrift was **deleted 2026-08-07**
(retirement: [`../GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](../archive/GITHUB-CI-SPEND-CONTROL-2026-07-31.md)).
**Finished work is never held back for CI cost.** No PR caps, no CI-spend cooling window, no spend override flags. GitHub rate-limit cooldowns and access restrictions still apply; see [`AGENT_PROTOCOL.md`](../../tooling/agent-protocol/AGENT_PROTOCOL.md) §3.
GitHub is the **merge seal**, not the chat log.

| Rule                    | Detail                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Verify the change**   | Agents run relevant local checks and review the actual behavior. Then follow the merge rule in AGENTS.md.                              |
| **No coordination PRs** | Forbidden: R07 / peace / cycle N / FREEZE-only / claims-only / “board unchanged” PRs. Files stay local until a real product/law delta. |
| **One concern per PR**  | One service per PR (CONTRIBUTING §15.1) — **reviewability**. Do not fatten a PR to save runs; that reason is gone.                     |
| **Open path**           | `pnpm pr -- …`.                                                                                                                        |
| **Push path**           | `.githooks/pre-push` runs `format:check` and refuses direct push to `main`.                                                            |
| **Stamp mill**          | Stopped by `value-gate`, on **content**. Never by a volume number.                                                                     |

**Cold resume (no third file):** regenerate + read [`FREEZE-LIVE.md`](./FREEZE-LIVE.md) · [`../COORDINATION-TRUTH-LAYERS.md`](../COORDINATION-TRUTH-LAYERS.md) § Agent cold-start · human inbox [`../BOARD-CLEAR-HUMAN-BLOCKERS.md`](../BOARD-CLEAR-HUMAN-BLOCKERS.md).

Integrity only: invent fake money/depth · main-checkout · fake visual under NO-FLEET. Path-intersect before dual-edit — not an ownership ban.
