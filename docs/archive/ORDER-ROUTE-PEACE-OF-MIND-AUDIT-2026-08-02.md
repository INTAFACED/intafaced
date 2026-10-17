# Order-route Spec v1 — peace-of-mind audit

**Date:** 2026-08-02  
**Auditor:** fresh re-check against `origin/main` (not chat memory)  
**Spec:** `docs/ORDER-ROUTE-SPEC-v1-2026-07-31.md`  
**Ship:** [#289](https://github.com/Phantom-X-007/intafaced/pull/289) → **MERGED** `e29748f` (2026-08-01) as Board Clear **A-OR-1**  
**Verdict:** **Agent Spec program is closed properly.** Not go-live. Residuals are named and mostly not “easy.”

---

## 0 · What “done properly” means (Spec’s own bar)

Spec finish is **not** “stable for real money.” It is:

1. Every REQ **proven green** with checkable evidence, **or**
2. **Honest residual** with owner + why agent cannot close it.

Phase 8 (Ship) for this program = code **on main**. That is now true.

---

## 1 · Live ship facts (re-derived 2026-08-02)

| Fact                   | Evidence                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #289 state             | **MERGED** 2026-08-01 · title “Spec v1 harden complete”                                                                                                      |
| Merge on main          | `e29748f` in `git log origin/main`                                                                                                                           |
| Board Clear            | `docs/BOARD-CLEAR-SCOREBOARD.md` row **order-route #289 = DONE** (#339)                                                                                      |
| Artifact files on main | chaos / properties / reconcile / seed tests · migration `0004_order_seeded` · door + java-money scans · `order-path-smoke` · Spec + finish gate + scoreboard |
| CI at merge            | Doctrine / Typecheck / Tests / DoD **SUCCESS** on the merge PR (checks recorded on #289)                                                                     |

---

## 2 · REQ-by-REQ adversarial matrix

Legend: **G** = green with code/test/CI evidence on main · **R** = honest residual · **B** = ban/bound satisfied · **W** = weaker than Spec wording but still defensible

### Law / orientation

| REQ  | Verdict | Proof on main                                                         |
| ---- | ------- | --------------------------------------------------------------------- |
| LW-1 | **G**   | DIRECTION / dual-book era on tip; #272 era referenced in program docs |
| LW-2 | **G**   | LIVE-LANES updated in #289 merge body (P-OR / order-route claim)      |
| LW-3 | **G**   | Residual seed-first pointer in campaign/finish docs                   |

### Dual-book

| REQ  | Verdict       | Proof on main                                                                                                    | Gap honesty                                                                                                |
| ---- | ------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| DB-1 | **G** (depth) | DAO mutators no-op (`WHERE 1=0` style) · service throws · HTTP door 410 · scans                                  | Entity `setBalance` lines still exist (~28 live call sites) — **defense in depth, not zero-entity-writes** |
| DB-2 | **G** / **W** | `DualBookMoneyDoorInterceptor` + `scan:dual-book-door` proves class + registration on admin/ucenter/otc/exchange | **No JVM live 410 smoke in CI** — wiring proven, runtime Spring not exercised                              |
| DB-3 | **G**         | `pnpm scan:vendor-java-money` in CI forbids live JPQL for increase/decrease/freeze/thaw                          |
| DB-4 | **G**         | Spec allows “custody-scan **or successor**”; Java money scan is the successor in CI                              |
| DB-5 | **G**         | No reverse Java→ledger write recipe invent in this program; dual-book ADR posture Accepted era                   |

**Residual (named, Board Clear):** **H-OR-JAVA** — entity-level setBalance / Spring residual after #289, owned **shehzad002** (human), must not start before A-OR-1 closed (now closed).

### CEX order route

| REQ              | Verdict | Proof on main                                                                                    | Gap honesty                                                                                            |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| CX-1…6,10,12     | **G**   | Pre-existing trade suite + chaos/reconcile extensions; stop refuse remains                       | —                                                                                                      |
| CX-7 F1–F7       | **G**   | `order-route-chaos.test.ts` named describes F1–F7                                                | Stale header comment still says “F5–F8 later” — **doc debt only**                                      |
| CX-7 F8          | **G**   | Seed suite: “chaos F8 / SD-3 — seed volume excluded from public tape”                            | Lives in seed test file, not chaos file — still covers Spec F8                                         |
| CX-7 F6 fidelity | **W**   | Test is **journal redelivery** of fill/cancel, not a real matching **process** restart           | Spec text is “Matching restart mid-book”; implementation is the journal-idempotency half of that story |
| CX-8             | **R**   | `tooling/scripts/order-path-smoke.mjs` · **HONEST_SKIP** without fleet · optional STRICT         | Full two-user assembled fleet proof **not** green as forced CI                                         |
| CX-9             | **G**   | `reconcileOrder` + tests: orphan pending · open+hold no engine · open+engine no hold fail-closed | —                                                                                                      |
| CX-11            | **G**   | `services/svc-trade/README.md` clientOrderId policy section                                      | —                                                                                                      |

### DEX

| REQ    | Verdict | Proof on main                                                                               |
| ------ | ------- | ------------------------------------------------------------------------------------------- |
| DX-1…8 | **G**   | `svc-dex` quote suite (stale refuse, 429 degrade, no invent, submit refuse, degraded flags) |
| DX-9   | **G**   | `router.mount.test.ts` — `routePreview` arithmetic, not live price                          |

### Seed

| REQ  | Verdict       | Proof on main                                                           | Gap honesty                                                 |
| ---- | ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| SD-1 | **R** (ops)   | `vendor/.../seed-market-data.mjs` **on main**                           | Live compose boot not agent-proven (no docker in agent env) |
| SD-2 | **G**         | Column + API `seeded` + tests                                           | —                                                           |
| SD-3 | **G**         | `publicTape` SQL excludes seeded · candle volume test                   | —                                                           |
| SD-4 | **G**         | Kill-switch refuses seeded place                                        | —                                                           |
| SD-5 | **G**         | Make-only: refuse seed market; force TIF `PO`                           | —                                                           |
| SD-6 | **G** / **R** | Driver pin / seeder code on tip; residual is **boot**, not missing code | Ops                                                         |

### Multi-asset / pay / futures bounds

| REQ    | Verdict             | Proof on main                                                                       |
| ------ | ------------------- | ----------------------------------------------------------------------------------- |
| MA-2/3 | **G**               | Schedule refuse tests in `risk.test.ts` (fx Saturday → `trade.market_closed`)       |
| MA-1/4 | **G** / product law | Resume path + listing honesty; forex not silently production-tradable without rails |
| PY-1   | **G**               | Pay broadcast journal path on main (#266 era + rails files)                         |
| PY-2   | **B**               | No merchant/card/go-live invent in this PR                                          |
| FT-1…4 | **B**               | Futures engine not claimed done; copy not scaffolded as product of this program     |

### Security / scoreboard

| REQ    | Verdict   | Proof on main                                                |
| ------ | --------- | ------------------------------------------------------------ |
| SC-1…3 | **G**     | custody-scan CI + existing trade tests                       |
| SC-4   | **R** (X) | Scoreboard Human X — never agent-green                       |
| SC-5   | **G**     | `ORDER-ROUTE-PROGRAM-FINISH` is the WAVE-AUDIT for this wave |
| RS-1   | **G**     | Living scoreboard                                            |
| RS-2   | **G**     | Explicit “not stable-for-real-money / not go-live”           |

### Global constraints (sample)

| ID     | Verdict         | Notes                                                                     |
| ------ | --------------- | ------------------------------------------------------------------------- |
| GC-1…2 | **G**           | Ledger path + brand-scan clean on ship                                    |
| GC-3   | **G** (shipped) | Class M self-audit in #289 body; Board Clear merged A-OR-1                |
| GC-4   | **B**           | No go-live / secrets / prod RPC claimed                                   |
| GC-5   | **B**           | Futures engine not early-shipped as product invent                        |
| GC-7   | **W**           | This doc is the delayed fresh Verify pass; builder did self-grade at ship |

---

## 3 · What was overstated earlier (correcting the record)

| Earlier phrasing                 | Correction after audit                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Waiting on Denon to merge”      | **False now.** #289 **already merged** 2026-08-01. Ownership law also lets Nitro agents merge Class M under gates — Denon is direction, not default merge gate. |
| “Agent-finished but not on main” | **Stale.** Program is **on main**.                                                                                                                              |
| “Dual-book fully closed”         | **Too strong.** Layers (door + DAO + service throws + scans) are real; **entity setBalance residual** is intentionally open as **H-OR-JAVA**.                   |
| “F1–F8 chaos complete”           | **Mostly true.** F1–F7 in chaos file; F8 in seed file; F6 is journal proxy not full process restart.                                                            |
| “Everything residual is hard”    | **Mostly true.** Only easy leftover is tiny comment cleanup.                                                                                                    |

---

## 4 · Still open — ease rating

| Open item                                            | Blocks “Spec agent done”? | Blocks “real money peace”?    | Easy?                                           |
| ---------------------------------------------------- | ------------------------- | ----------------------------- | ----------------------------------------------- |
| **Nothing left on #289 merge**                       | No — merged               | No                            | —                                               |
| **CX-8 fleet two-user assembled smoke**              | No (honest residual)      | Partially (proves live stack) | **Not easy** — needs fleet up + two principals  |
| **Seeder compose boot prove**                        | No (ops residual)         | Depth / thumbs                | **Medium** — machine with docker compose        |
| **H-OR-JAVA entity setBalance cleanup**              | No (named residual)       | Dual-book depth               | **Hard** — human shehzad track; Class M posture |
| **Human X** (secrets, go-live, prod RPC, kill drill) | No (always X)             | **Yes for go-live**           | **Human only**                                  |
| **Stale “F5–F8 later” comment**                      | No                        | No                            | **Easy** (cosmetic)                             |
| **JVM 410 live smoke in CI**                         | No (wiring residual)      | Confidence                    | **Medium–hard** (Java CI boot)                  |
| **F6 true matching process restart**                 | No (W)                    | Confidence                    | **Medium** (test harness upgrade)               |

---

## 5 · What “finish with peace of mind” means (so you can close the chat)

### You may close this chat with peace of mind if you accept:

1. **The Spec v1 order-route harden program is shipped** — code + tests + scans + scoreboard **on main** via #289.
2. **Agent definition of finished is satisfied** — every REQ green or residual-named; no silent Spec hole found in this audit.
3. **This is not “stable for real money.”** That bar needs Human X + (ideally) fleet assemble + ops seeder + optional H-OR-JAVA depth.
4. **Board Clear already marks order-route #289 DONE.** Further dual-book depth is a **new human track** (H-OR-JAVA), not unfinished #289.

### You do **not** need to:

- Wait for anyone to merge #289 (already merged)
- Re-open chaos / seed / reconcile work as “missing”
- Invent futures / go-live / secret rotation in this program

### Optional later (separate programs — not this chat’s debt):

- Run fleet CX-8 when stack is up
- Boot seeder on a compose machine
- H-OR-JAVA for remaining Java entity mutators
- Human X only when you intentionally go live

---

## 6 · Bottom line

| Question                            | Answer                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Was what we claimed basically true? | **Yes**, with the corrections in §3 (merge already done; dual-book residual still real).                               |
| Was Spec done properly?             | **Yes for agent Spec ship.** Evidence on main matches Spec acceptance for the non-residual REQs; residuals are honest. |
| Anything still open that is easy?   | **Only cosmetic** (stale test header). Everything else open is ops/human/depth.                                        |
| Can you close this chat?            | **Yes** — program closed on main; remaining items are a **different** backlog, not unfinished Spec theater.            |

**Not go-live. Not stable-for-real-money.**  
**Spec v1 order-route harden: SHIPPED.**
