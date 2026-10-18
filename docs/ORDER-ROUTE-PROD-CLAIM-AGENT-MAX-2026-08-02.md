# Order-route · production-claim path · agent-max (path C)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-02  
**You chose:** path **C** — production claim readiness  
**Operator:** Nitro (non-technical; out of loop)  
**Rule:** Agent closes **every** agent-legal gate. Human X is the **only** residual for “stable for real money.”

---

## 0 · What “a lot more” means (re-derived, not vibes)

Denon’s bar: _order machine hardened and stable when real money flows — orders, retries, execution._

| Layer              | Meaning of “all-out”                                                                  | Agent owns?                             |
| ------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- |
| **A code**         | Chaos F1–F8 · properties · reconcile · dual-book door · LIVE mint 0                   | **Yes — already main** (#289/#359/#365) |
| **B assembled L1** | Fleet health under CI stack                                                           | **Yes — #370**                          |
| **B assembled L2** | Edge-signed place + cancel                                                            | **Yes — #370**                          |
| **B assembled L3** | Two **funded** principals · real match · **observed fill** · **ledger balance moved** | **Yes — this ship**                     |
| **B assembled L4** | Stress: N place/cancel + **clientOrderId idempotent retry** under same stack          | **Yes — this ship**                     |
| **B honesty**      | Never invent fills/balances; STRICT fail closed; scoreboard not go-live               | **Yes**                                 |
| **C Human X**      | Real secrets · prod fleet · kill drill · go-live **yes** · counsel                    | **Never agent**                         |

**“A lot more” is not:** more UI · pay M1–M7 · shehzad Java M7 · futures invent · Docker install on laptop · go-live theater.

**“A lot more” is:** every proof that can run in **CI with money-path services** without a human clicking — plus durable Human X so Nitro knows the last seven checks by name.

---

## 1 · Implicit needs (inferred — compensate for no loop)

| Surface phrase                 | Unspoken requirement                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| “I pick C”                     | Max agent proof so Human X is the _only_ gate, not a pile of half-residuals                             |
| “won’t be in the loop”         | Self-prompt + Spec REQs + ordered iterations + auto-merge on green Class M                              |
| “figure out a lot more”        | L3 = fill **and** ledger movement; L4 = cancel storm **and** idempotent place; docs plain               |
| “without compromising quality” | STRICT fail closed; no invent; brand/secret clean; self-audit; not claim go-live                        |
| “prompt yourself”              | Compaction-proof block §2; resume from this file not chat                                               |
| “automatic decisions”          | Default safe: worktree · path-scoped PRs · edge principal · deposit recipes · CI stack not local Docker |
| Peace of mind                  | One Human X checklist he can walk without git                                                           |

---

## 2 · Self-prompt (agent — every compact / every session)

```
PATH C · ORDER-ROUTE PROD-CLAIM AGENT-MAX

WHO: Nitro @ZenYoda3 non-technical; operator mode; no git homework.
REPO: Phantom-X-007/intafaced. Worktree only. Never main checkout. Never push main.
AUTH: export GH_TOKEN from ~/.grok/agent-auth/github_token (never print).

LAW
- INTAFACED_DEFINITIVE_BUILD + AGENT_PROTOCOL + Class M self-audit on money paths.
- Never invent fills/balances. Never claim go-live / stable-for-real-money until Human X.
- Never steal Board Clear M7 / shehzad002 Java LIVE mutators.
- Never touch pay M1–M7 collision, apps/web UI waves, vendor Java dual-book PEACE lanes.
- PATHS_ONLY: order-path-*.mjs · order-path-cx8.yml · svc-trade scripts · order-route docs.

DONE LOOKS LIKE
1. CX-8 CI job green with logs: PROOF_OK assembled-health, AUTH_PLACE/CANCEL or L2,
   L3_FILL_OK + L3_LEDGER_OK, STRESS_OK, IDEMPOTENT_OK.
2. Human X doc on main (plain language X1–X7).
3. Scoreboard: CEX assembled = CI L3 proof; Human X still human.
4. PR squash-merged; not go-live language in scoreboard.

ORIENT (60s)
1. Read this file + HUMAN-X checklist + scoreboard.
2. git fetch; worktree on feat/order-route-prod-claim-agent-max or create.
3. gh pr list path-filtered; collision check open PRs pay/UI/M7.

ITERATIONS (do all; do not stop after “docs only”)
I1 Spec REQs table complete (this file).
I2 Smoke L3 two-user fill + maker/taker poll STRICT.
I3 Smoke L3 ledger available delta (buyer BTC↑, seller USDT↑) via /trpc/balance.
I4 Smoke L2 always (edge place+cancel) even when L3 on.
I5 Smoke L4 stress N place+cancel + clientOrderId double-place idempotent.
I6 Boot env TRADE_SMOKE_L3=1 STRESS_N=3 FILL_WAIT_MS≥20s.
I7 Human X checklist plain + scoreboard honesty.
I8 Brand/secret scan · commit · PR · babysit CX-8 + main CI · fix red · merge.
I9 Report: PR link · proof lines · Human X residual only.

VERIFY
- Local: syntax/node -c if no Docker; do not fake fleet green without STRICT CI.
- Remote: Order-path CX-8 workflow green on PR is the seal for B-layer L3.
- pnpm verify before claim done.

SELF-AUDIT (Class M)
- Money only via ledger recipes / trade hold-fill path.
- No balances outside ledger.
- No partner names in user copy.
- No temporary without §13 socket.
```

---

## 3 · Spec REQs (this wave — complete set)

| ID           | Requirement                                             | Acceptance                                                                |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| **PC-L2-1**  | Edge place+cancel still runs when L3 enabled            | Log `AUTH_PLACE_OK` + `AUTH_CANCEL_OK` or stress proves cancel under L3   |
| **PC-L3-1**  | Two principals funded via `recipes.deposit`             | SEED log USDT buyer + BTC maker                                           |
| **PC-L3-2**  | Maker rest sell limit; taker buy same price             | Both HTTP 2xx with order ids                                              |
| **PC-L3-3**  | Fill observed (no invent)                               | Poll GET order until filled/closed or filled qty > 0; STRICT timeout fail |
| **PC-L3-4**  | Maker also terminalized filled/closed                   | Poll maker order same wait                                                |
| **PC-L3-5**  | Ledger available moved                                  | Buyer BTC available after > before; seller USDT after > before            |
| **PC-L4-1**  | Stress N sequential place+cancel below book             | All N succeed                                                             |
| **PC-L4-2**  | clientOrderId idempotent double place                   | Same order id; one resting order; cancel once                             |
| **PC-HX-1**  | Human X checklist durable plain language                | Doc on main                                                               |
| **PC-RS-1**  | Scoreboard assembled = L3 proof only when CI path ships | Link workflow; Human X residual                                           |
| **PC-DOC-1** | This Spec + self-prompt compaction-proof                | This file                                                                 |

---

## 4 · Architect (seams)

| Seam          | Options                                                      | Pick                        |
| ------------- | ------------------------------------------------------------ | --------------------------- |
| Stack         | Local Docker · platform:up · **GH Actions + node processes** | **CI** (host has no Docker) |
| Auth          | Bearer · **edge principal**                                  | **Edge** (prod boundary)    |
| Funding       | Invent balance · **deposit recipe**                          | **Recipe**                  |
| Fill proof    | Trust 201 only · **poll order + ledger delta**               | **Poll + ledger**           |
| Stress        | Chaos unit only · **assembled sequential + idempotent**      | **Assembled L4**            |
| M7 / UI / pay | Touch · **PATHS_ONLY**                                       | **PATHS_ONLY**              |

Failure modes (honest): fill timeout if NATS/settle lag → increase FILL_WAIT_MS, never invent; deposit fail if ledger down → STRICT red; min_notional / market missing → seed SQL in smoke.

---

## 5 · Plan → build order (one PR)

1. Expand this Spec (done when file matches §3).
2. Harden `services/svc-trade/scripts/order-path-smoke.mjs` (canonical; filter runs it).
3. Mirror `tooling/scripts/order-path-smoke.mjs`.
4. Boot already sets L3/STRESS; keep FILL_WAIT_MS ≥ 20s.
5. Human X doc + scoreboard + program index pointer.
6. Brand/secret scan → commit → PR → CX-8 green → merge.

---

## 6 · Not in scope (never soft-reopen)

- Shehzad M7 Java LIVE mutators
- Futures engine invent / OTC / copy invent
- DEX execute invent (quotes already honest)
- Local Docker seeder / mongosh
- apps/web Stream A
- pay gateway M1–M7
- Go-live language without Human X

---

## 7 · Human X residual

See [`ORDER-ROUTE-HUMAN-X-PRODUCTION-CLAIM-2026-08-02.md`](ORDER-ROUTE-HUMAN-X-PRODUCTION-CLAIM-2026-08-02.md).

**After agent-max merge + CX-8 green:** high water = B L1–L4 proven in CI.  
**“Stable for real money”** = Human X X1–X6 done (X7 if counsel applies).

---

## 8 · Resume after compact

1. Open this file §2 self-prompt.
2. `git -C .worktrees/feat-order-route-prod-claim-agent-max status` (or recreate worktree from main).
3. If PR open: babysit CI; fix red; merge Class M.
4. If merged: only Human X remains for production claim.
5. Do **not** re-open A-layer chaos unless tip regressed.
