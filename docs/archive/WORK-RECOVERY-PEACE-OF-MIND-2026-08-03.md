# Work recovery — full program + peace-of-mind findings

**Run date (UTC):** 2026-08-03T05:37Z (fetch) · **Tip re-checked through** `origin/main` **`7f8b9d0`** (#421 trading rewire on tip)  
**This supersedes the thinner first pass** (`WORK-RECOVERY-AUDIT-SPEC-AND-FINDINGS-2026-08-03.md`) for conclusions; both kept for trail.

---

# A · Enhanced prompt (what you actually needed)

## Implicit requirements (inferred)

1. **Emotional + operational peace of mind:** prove we did not silently delete Nitro FE value.
2. **Completeness:** every place work can hide is checked (not a 3-minute sample).
3. **Correct truth base:** **GitHub `origin/main`**, not a stale/dirty laptop checkout.
4. **Distinguish** “not in git history as that commit” vs “behavior still on main under squash/rewrite.”
5. **vendored exchange kit alignment:** do not rescue work that **rebuilds** what the kit already is; rescue only **our** honesty/wiring/i18n/brand.
6. **Intentional supersession ≠ loss:** Denon may **replace** a screen with “not built” for doctrine — that must be named, not treated as accident.
7. **Deferred ≠ lost:** residual/AFK board items are backlog, not recovery emergencies.
8. **Actionable output:** named RESCUE / SAFE / DROP / DEFER / SUPERSEDED lists — no vague “looks fine.”
9. **Failure-hunting:** document how each method can lie (squash, tree-diff on old bases, dirty regression).
10. **You don’t run git** — agent owns hunt + plain summary.

## Completeness bar (Definition of Done for this audit)

| #   | Gate                                                                          | Met this run?                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------ |
| G1  | `git fetch --prune` + pinned tip SHA                                          | **Yes** `7f8b9d0`              |
| G2  | **All** remote branches scanned for shell/apps/web history delta              | **Yes** (7 shell / 3 apps/web) |
| G3  | **All** local branches scanned for shell history delta                        | **Yes** (46)                   |
| G4  | `git cherry` patch-id pass on FE-related locals + all remote shell candidates | **Yes**                        |
| G5  | **Content probes** for high-stakes markers on main (not cherry alone)         | **Yes** (with caveats)         |
| G6  | Worktrees: dirty shell **or** patch-unique shell commits                      | **Yes** (10)                   |
| G7  | Stash empty?                                                                  | **Yes** empty                  |
| G8  | Open PRs + Nitro closed-unmerged sample                                       | **Yes**                        |
| G9  | Residual register open/partial/blocked named                                  | **Yes** (from main)            |
| G10 | Local dirty classified rescue vs regression                                   | **Yes**                        |
| G11 | Untracked docs split (session vs bulk noise)                                  | **Yes**                        |
| G12 | vendored exchange kit “don’t rebuild” applied to rescue advice                | **Yes**                        |
| G13 | Intentional #421 supersession of Withdraw/Recharge named                      | **Yes**                        |
| G14 | External `sovereign-worktrees` checked                                        | **Yes** (docs-only path)       |

**Still cannot prove from one Mac:** work only on Denon’s disk never pushed; pure chat-only “fixes.”

---

# B · Architecture of the audit (plan before trust)

```
Phase 0  Pin truth     → fetch, tip SHA, open PR snapshot
Phase 1  Enumerate     → every remote/local ref with path history ≠ main
Phase 2  De-ghost      → git cherry (patch-id) + PR merged list
Phase 3  Content prove → distinctive strings / file roles on origin/main
Phase 4  Local machine → dirty tree, stash, worktrees, untracked
Phase 5  Backlog       → residual-register statuses
Phase 6  Classify      → SAFE / RESCUE / SUPERSEDED / DEFER / DROP / REGRESSION
Phase 7  Report        → this doc + one-screen for Nitro
Phase 8  Act (later)   → only RESCUE with human/agent go
```

### Method lies we actively combat

| Lie                                    | Why it happens                                | Countermeasure used                                                  |
| -------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| “Branch has 14 commits not on main”    | **Squash merge** rewrites SHAs                | `git cherry` + content markers + merged PR titles                    |
| “Tree differs by 60k lines”            | Branch **base is old**; whole folder diverged | Don’t use raw `diff main:path ref:path` alone for “unique work size” |
| “Local has important Vue edits”        | Checkout **behind** + undoing craft           | Diff vs **origin/main**; craft on main, local removes → REGRESSION   |
| “Withdraw craft gone = agent failed”   | **#421** replaced custody screens on purpose  | Read file + commit message                                           |
| “Cherry says unique ⇒ missing feature” | Markers in **docs evidence JSON** not runtime | Prefer runtime paths + feature probes                                |
| “No remote branch ⇒ safe”              | Branch **deleted after merge**                | Path history on main (`ix-trade.js`, #421)                           |
| “Empty stash ⇒ no WIP”                 | WIP in **worktrees**                          | Worktree scan                                                        |

---

# C · Exhaustive enumeration results

## C1 · Remote branches with shell history not reachable from `origin/main`

**Complete set (7):**

| Remote branch                              | Hist commits | `git cherry` unique shell-related                                                    | Content / disposition                                                                                                                                                                                                           |
| ------------------------------------------ | -----------: | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin/fix/pr86-format-and-wave`          |            5 | Many pre-#86 era commits still “+” by patch-id                                       | **Mostly historical stack**; chart/TV/port-gate may be **partially absorbed** into later main (Exchange comments cite 350px clip; lightweight-charts + TradingView **attribution** on main). **Not a bulk re-merge candidate.** |
| `origin/feat/rebrand-english-black-orange` |            4 | Overlaps #86-era stack                                                               | **#86 landed** as consolidated squash long ago. **SQUASH/HISTORICAL.**                                                                                                                                                          |
| `origin/fix/vendor-shell-build`            |            2 | **+** only `.dockerignore` commit (`c9e9d4f`); other cherry `-` (already equivalent) | **RESCUE:** `.dockerignore` **still absent** on `origin/main`                                                                                                                                                                   |
| `origin/fix/vendor-shell-purge-legacy`     |            1 | **+** full purge commit                                                              | **RESCUE (Denon brand):** not on main                                                                                                                                                                                           |
| `origin/feat/vendor-shell-rewire-promo`    |            1 | **+** WIP                                                                            | **QUARANTINE** — author says NOT reviewed/verified                                                                                                                                                                              |
| `origin/feat/app-i18n-keys`                |            1 | **+** i18n + `shell-i18n-scan.mjs`                                                   | **RESCUE (Nitro FE):** scan tool **0 hits** on main; real unique                                                                                                                                                                |
| `origin/feat/spine-java-rename`            |            1 | **+** package rename WIP                                                             | **Not FE product** — Denon/spine; do not touch as FE rescue                                                                                                                                                                     |

**Remote branches with apps/web history delta (3):** spine-scope, spine-otc wip, pr86-format — **not FE shell program**; no Nitro rescue.

**Recently deleted remotes (after merge):**  
`feat/vendor-shell-rewire-otc-cms` · `feat/vendor-shell-rewire-trading` → content on main as **#418**, **#421**.

## C2 · Local branches with shell history delta

**46** local branches. After `git cherry` + content checks:

- **~25** = history delta but **no patch-unique shell** → **SQUASH_GHOST** (merged via squash; keep folder cleanup for later).
- **~15** showed cherry “+” but **content probes / main log / feature probes** show **ON_MAIN** or **rewritten by later merge** (AFK #406–408, sub-accounts, hotkeys, dual-book on MoneyIndex, CMDK, groupPlate, etc.).
- **wave-a-continue** (14 cherry+): mix of OK on main + weak markers; **not** treated as a lost 14-commit product — many landed via #267 and follow-ons; remaining gaps are **craft detail**, not “missing program.”

## C3 · Worktrees

**10** worktrees with shell dirty **or** cherry-unique shell commits — all dirty_shell=0; unique counts mirror local branch ghosts/false positives. **No dirty shell WIP found in worktrees.**  
External `~/projects/sovereign-worktrees`: docs-frontend-operating-plan only.

## C4 · Stash / open PRs / closed unmerged

| Surface                            | Result                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Stash                              | **Empty**                                                                          |
| Nitro open PRs                     | **None**                                                                           |
| Open repo PRs                      | #423 notify · #422 custody-scan java · #420 tracker money risks · #346 Shehzad pay |
| Nitro closed unmerged (sample 100) | **#334** board-clear GO docs only                                                  |

## C5 · Local main checkout (this folder)

| Fact                                                                          | Meaning                                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Behind origin by **100+** commits (was 156 earlier; tip moved with #418/#421) | **Stale** — not truth                                                                                                                 |
| Dirty Vue (Withdraw, Register, …)                                             | Vs origin: **REGRESSION / wrong base** — main’s Withdraw is **CustodyNotBuilt** (27 lines); local dirt is not a secret better product |
| Untracked session docs (VENDORED-KIT map, this family)                        | **Optional docs RESCUE**                                                                                                              |
| ~188 untracked docs                                                           | **Do not bulk commit**                                                                                                                |

## C6 · Residual register (deferred by design — from main)

| Status  | Count | Role                                                                 |
| ------- | ----: | -------------------------------------------------------------------- |
| done    |    27 | Shipped                                                              |
| partial |     9 | Finish later                                                         |
| open    |     9 | AFK uc/ident/intafaced/index/cmdk/help/whitepaper/appdownload/rescan |
| blocked |     2 | B11 chart entry · C-LWC panes                                        |
| waived  |     1 | B15 multi-monitor                                                    |

→ **DEFER board**, not “lost off GitHub.”

---

# D · Critical narrative: #421 and “lost” withdraw craft

**On `origin/main` tip, `Withdraw.vue` is intentionally:**

```text
CustodyNotBuilt — no chain custody endpoint; wallet RPC unadopted until security review.
```

Same pattern for other custody screens. Commit **#421** states the **vendor workflow is preserved in git history** and returns when a real custody service exists.

**Pre-#421** Withdraw was ~1200 lines including B3 dual-book craft (`ix-dualbook`, `feeSourceLabel`, …).

| Interpretation                                                  | Correct?                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| “Nitro’s withdraw craft was never committed”                    | **False** — it was on main before #421                                |
| “It’s gone from tip forever with no recovery”                   | **False** — full file in history (`7f8b9d0^`)                         |
| “We should immediately put B3 craft back on tip”                | **No** — would **lie** about custody while ADR says no wallet RPC yet |
| “Use vendored exchange kit withdraw Java flow as live money UI” | **No** — dual-book / Option B                                         |

**MoneyIndex** on tip **still** carries B3/desk dual-book honesty and edge balance source — not all craft was wiped.

---

# E · Final classification (complete for action)

## E1 · SAFE_ON_MAIN (do not re-rescue)

Examples proven by presence on tip / probes:

- Trading rewire **#421** (`ix-trade.js`, Exchange edge path, empty≠broken)
- OTC/identity/inbox rewire **#418**
- Nav/auth gates **#419**
- Shell deploy **#412** family
- Dual-book / ix-\* honesty on **MoneyIndex**, plane switch, hotkeys, CMDK, sub-accounts, AFK honesty strings, book-honesty, chart empty states, TradingView **attribution** + 350px-clip **lesson in comments**, residual register tooling

**Unspoken answer:** the FE **program** is on GitHub.

## E2 · RESCUE (real, off tip)

| ID     | Item                                                    | Owner    | Why real                       | Action                |
| ------ | ------------------------------------------------------- | -------- | ------------------------------ | --------------------- |
| **R1** | `feat/app-i18n-keys` + `tooling/ci/shell-i18n-scan.mjs` | Nitro FE | Scan file **absent** on main   | Rebase on tip → PR    |
| **R2** | `05_Web_Front/.dockerignore` (`c9e9d4f`)                | Infra/FE | **Missing** on main after #417 | Small PR              |
| **R3** | `fix/vendor-shell-purge-legacy`                         | Denon    | Brand purge not on tip         | Denon PR / coordinate |
| **R4** | Session docs (maps, call extracts, this audit)          | Nitro    | Untracked knowledge            | Optional docs PR      |

## E3 · QUARANTINE

| ID     | Item                                  | Rule                                   |
| ------ | ------------------------------------- | -------------------------------------- |
| **Q1** | `feat/vendor-shell-rewire-promo`      | Keep branch; **no merge** until review |
| **Q2** | `feat/spine-java-rename` / spine wips | Not FE; leave                          |

## E4 · SUPERSEDED (in history, not tip — correct)

| ID     | Item                                                 | Why                                                 |
| ------ | ---------------------------------------------------- | --------------------------------------------------- |
| **S1** | B3 full Withdraw dual-book UI                        | Replaced by **CustodyNotBuilt** (#421) for doctrine |
| **S2** | Similar recharge custody UI if collapsed to NotBuilt | Same                                                |
| **S3** | Pre-#86 rebrand branch stacks                        | Landed via #86 squash                               |

**Recover later:** when wallet RPC cleared + ledger withdraw path exists — **rebuild from history + edge**, don’t re-open Java money UI.

## E5 · REGRESSION_DIRTY (this Mac)

Discard local dirty Vue on stale main when moving to clean worktree. **Do not commit.**

## E6 · DEFER (residual board)

All residual **open/partial/blocked** rows → FE board input for Chat D. Named in C6.

## E7 · DROP

- `apps/web` as product
- Bulk 188 untracked research docs
- Re-merging entire `rebrand-english-black-orange` / pr86 historical branches
- Rebuilding vendored exchange kit screens from Next

---

# F · vendored exchange kit rule (applied)

| vendored exchange kit already is | We do not rescue as “rebuild”      | We may still add                             |
| -------------------------------- | ---------------------------------- | -------------------------------------------- |
| Auth, OTC, exchange shell, admin | New parallel apps                  | Honesty, i18n keys, edge rewire, brand purge |
| Custody **workflows** in history | Live Java wallet UI                | CustodyNotBuilt until review                 |
| Charts host                      | Third full chart product this week | Data honesty; TV later if chosen             |

---

# G · Peace-of-mind one-screen (Nitro)

| Worry                                       | Verdict                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Did most of my shell work never hit GitHub? | **No — it’s on main** (or squash-merged).                                                                 |
| Is this laptop the source of truth?         | **No — it’s stale + dirty. Trust `origin/main`.**                                                         |
| Anything important only local?              | **i18n branch is on GitHub remote** (not main). **Docs** untracked. Dirty Vue = **bad**, not secret gold. |
| Withdraw craft “deleted”?                   | **Superseded on purpose by #421** (honest “not built”); full craft in **history**.                        |
| Deferred work lost?                         | **No** — residual register.                                                                               |
| Denon trading/OTC rewires?                  | **On main** (#418, #421).                                                                                 |
| Must-rescue now?                            | **i18n PR · dockerignore · Denon purge · optional docs.**                                                 |

---

# H · Self-prompt for execution agents (copy-paste)

```
WORK RECOVERY EXECUTION — not a skim.

Truth: origin/main after fetch. Tip must be re-read.
Read docs/WORK-RECOVERY-PEACE-OF-MIND-2026-08-03.md end-to-end.

Do:
1) Confirm tip still has #421 Withdraw=CustodyNotBuilt; do not re-apply B3 withdraw craft on tip.
2) RESCUE R1: rebase origin/feat/app-i18n-keys onto origin/main, open PR, conflict-check vs #421 files.
3) RESCUE R2: PR adding vendor/.../05_Web_Front/.dockerignore from c9e9d4f if still missing.
4) Message/PR path for purge-legacy only with Denon ownership note.
5) Never merge promo WIP. Never commit dirty stale main Vue.
6) vendored exchange kit rule: no apps/web product; no rebuild of kit screens.

Prove: gh pr urls + git grep shell-i18n-scan / .dockerignore on main after merge.
```

---

# I · What the first pass under-did (honesty)

| Gap in first pass                            | Fixed here                                            |
| -------------------------------------------- | ----------------------------------------------------- |
| Sampled branches                             | Full remote + full local shell delta lists            |
| Relied on commit counts                      | Added cherry + content + feature probes               |
| Missed #421 tip move mid-day                 | Re-fetched; tip `7f8b9d0`                             |
| Said withdraw craft “on main” from older tip | **Corrected:** craft was on main, then **superseded** |
| Under-specified method lies                  | Section B table                                       |
| Implicit needs not spelled                   | Section A                                             |

---

_Re-run Phases 0–6 after any vendor-shell merge wave. Tip SHA is mandatory in the report header._
