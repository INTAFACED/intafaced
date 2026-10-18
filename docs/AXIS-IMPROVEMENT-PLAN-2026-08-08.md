> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# The plan for all eight axes — 2026-08-08

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Nine axes, as it turns out. Every number below was re-derived against `origin/main` from a worktree at that tip, then a six-lane adversarial audit was run against this document itself. What that audit changed is listed first, because two of the changes reverse a recommendation and one of them corrects a headline that was false.

**Nothing here puts a person in the merge path.** No required review, no approval gate, no reading of code by anyone. Every enforcement proposed is one cheap automated check that fails open, or is stated honestly as "no machine version exists".

---

## What the audit of this document changed

Six read-only lanes: re-run every evidence line; try to refute the money-gate claim; derive the axis set independently; check the blast radius of the documentation proposal; test whether five coordinators can really run at once; check for drift.

**Four things this document got wrong, now fixed in place.**

1. **The headline was false.** Opening the money gate unblocks **zero payments features**. Not one `pay.*` row becomes dispatchable — `pay.gateway` is `wip` and owned by Nitro, which puts it and its five dependents outside the free board regardless of the gate, and `pay.routing`/`pay.settlement` have no spec file. What actually opens is **trading, venue aggregation, P2P merchants and the vendor marketplace — five features**. A5 is rewritten around the honest claim.
2. **"Point the swarm at the least-verified money services" was backwards.** `svc-pay` and `svc-trade` are among the _best_ tested services in the repo. What is missing is the audit paperwork, not the machine protection. The sentence is deleted.
3. **The documentation proposal is withdrawn.** Moving `docs/ops/claims` and `docs/ops/slices` out of `docs/` would fail two CI gates closed on day one — `brand-scan` currently exempts `docs/ops` and would immediately flag a claim file whose `owner:` field contains an agent's session name, reddening `main` and every local `pnpm verify`. A6 now proposes fixing the measurement instead of moving the files.
4. **"Start two coordinators, not five" is deleted.** It was caution, not evidence, and `docs/COORDINATION-TRUTH-LAYERS.md:119` lists "cap on parallel agents or open PRs for coordination" under **hard rejects**. The record shows 715 merges in seven days, peak 217 in a day, zero reverts, and six PRs writing the most contended file in the repo inside one hour with no damage. Start all five.

**Two things the audit added.**

5. **A ninth axis exists** — the work no agent can do. 39 of 148 tracker rows are `socket` status, 17 of them unowned, scattered across six documents with no single list and no count. The tracker subtracts them from its own denominator, so a quarter of the platform is invisible on every board. See A9.
6. **Cutting branch protection was wrong on its own terms.** Required _reviews_ put a human in the merge path; required _status checks_ do not — they make the machine the gate instead of an agent's judgement about when to click merge. The repo already wrote the counter-evidence: `.github/workflows/supply-chain.yml` records that **#898 merged with its supply-chain job RED, and a fixed HIGH-severity advisory came back to main in #904**. It moves to A9, because only the repository owner can set it.

**Three numbers this document had wrong**, now corrected: the test-file ratio (it was inherited from the earlier audit and never derived — the real figure is 333 test files against 501 non-test TypeScript sources under `services/` and `packages/`); an unreferenced-file count in A6 that two methods disagreed on by a factor of two, now removed along with the proposal it supported; and a quoted line that dropped a backslash.

---

## Corrections to the earlier axis audit

The 2026-08-08 axis audit was computed from the main checkout, which is **320 commits behind `origin/main`**. Eight of its numbers are stale or overstated.

| Audit said                                                                    | Actually, at tip                                                                                                                                                                                                             | How to check                                                                                                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 133 features, 44 done                                                         | **148 features, 45 done.** `bank` is 4/6 not 2/6; `ops` is 0/7 not 0/6                                                                                                                                                       | `node -e 'import("./tooling/tracker/features.mjs").then(m=>console.log(m.FEATURES.length, m.FEATURES.filter(f=>f.status==="done").length))'` |
| Promise-falsification: 2 of 18 services                                       | **9 of 18.** Unaudited: academy, agents, dex, identity, notify, pay, protocol, trade, ws                                                                                                                                     | `for s in $(ls services); do [ -f "docs/audit/2026-08-08-$s.md" ] \|\| echo $s; done`                                                        |
| 657 documents; 193 loose at docs root; 87 audits                              | **675 files under `docs/`** (640 of them `.md`); 187 loose at root; 103 audits                                                                                                                                               | `git ls-tree -r origin/main --name-only \| grep -c '^docs/'`                                                                                 |
| Vendor: 1,768 files                                                           | **1,692.** The 896 Java / 162 Vue / 91 JS split is correct                                                                                                                                                                   | `git ls-tree -r origin/main --name-only \| grep -c '^vendor/'`                                                                               |
| `swarm:status` reports a thrift HARD FAIL and a spend cap that does not exist | **No longer true** — it was fixed. It now prints a free board and self-flags a stale checkout                                                                                                                                | `node tooling/scripts/swarm.mjs status`                                                                                                      |
| Your name blocks six surfaces via claims; stale claim locks                   | **Claim hygiene is clean** — 1 open claim, 0 stale `TRK-*` locks. The block is the tracker `owner` field: **9 non-done rows** owned by Nitro                                                                                 | `node tooling/ci/claim-staleness.mjs`                                                                                                        |
| `docs/ops` is the single most-changed area over 30 days                       | **`vendor/` is** (4,369 file-changes) — but 3,434 of those are one import (#73) and one rename (#771). Net of those, the audit's read holds, and sharpens: the sink is **`docs/ops` root — 21 files, 936 changes in 7 days** | `git log origin/main --since='30 days ago' --name-only --pretty=format: \| awk -F/ '{print $1}' \| sort \| uniq -c \| sort -rn`              |
| The 896 vendored Java files are outside every scan                            | **Overstated.** Two CI scans target `vendor/` specifically (`vendor-java-money-scan.mjs`, `vendor-shell-scan.mjs`). What is true: never compiled, typechecked, tested, or dependency-scanned                                 | `ls tooling/ci \| grep vendor`                                                                                                               |
| 33 worktrees, 30 stranded branches                                            | **23 worktrees, 20 stranded** — and the cap of 20 is decorative: `pnpm wt:gc:check` is wired to nothing                                                                                                                      | `node tooling/scripts/swarm.mjs status`                                                                                                      |

Throughput reproduced and is higher than the audit stated: **715 commits and 712 merged pull requests in the last seven days**, peak 217 merges in one day, **zero reverts**, median pull-request lifetime **7 minutes**, three open PRs right now, no branch protection on `main`.

**Three findings neither audit had.**

1. **The dispatcher is hard-coded to refuse every money vertical.** `tooling/scripts/swarm.mjs:239` computes `const money = /^(trade|pay|bank|venue|p2p|market)\\./.test(f.id)` — the doubled backslash is real, the line sits inside a template literal — and line 262 excludes it: `const impl = r.depsDone && !r.money && !r.wave1ex && specOk`. `docs/ops/SWARM-MANDATE.md:52` records it as _"Money-class (closed until Nitro opens a wave)"_.
2. **Eight of the twenty feature-tagged open issues describe work the tracker already calls `done`** — `identity.webauthn`, `matching.engine`, `web.shell`, `p2p.offers`, `blueprint.onboarding`, `bank.accounts`, `agents.gateway`, `academy.lobbies`.
3. **The customer platform runs Spring Boot 1.5.9 / 1.5.10** — end of life since August 2019 — and `.github/dependabot.yml` covers `npm` and `github-actions` only. No `maven` entry, so those 32 jars have never been checked.

---

## A1 · Product build

**Where it stands.** 45 of 148 features are done. Strip out the 39 rows that are deliberate v1 exclusions and 45 of 109 are done — 41%. The spine is finished; the business is not. `pay` is 2 of 11, `trade` 2 of 10, `ops` 0 of 7.
Evidence: `node -e 'import("./tooling/tracker/features.mjs").then(m=>{const r=m.FEATURES.filter(f=>f.status!=="socket");console.log(r.length,r.filter(f=>f.status==="done").length)})'`

**What should change.** Nothing directly. A1 is the output of A5 and A9. Sixteen features have every dependency satisfied and no owner; five of them become dispatchable the moment the money gate opens; the rest wait on a spec file, on a dependency, or on your name coming off a row.

**Why this and not something else.** The alternative is a hand-run "money build coordinator". Rejected: it re-creates by hand what the dispatcher already does, and it dies when that chat closes.

**What it unlocks.** Nothing on its own. It is the scoreboard, not a lever.

**How it stays true without a human.** Already automated — `features.mjs` is the single source of done and `pnpm swarm:next` prints a ready-to-paste worker brief.

**Effort.** Zero. It is a consequence of A5 and A9.

**Risk if we do nothing.** The swarm keeps shipping at full speed on the least commercially important part of the product.

**DECISION:** none — answer A5 and A9.

---

## A2 · The customer surface

**Where it stands.** What customers see is a vendored third-party exchange — 1,692 files, 896 Java and 162 Vue — carrying our own patches as `assets/js/ix-*.js`. `pnpm-workspace.yaml` lists `apps/*`, `services/*`, `packages/*`, `tooling/*`; it does not list `vendor/*`, so CI never compiles, typechecks, builds or tests it. Two targeted scans do run over it. The tracker marks `web.shell` **done**.
Evidence: `cat pnpm-workspace.yaml` · `grep -c vendor .github/workflows/ci.yml` → 0 · `ls tooling/ci | grep vendor`

**What should change.** Three things, all machine-run, none of them a build system for Java.

1. Add `maven` to `.github/dependabot.yml` for the two `pom.xml` roots — four lines, and the first vulnerability alerting those 32 jars have ever had.
2. Add a job that runs `mvn -q -DskipTests compile` over `vendor/upstream-exchange/00_framework` on pull requests touching `vendor/**`, with `continue-on-error: true`. Reporting only, never blocking.
3. Regenerate `NOTICE`. It was compiled 2026-07-29 against commit `4311cff`, hundreds of commits ago.

**Why this and not something else.** The obvious alternative is pulling `vendor/*` into the pnpm workspace so `pnpm verify` covers it. Rejected on evidence: the vendor tree builds with webpack 3 and cannot parse modern syntax — the `web.shell` tracker note records that `ix-money.js` had to use `bignumber.js` instead of `bigint` for exactly this reason. Adding it to the workspace breaks the workspace.

**What it unlocks.** The first honest answer to "is the thing customers look at safe to run", and a licence record that matches the tree.

**How it stays true without a human.** Dependabot opens the PRs itself; the compile job is a status line nobody has to read. Both fail open.

**Effort.** One agent session for CI, one for `NOTICE`.

**Risk if we do nothing.** An eight-year-old end-of-life Java stack serves customers with no vulnerability alerting of any kind.

**DECISION:** Do we turn on dependency alerting and a non-blocking compile check for the vendored customer platform? Yes / no.

---

## A3 · Shipping

**Where it stands.** Five CI workflows and none of them deploy. No Terraform, Kubernetes, Helm or Pulumi. No staging, no environment promotion, no rollback. One `Dockerfile` of ours plus the vendor's, two local compose files. Nothing matches any secret-manager tooling.
Evidence: `git ls-files | grep -Ei 'terraform|\.tf$|helm|k8s|kubernetes|kustomize|pulumi'` → empty · `grep -il deploy .github/workflows/*` → `ci.yml` only, whose four `deploy` lines are a local test chain

**What should change.** One agent session producing a deploy workflow to a single staging host, from the existing `Dockerfile` and compose files. Manual trigger plus deploy-on-merge-to-main. Secrets in GitHub Actions secrets — not a vault, not yet. Rollback is redeploying the previous image tag, one command in the same workflow.

**Why this and not something else.** The alternative is proper infrastructure-as-code. Rejected for now: weeks of work that produces nothing observable until the last day, when every axis downstream only needs _something running somewhere other than a laptop_. Let the real infrastructure be argued from a running system.

**What it unlocks.** Dashboards, load testing, backup and restore — none of which can be built against a laptop.

**How it stays true without a human.** The deploy workflow is its own check; if it breaks, the deploy fails and says so.

**Effort.** One agent session. A host has to exist first, and that is a purchase.

**Risk if we do nothing.** The product cannot be shown to anyone, and four further concerns stay theoretical.

**DECISION:** Do we stand up one staging host and deploy to it, before building any real infrastructure? Yes / no.

---

## A4 · Money correctness

**Where it stands.** The promise-falsification method — read what a service claims in writing, then try to falsify each claim against reachable state — has covered **9 of 18 services**. Still unaudited: `svc-academy`, `svc-agents`, `svc-dex`, `svc-identity`, `svc-notify`, `svc-pay`, `svc-protocol`, `svc-trade`, `svc-ws`. That is an audit-paperwork gap, not a test gap — `svc-pay` and `svc-trade` are among the better-tested services in the repo (333 test files against 501 non-test TypeScript sources across `services/` and `packages/`).
Evidence: `for s in $(ls services); do [ -f "docs/audit/2026-08-08-$s.md" ] || echo $s; done`

**What should change.** Two things.

1. **Continue, in this order: `svc-trade`, `svc-pay`, `svc-identity`.** `svc-trade` is 122 source files, the largest service in the repo, and has a **known unfixed money bug already reported** — un-rounded leverage against a `numeric(8,2)` column posts an inconsistent margin — which an agent found and could not fix because the service is claimed to your name. See A9.
2. **Widen the unit from "service" to "money promise".** The largest unkept promise in the tree is in a package, not a service. `packages/ledger-client/src/accounts.ts:222` says of treasury boundary accounts that _"a negative balance here is exactly the platform's obligation to the outside — the number reconciliation checks against custody."_ Nothing checks against custody. `services/svc-ledger/src/ledger/reconcile.ts` verifies the books against themselves — cached balance versus replay, hash chain, totals netting to zero — and never reads an on-chain or bank balance. **The books can be perfectly self-consistent while the platform is insolvent.** That is one reconciliation job, and it is the highest-value single piece of money work in this document.

**Why this and not something else.** The alternative is raising test coverage instead. Rejected as the _next_ move: coverage proves the code does what it does; falsification proves it does what it promised. On this repo the second has produced the bugs. Worth noting for later: the doctrine's "≥95% coverage on money paths" has **never been measured** — no coverage reporter is installed anywhere, and the DoD gate implements the rule as "some test imports this file". Turning the reporter on and printing the number, gating nothing, is a cheap follow-up.

**What it unlocks.** The money paths customers will actually touch get the treatment the spine already got, and the one promise that would hide insolvency gets a check.

**How it stays true without a human.** Every finding lands as a test or a scan in `tooling/ci`, which CI runs on every PR.

**Effort.** One agent session per service; one more for the custody reconciliation job.

**Risk if we do nothing.** A reconciliation that reports "green" while the platform's obligations exceed what it actually holds.

**DECISION:** Do we run the next three falsification passes on `svc-trade`, `svc-pay` and `svc-identity`, and build the custody-versus-ledger reconciliation? Yes / no.

---

## A5 · Knowing what's next

**Where it stands.** `pnpm swarm:next` does answer "what next" — it prints a full worker brief with allowed paths. But it is hard-coded to refuse every money vertical (`swarm.mjs:239` and `:262`), so the board offers seven things today and all seven are academy, agents or notifications. Separately the issue board is write-only: 35 open, **0 ever closed**, and eight of the twenty feature-tagged issues describe work already marked `done`.

**Being precise about what opening the gate does, because the first version of this document was wrong:** it makes **five** features dispatchable — `trade.forex`, `trade.ccxt-api`, `venue.aggregation`, `p2p.merchants`, `market.vendors`. It makes **zero** payments features dispatchable. Every `pay.*` row is blocked by something else: `pay.gateway` is `wip` and owned by you, which also blocks `pay.psp`, `pay.payfac`, `pay.fraud`, `pay.subscriptions` and `pay.plugins` through the dependency chain; `pay.routing` and `pay.settlement` have no spec file. **Payments is A9's decision, not this one.**
Evidence: `grep -n 'const money = \|const impl = ' tooling/scripts/swarm.mjs` · `sed -n '52p' docs/ops/SWARM-MANDATE.md` · `node tooling/scripts/swarm.mjs status` · `gh issue list --state closed --limit 200 --json number --jq 'length'` → 0

**What should change.** Four changes, in this order. The first two must land before any money feature is dispatched.

1. **Fill in the `requires` field** for `trade.forex`, `trade.ccxt-api`, `p2p.merchants` and `market.vendors` in `features.mjs`, with the paths their own specs already name. Right now those fields are empty, so the dispatcher hands a worker the path of _the spec document_ instead of the code. Three of the five newly-opened features write `services/svc-trade`, and the collision machinery currently believes they touch three unrelated markdown files — while `trade.algo`, `trade.copy`, `trade.otc` and `trade.mm-bot` are all live in that same tree. Four array literals close that hole. **This is what makes opening the gate ordinary rather than risky.**
2. **Open the money wave as an allowlist, not a deletion.** Change line 262 to `const impl = r.depsDone && (!r.money || OPEN_MONEY.has(r.featureId)) && !r.wave1ex && specOk`, with `OPEN_MONEY` naming exactly those five ids. Identical result today, but it does not silently auto-open `trade.options` and `market.commerce` the day an unrelated pull request merges. The opening stays a decision.
3. **Clean up two traps in the same pull request.** `swarm.mjs:181-183` defines `MONEY_TRACKER_RE` and `WAVE1_EXCLUDE`, which are dead code referenced nowhere — an agent told to "remove the money gate" will edit those, change nothing, and report success. And `swarm.mjs:922` prints "Money-class closed" into every worker paste, so without updating it and `SWARM-MANDATE.md:46,52` an agent dispatched to a money feature reads a prompt telling it money is closed.
4. **Close the shipped issues automatically.** One script reads the `[feature.id]` tag from each open issue title, looks up its status in `features.mjs`, and closes any whose feature is `done`, with a comment naming the tracker row. Eight close on the first run.

**Why this and not something else.** The alternative is rewriting the 35 template-stub issue bodies into real specifications. Rejected: they already exist — 60 spec documents under `docs/ops/trk/` and 25 ADRs, which the dispatcher reads directly. Rewriting issue bodies would duplicate the law into a fourth place that then has to be kept true.

**What it unlocks.** Five real mountains, in trading and marketplace, dispatchable by a machine that merges ~100 pull requests a day — with collision detection actually armed for the first time on those rows.

**How it stays true without a human.** The issue-reconciler is the machine check and it fails open. `pnpm claim:check` already exists, already advisory, already reads both the open-PR set and the tracker locks — one line in each worker brief is the whole apparatus.

**Effort.** One agent session for all four.

**Risk if we do nothing.** The swarm keeps working at full speed on the least commercially important part of the product, and the board keeps telling anyone who reads it that finished work is unfinished.

**DECISION:** Do we open trading, venue aggregation, P2P merchants and the vendor marketplace — five features — to agents without asking you first? Yes / no. (This is not the payments decision. That is A9.)

---

## A6 · The documentation estate

**Where it stands.** 675 files under `docs/`, 640 of them markdown. But of the 255 under `docs/ops`, **78 are machine-written claim locks, 60 are dispatcher spec inputs, and 95 are agent-authored slice specs** — only 22 are documents written to be read by a person. The genuine churn sink is narrow: those 22 root files absorbed **936 file-changes in seven days**, roughly 44 rewrites each.

**The original proposal here — move the machine state out of `docs/` — is withdrawn.** An audit of its blast radius found it would fail two CI gates closed on day one. `brand-scan.mjs:184` currently allowlists `docs/ops`, and its `walk()` has no dot-directory skip, so a `.swarm-state/` directory would be scanned immediately and would immediately flag a claim file whose `owner:` field contains an agent's session name — reddening `main` and every agent's local `pnpm verify`, and recurring every time a session claims anything. `.gitleaks.toml` would likewise lose its exemption on all 173 files. There are eight hard-coded path literals in `swarm.mjs` that changing the directory constant does not touch, including the instruction printed to every dispatched agent, plus the path named in seven prose documents agents follow. And the premise was only half right: nothing reads `slices/` programmatically — they are agent-_authored_ specs, structurally the same kind of thing as `trk/`.
Evidence: `git ls-files docs/ops | awk -F/ 'NF==3{print "(root)"} NF>3{print $3}' | sort | uniq -c` · `sed -n '184p' tooling/ci/brand-scan.mjs`

**What should change instead.** This is a measurement problem, not a layout problem.

1. Wherever the document count is produced, exclude the three state directories: `find docs -name '*.md' -not -path 'docs/ops/claims/*' -not -path 'docs/ops/slices/*' -not -path 'docs/ops/trk/*'` → **407 prose documents**, not 640. One edit, zero blast radius.
2. Add two lines to `docs/ops/README.md` naming those three as state directories rather than documents. Its table today lists the six generated root files and omits all three, which is why every audit re-derives the same alarming number.
3. If a structural change is still wanted, the target is the **187 loose files at the root of `docs/`** — that is the real navigability problem, nothing reads most of them, and moving them is a rename rather than a dispatcher change.

**Why this and not something else.** A deletion pass over "unreferenced" files was the other candidate, and it is the most dangerous option on the list: claim locks exist to be found by a script, not linked from a document, so "unreferenced" is the wrong test entirely. Run on that test, a deletion pass deletes the swarm's memory.

**What it unlocks.** A document count that means something, so the next audit does not misdiagnose the same thing again.

**How it stays true without a human.** Nothing to maintain — the count is derived, and the README convention is two lines of prose that describe a layout nobody is changing.

**Effort.** One agent session, and a small one.

**Risk if we do nothing.** Every future audit re-derives an alarming document count from machine state and proposes deleting the swarm's bookkeeping. This document did exactly that.

**DECISION:** Do we fix how documents are counted and leave every file where it is? Yes / no.

---

## A7 · Security

**Where it stands.** Four security documents, newest 5 August. Secret scanning is real and layered — `gitleaks` on every pull request plus `tooling/ci/secret-scan.mjs`, which already knows about roughly forty credentials that arrived inside the vendored tree, and a mutation test that proves the scanner still catches things. But `.gitleaks.toml:12` allowlists `vendor/` and `docs/` by path, dependency scanning covers `npm` and `github-actions` only, and the customer-facing Java platform is Spring Boot 1.5.9 with 32 vendored jars nothing has ever checked. **Threat model (judgment):** [`THREAT-MODEL-CURRENT.md`](THREAT-MODEL-CURRENT.md) (D26-P3-02). Still no penetration test. Session / authentication review remains **D26-P3-06**.

**What should change.** The dependency half is A2 item 1 — the same four lines fix both, and should be done once. What is left for A7 alone is the review half: one falsification pass over `svc-identity` covering sessions, tokens, step-up and API keys, written the way the money audits are written. That is the authentication review, and it is already on A4's list.

**Why this and not something else.** The alternative is commissioning a penetration test. Rejected as the _next_ step, not on principle: a penetration test needs a running deployed system, which is A3, and it is worth far more after `svc-identity` has been falsified than before.

**What it unlocks.** A written account of what happens when someone tries to become someone else.

**How it stays true without a human.** Findings become scans in `tooling/ci`; Dependabot maintains itself.

**Effort.** One agent session, shared with A4.

**Risk if we do nothing.** The service that decides who a user is has never been adversarially examined.

**DECISION:** Is a penetration test deferred until something is deployed and `svc-identity` has been falsified? Yes / no.

---

## A8 · The agent machine

**Where it stands.** The machine works: 715 commits and 712 merged pull requests in seven days, zero reverts, 7-minute median pull-request lifetime. It is also better written down than the earlier audit credited — `swarm.mjs`, `claim-check.mjs`, `claim-staleness.mjs`, `worktree.mjs`, `SWARM-MANDATE.md` and `AGENT_PROTOCOL.md` are all in the repository. What lives only in chat is the _coordinator_ layer: how a wave is planned, how lanes are fenced, how the falsification method is run. Two of its own numbers drift — 23 worktrees against a cap of 20, 20 stranded branches — and the cap is decorative, because `pnpm wt:gc:check` exists but is wired to nothing.

**What should change.** One thing, and it is a chore: run `pnpm wt:gc` — the dry run — and read why each worktree is kept. Removal is a separate, **attended** step: `pnpm wt:gc:apply -- --yes`. `--apply` alone prints the plan and refuses.

> **SUPERSEDED 2026-08-08 by #1151.** This paragraph originally read _"schedule `pnpm wt:gc:apply`. It already exists and already clears both."_ Both halves were wrong by then. `pnpm wt:gc:apply` no longer removes anything on its own — it prints a plan and exits 1 — and **scheduling it is now barred**: `worktree-gc.mjs` cannot tell an abandoned checkout from four live agents, and running it unattended is how another lane lost two worktrees mid-edit plus an unpushed branch (`LANE-CLOSEOUT-OPS-2026-08-08.md`). The tool itself now says so, citing A8 of `AXIS-DISPATCH-REVISED-ANTI-DRIFT-2026-08-08.md`. Worktree drift is a **cheap** error; deleting a live checkout is not. Left in place rather than deleted, because a plan that quietly loses the recommendation it made teaches nobody why.

For the coordinator layer, the honest answer is that **there is no machine version.** Writing down how to run a falsification wave is a person writing a document, and keeping it true is a person maintaining it — the weekly ritual this plan is not allowed to propose. The narrower, self-maintaining alternative: whichever coordinator chat runs next writes its own dispatch brief into `tooling/agent-protocol/` as a side effect of running. The method gets recorded by being used, or not at all.

**Why this and not something else.** A deliberate "document the agent operating system" project produces a document true on the day it ships, in a repository whose churn data shows exactly that rotting 44 times over to the files that already try.

**What it unlocks.** Branch and worktree drift stops being something anyone notices.

**How it stays true without a human.** It does not, and that is now the decision rather than a gap — see the superseded note above. The unattended half is `pnpm wt:gc:check`, which reports the cap and deletes nothing; the deletion stays attended.

**Effort.** One attended pass whenever the cap warning fires. Zero for the rest, by design.

**Risk if we do nothing.** Drift keeps growing and the coordinator method stays in transcripts. The second risk is real and has no machine answer.

**DECISION:** Do we schedule the existing cleanup to run itself, and accept that the coordinator method stays undocumented rather than build a process to maintain it? Yes / no.

---

## A9 · The work no agent can do

**Where it stands.** This axis was missing from the first version of this document, and it is the one that most directly answers "what is actually stopping us".

**39 of 148 tracker rows are `socket` status** — deliberately unbuilt because each needs a provider account, a contract, an audit budget, a legal answer, or a repository setting only the owner can change. 17 have no owner at all. The tracker **subtracts them from its own denominator** (`tooling/scripts/tracker.mjs:243`), so a quarter of the platform is invisible on every board by construction. The same class is scattered across six documents with no single list, no count and no trend: `docs/OWNER-DECISIONS-OPEN.md`, `docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`, `docs/OWNER-ACTIONS-WALLET-RPC-SECRETS.md`, `docs/BOARD-CLEAR-HUMAN-BLOCKERS.md`, `docs/ops/OWNER-GITHUB-CONFIG.md` and `docs/LICENCE-POSITION.md`.

Four concrete items sit in this pile right now:

1. **Nine tracker rows carry your name and block work behind them.** `pay.gateway` (wip) alone gates five payments mountains through the dependency chain. Also `infra.i18n`, `trade.copy`, `trade.algo`, `trade.mm-bot`, `web.terminal`, `ws.gateway`, `academy.ambassadors`, `ops.admin`. An already-found money bug in `svc-trade` is sitting unfixed because that tree is claimed to you.
2. **Required status checks on `main` are off.** The earlier version of this document cut this as "a human in the merge path". That was wrong — required _reviews_ add a human, required _status checks_ do not. The repository already recorded the cost: `.github/workflows/supply-chain.yml` documents that **#898 merged with its supply-chain job RED, and a fixed HIGH-severity advisory came back to `main` in #904**. Only the repository owner can set this.
3. **Outbound notifications are two environment strings per channel** and nothing can leave the platform until they exist — including margin calls.
4. **Six vendored jars are unlicensed**, one of which is on the classpath of all fourteen wallet RPC modules and cannot be verified against any published artefact. Launch-blocking, and a lawyer's answer, not an agent's.

**What should change.** One script that reads `features.mjs` for `status === 'socket'` plus the named owner-action documents and prints a single ranked list — what is blocked, on whom, and what it gates. A report, not a gate. Run it on a schedule so the pile has a trend line.

**Why this and not something else.** The alternative is filing each blocker as a GitHub issue. Rejected: the board already has 35 open and 0 ever closed, so adding to it makes the pile less visible, not more.

**What it unlocks.** For the first time, one answer to "what is waiting on me" — and the payments vertical, which no amount of agent work can start while `pay.gateway` carries your name.

**How it stays true without a human.** It reads the tracker, which the swarm already maintains as a condition of claiming anything. Fails open — if it errors it prints nothing and nothing stops.

**Effort.** One agent session for the report. The blockers themselves are yours, a lawyer's, or a provider's.

**Risk if we do nothing.** A quarter of the platform stays invisible, payments cannot start at all, and a merge-while-red failure that already happened once can happen again.

**DECISION:** Do we build the blocker report, and do you release `pay.gateway` so agents can start the payments vertical? Yes / no. (Turning on required status checks is a separate, one-click GitHub setting — say yes and it goes in the same list.)

---

## The sequencing note — agreed, with two corrections

Observability, load testing, backup and disaster recovery, and data retention are one concern until something deploys. **Agreed** — there is no host, no environment and no secret delivery, so an alert would have nothing to alert on and a restore drill would restore an empty database. Two corrections:

- **Say "dashboards", not "observability".** Instrumentation is _done_: 18 tracing files, `packages/telemetry`, and the full collector/prometheus/tempo/grafana stack in `docker-compose.yml`. What is absent is dashboards and alert rules — `tooling/infra/grafana/` contains only a datasource file. Dashboards for a system that is not running are decoration; the sequencing is right, the premise wording was not.
- **Data retention is further along than "paperwork".** `services/svc-p2p/src/erasure.ts` and its tests already exist. It is a code surface with no named owner, not a written commitment awaiting a lawyer. It still belongs with compliance rather than behind the deploy.

One flag: the doctrine's §20 states hard numeric performance targets as law, one microbenchmark exists, and nothing runs it. Deferring load testing is correct — but record the deferral against §20, or the doctrine quietly stops matching reality.

---

## The dispatch plan

Five coordinator chats, and **start all five**. The earlier advice to start two is deleted: `docs/COORDINATION-TRUTH-LAYERS.md:119` lists "cap on parallel agents or open PRs for coordination" under hard rejects, `SWARM-MANDATE.md:121` targets 6–8 concurrent writers, and the record shows 715 merges in seven days with zero reverts and six pull requests writing the most contended file in the repo inside one hour with no damage. The realistic worst case of running all five is one coordinator rebasing one line.

**The shared zone — fenced to nobody, appended by everybody.** These files _are_ the claim protocol; fencing them would fence the mechanism coordinators use to avoid each other. `tooling/tracker/features.mjs`, `docs/TRACKER.md`, `docs/LIVE-LANES.md`, `docs/ops/claims/**`, and the swarm-generated `docs/ops/FREEZE-LIVE.*`, `DASHBOARD.*`, `R00-INVENTORY.md`, `R01-PR-MATRIX.md`, `R02-FREE-CLAIMS.md`.

| Chat                          | Owns                              | May write                                                                                                                                                                                       | Forbidden                                                                                                      |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **C1 — the board**            | A5, and therefore A1              | `tooling/scripts/swarm.mjs`, `tooling/ci/claim-check.mjs`, `tooling/ci/claim-staleness.mjs`, `docs/ops/SWARM-MANDATE.md`, `docs/ops/trk/**`, GitHub issues                                      | `services/**`, `vendor/**`, `docs/audit/**`, `.github/workflows/**`                                            |
| **C2 — the customer surface** | A2, and the dependency half of A7 | `vendor/**`, `.github/dependabot.yml`, `.github/workflows/supply-chain.yml`, a new vendor-compile workflow, `NOTICE`                                                                            | `services/**`, `tooling/scripts/**`, `docs/ops/**`, `docs/audit/**`                                            |
| **C3 — money correctness**    | A4, and the review half of A7     | `services/svc-{identity,agents,notify}/**`, `packages/ledger-client/**`, `services/svc-ledger/**`, `docs/audit/2026-08-09-*` onward, `tooling/ci/*-scan.mjs`                                    | `vendor/**`, `tooling/scripts/swarm.mjs`, `docs/ops/**`, `.github/workflows/**`, **`docs/audit/2026-08-08-*`** |
| **C4 — shipping**             | A3                                | a new `.github/workflows/deploy.yml`, `Dockerfile`, `docker-compose.yml`, `docker-compose.apps.yml`, `tooling/infra/**`                                                                         | `services/*/src/**`, `vendor/**`, `docs/ops/**`                                                                |
| **C5 — the estate**           | A6, A8, A9                        | `docs/**` except `docs/audit/**`, `docs/ops/trk/**`, `docs/ops/SWARM-MANDATE.md` and the shared zone; `tooling/agent-protocol/**`, `tooling/scripts/worktree*.mjs`, a new blocker-report script | `services/**`, `vendor/**`, `tooling/scripts/swarm.mjs`, `docs/audit/**`                                       |

**Two standing fences for all five.** Nobody touches `docs/audit/2026-08-08-*` — that wave's files are finished and are the record of it. And nobody implements in `services/svc-protocol` or under the `protocol.`, `chain.`, `launch.`, `mining.` or `bridge.` prefixes: that is Shehzad's plane, 18 non-socket tracker rows under owner `shehzad002`.

**One line in every coordinator brief:** run `pnpm claim:check <your paths>` before the first edit. It already exists, already fails open, takes ten seconds, and reads both the open-PR set and the tracker locks. That is the entire coordination apparatus — nothing new to build.

**A note on C3's scope.** Six of the nine unaudited services are tracker-locked today — `svc-trade`, `svc-pay`, `svc-academy` and `svc-ws` to you, `svc-dex` and `svc-protocol` to Shehzad. Until A9's claim release, C3 can only reach `svc-identity`, `svc-agents` and `svc-notify` plus the ledger packages. It is a one-third lane until you answer A9, and it becomes the most valuable lane the moment you do.

---

## The order

**C1 and C5 first, together.** They are the two that unblock everything else and they share no files.

C1 is the smallest change with the largest consequence: fill four `requires` fields, turn the money gate into a five-item allowlist, and five real mountains in trading and marketplace become dispatchable by a machine that is already merging a hundred pull requests a day. Everything else in this document proposes building something; this proposes removing a restriction from a machine that already works.

C5 first _equally_, because A9 is the axis that answers your actual question. Nine tracker rows carry your name, one of them gates the entire payments vertical, an already-found money bug is sitting unfixed behind one of them, and nothing anywhere adds that pile up. The report is one script. Until it exists, "what is next" has an answer for agents and no answer for you.

**C2 second**, as soon as C1 has merged. Four lines of `dependabot.yml` before it is anything else, and those four lines are the first vulnerability check ever run against the software customers look at.

**C3 third**, and it becomes first-class the moment A9 releases `svc-trade` and `svc-pay`. Until then it works `svc-identity` and the custody reconciliation, which is the highest-value single piece of money work in this plan.

**C4 last, and only once a host exists**, because a deploy workflow with nowhere to deploy is a file, not a capability.

**Decisions waiting: seven.** A2, A3, A4, A5, A6, A8, A9. A1 has none — it resolves with A5 and A9. A7's is a deferral you can answer in a word.
