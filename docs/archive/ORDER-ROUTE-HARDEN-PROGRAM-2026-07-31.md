# Order-route / DEX–CEX money-path harden program

**Status:** DOMAIN INVENTORY · **not a plan by itself**  
**Planning / Frame law:** [`ORDER-ROUTE-FRAME-AND-PLANNING-METHODOLOGY-2026-07-31.md`](ORDER-ROUTE-FRAME-AND-PLANNING-METHODOLOGY-2026-07-31.md) — **that file owns how we approach the program** (Frame→Spec→…); this file is terrain + gap evidence for Spec only.  
**Date:** 2026-07-31  
**Session role:** high-level Nitro orchestrates; this program chat owns research → DoD → ship → adversarial → merge under law **after Frame+Spec approved**  
**Law stack:** `INTAFACED_DEFINITIVE_BUILD.md` · `AGENTS.md` · `docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md` · **Denon direction PR #272** (`docs/DIRECTION-2026-07-31.md` when merged)  
**Live tip at research:** re-derive — was `d592231` (#274) after #271 futures **recipes only**

If live git disagrees with any PR/SHA here: **git wins**. Update this file same turn when program starts.

**Do not treat W0–W8 below as permission to Build without Spec.** Waves are a draft sequencing hint; Frame+Spec supersede them.

---

## 0 · One-screen verdict (after research)

| Question                               | Answer                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did Denon mean “rebuild trade”?        | **No.** Spot order route on main is **already senior** (hold→match→fill→release + large suite).                                                                                             |
| What did he mean?                      | **Stabilize for real money:** dual-book dead, seed books honest, residual recovery gaps closed, DEX quote plane honest, retries/recovery proven under failure — **before** futures engines. |
| Course change vs residual campaign R6? | **Yes.** Denon engine order is **seed/mm-bot first**, then multi-asset, **then** futures. Residual campaign’s “futures first” is **stale** vs #272.                                         |
| Biggest silent money risk still open?  | **Dual-book Java mutators + scans that don’t enforce Option B** (ADR still “In progress” on tip until #272 merges).                                                                         |
| Can Nitro’s system handle all of this? | **Yes** for the engineering program under Class M gates + §8 carve-outs. **No** for go-live flip without human.                                                                             |
| Surprise Denon bar?                    | Chaos/ops recovery + dual-book enforcement + seed honesty + best-execution audit trail + scoreboard he can trust — not another futures PR.                                                  |

---

## 1 · Enhanced meta-prompt (this chat after green light)

```
You are the Order-Route / DEX–CEX Money-Path Hardening Program for INTAFACED
(Phantom-X-007/intafaced).

WHO NITRO IS
- High-level orchestrator only. Infer unspoken needs. Plain language for him.
- You own: research, complete named boards, worktrees, implement, pnpm verify,
  adversarial review, Class N/P/M merges under gates, LIVE-LANES claims,
  tracker honesty, WAVE-AUDIT cadence.
- He only gets: status, PR links, green/red, rare §8 drafts to send Denon,
  go-live readiness scoreboard — never git homework.

LAW (precedence)
1. INTAFACED_DEFINITIVE_BUILD.md + agent protocol (money, custody, brand)
2. docs/DIRECTION-2026-07-31.md (Denon #272) when on main — decisions, not process
3. NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md (execute + merge)
4. This program doc (completeness board)
5. Residual campaign / LIVE-LANES — use for collision; override stale engine order
   with Denon §1 (seed first)

DENON SPOKEN + WRITTEN INTENT (fused)
- Harden backend order machine for DEX + CEX so real money + all orders +
  retries + execution are stable.
- Dual-book Option B: ledger.* only book; kill Java money controllers at door;
  ban MemberWalletDao mutators in scan; extend custody-scan to Java.
- Futures NOT first. Engine order: seed/mm-bot → multi-asset → futures → OTC → TWAP.
- Seeded liquidity must be flagged; never fake user-facing volume.
- Class M: Nitro agents merge on green + self-audit + adversarial EXCEPT
  external value out, scope grants, NEW ledger recipes, posture/kill/custody.
- §8 only Denon: go-live, secrets, prod RPC, listing, fees, sanctions content, etc.

GO ALL OUT MEANS
- Named complete checklist; empty queue → rebuild; hours not 30m sprints
- Research → written DoD → smallest honest PR → verify → adversarial → merge
- Steal industry methods (idempotency, journal, chaos, TCA) — do not invent theater
- Surprise by rigor (failure proof, dual-book closed, seed honest), not by inventing
  product law or claiming go-live
- Internet leverage packs before greenfield methodology
- ≤3 parallel code lanes; respect Stream A shell ownership

HARD BANS
- Main checkout edits; force-push Denon crash WIP without triage note
- Fake balances / candles / factory done / CI green / tracker done
- Futures engine “MVP done” without his six proofs
- Scaffold copy trading; invent fee/listing recipes; claim audited/insured
- Replace our matching engine with HFT toy rewrites for latency vanity
- DEX “execute” invent while §28 svc-execution is socket

DONE FOR A SLICE
- DoD written first · pnpm verify real output · Class M self-audit + second pass
- Residual named if not closed · tracker honest · LIVE-LANES updated
```

### Nitro’s enhanced prompt (paste into future chats)

```
Program: Order-route / DEX–CEX money-path harden (docs/ORDER-ROUTE-HARDEN-PROGRAM-2026-07-31.md).

I am Nitro — high-level only. You run the whole loop (worktree, research, ship,
verify, adversarial, merge under gates). Do not hand me git homework.

Denon wants the backend order machine for DEX and CEX fully hardened and stable
for real money: all orders firing, retries, recovery, honest execution/quotes.
He gave written law in DIRECTION-2026-07-31 (#272): dual-book Option B, seed
books first, futures not first, Class M carve-outs, §8 his alone.

Go all out without laziness: complete named board, internet research leverage,
chaos/failure proof, surprise him by rigor. Deduce unspoken needs. No fake done.
Do not invent go-live or futures product law. Re-derive git + LIVE-LANES every fire.
```

---

## 2 · What Denon said — enhanced (spoken + unspoken)

### 2.1 Spoken (transcription cleaned)

| Heard                                               | Meaning                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| order route + machine on the back end               | Full lifecycle: risk → **hold** → matching → fill/cancel → ledger + **event recovery**    |
| decks and the six                                   | **DEX and CEX** planes                                                                    |
| real money · all orders firing · all retries        | Happy path is insufficient; **idempotent retries** + **no double money** under redelivery |
| angle / execution stable                            | **Execution (CEX fills) + quote/routing (DEX) stable and honest**                         |
| hell of a lot of detail · brief for Gran/Grok agent | Direction is high-altitude; **agents must expand into checklists** without inventing §8   |

### 2.2 Written same day (#272) — must fuse with spoken

Already captured in DIRECTION: dual-book B, seed first, futures not first, isolated margin later, Class M carve-outs, spine resume/abandon table, §8 list.

### 2.3 Unspoken Denon needs (inferred — surprise bar)

1. **Proof under failure**, not “tests green on happy path” — he already has strong unit coverage; he doubts **ops-grade** stability.
2. **One book enforced in code + CI**, not eleven docs still open.
3. **Depth that is not a lie** — seed books so surfaces work, without fake 24h volume.
4. **Mongo/vendored seeder actually boots** (OP_QUERY vs mongo:6).
5. **Agents that stop inventing futures order.**
6. **Scoreboard for go-live** he can trust when he flips §8.
7. **Best-execution honesty** on DEX: refuse > invent; disclose degraded multi-venue.
8. **No second silent money path** (Java mutators, shell DAO, unsigned execute).

---

## 3 · Codebase archaeology (tip) — what is already strong

### 3.1 CEX path (`svc-trade` + `svc-matching` + ledger recipes)

**Design is doctrine-true and battle-tested in unit tests:**

```
auth/scope → risk/venue hours → order row (pending) → orderHold → open
  → matching submit → tradeFill / orderHoldRelease
  → JetStream recovery consumers (at-least-once + business keys)
```

| Property                                          | Evidence on main                                        |
| ------------------------------------------------- | ------------------------------------------------------- |
| Hold **before** engine                            | Explicit in README + tests                              |
| `clientOrderId` → stable order id → same hold key | Concurrent + retry tests                                |
| Redelivered fill settles once                     | Event idempotency keys from engine sequence             |
| Partial fill + cancel releases remainder once     | Double-release trap tests                               |
| Kill-switch: new orders off, **cancel still on**  | Tests + design notes                                    |
| Engine unreachable after hold                     | Order stays open + hold (**correct** — cancel recovers) |
| Matching journal-first + fsync FileJournal        | engine tests + production boot recovers before listen   |
| §5.4 determinism (~1000 op replay)                | engine.test.ts                                          |
| Decimal strings only                              | Engine + trade tests                                    |

**Conclusion:** “Harden order route” is **not** rewrite spot. It is **close residual gaps, enforce dual-book, seed depth, prove chaos/ops, harden DEX quote plane.**

### 3.2 DEX path (`svc-dex`)

| Live                                              | Residual / socket                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Live-sourced `quote` with effective price routing | No **execute** — adapters **throw** on submit (§28 `svc-execution` not built) |
| Stale / future clock / no venue → **refuse**      | `intachain-clob` refuses (no indexer projection)                              |
| Degraded / singleVenue disclosure                 | No AMM venue (reserves not projected)                                         |
| Plane + custodial disclosure on venues            | Rate-limit governor missing (§27)                                             |
| `routePreview` renamed so it is not a price       | Fees/settlement configured not sourced (socket)                               |

**Conclusion:** DEX harden = **quote integrity + disclosure + never invent execute/fills.** Not “wire fake swaps.”

### 3.3 Dual-book / scans (still the silent failure mode)

| Surface                | State                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| ADR dual-book          | **In progress** on tip until #272 lands Option B Accepted                                            |
| `custody-scan`         | Protocol TS + Solidity only — **never Java**                                                         |
| `vendor-shell-scan`    | Bans mass-credit / TRUNCATE class — **does not ban** the four `MemberWalletDao` mutators Denon named |
| Java money controllers | Still reachable → second book by construction                                                        |

### 3.4 Futures recipes (#271)

On main: margin lock/add/release/realize-loss recipes. **Does not** mean futures product is next. Align with Denon: **recipes may exist; engine order is still seed → multi-asset → futures.**

### 3.5 Multi-asset

Migrations present on trade; remote branch `origin/feat/multi-asset-instruments` marked **RESUME** by Denon. Additive merge bar: existing spot suite unchanged.

---

## 4 · Industry / internet leverage pack (what changes the program)

### 4.1 Patterns to **steal into DoD** (not reimplement engines)

| Pattern                                                       | Source class                                                  | Our adoption                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Journal inputs only, before process**                       | LMAX / exchange-core / our own §5.1                           | Already strong in matching — **keep**; add multi-replica / ops story                                                              |
| **Business-key idempotency**                                  | Exchange ops + our ledger keys                                | Already strong — extend chaos cases                                                                                               |
| **ClOrdID uniqueness across days**                            | FIX 4.4 tag 11 guidance                                       | Document/enforce clientOrderId policy (date embed or 48-char space + unique constraint)                                           |
| **Hold-before-risk / risk-before-match split**                | exchange-core risk module vs pure book                        | We already split trade vs matching — **do not merge** money into engine                                                           |
| **Exactly-once client order ids + reconnect recovery**        | Venue-agnostic execution engines (e.g. pynecore-class design) | Map to clientOrderId + open-order reconcile after transport errors                                                                |
| **Broker conformance / fault-injection lab**                  | Offline labs that inject faults without live venue            | Build **`order-route-chaos` suite** in-repo (kill mid-path, redelivery, concurrent cancel+fill)                                   |
| **Best execution: independent benchmark, not own last trade** | Paxos / MiCA CASP best-ex trends 2026                         | DEX: keep external-sourced books; CEX: never mark “best ex” without multi-venue reference; log arrival mid vs fill for TCA socket |
| **Liquidity provider quality monitoring**                     | Paxos partner monitoring                                      | Seed/MM bot: track fill/reject, depth contribution, kill-switch; **seeded volume excluded from public 24h**                       |
| **Stale quote > bad fill**                                    | DEX aggregator risk literature                                | Already refuse stale; add rate-limit governor so 429 ≠ silent invent                                                              |
| **MEV / sandwich** (protocol plane)                           | Aggregator risk                                               | Protocol execute path (when built) needs Protect-class posture — **out of W3 CEX**; name as socket on DEX execute                 |
| **Market-making honesty / spoofing**                          | Exchange compliance practice                                  | Seed flags in model + API; no hidden orders that fake depth                                                                       |

### 4.2 Repos / tools — **study for tests & ops**, not “replace our stack”

| Asset                                                                     | Use                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `exchange-core/exchange-core`                                             | Journal/snapshot/determinism ideas; **do not port Java HFT core** over our TS doctrine split |
| LMAX Disruptor literature                                                 | Mental model only — we already have single-writer journal semantics                          |
| Property-based / concurrent test patterns (vitest + fast-check if needed) | Expand concurrent cancel/fill races                                                          |
| JetStream redelivery tests                                                | Cross-service consumer crash between fill event and settle                                   |
| `hftbacktest` / LOB replay tools                                          | Optional **replay corpus** for matching determinism — secondary                              |
| Our existing: `pnpm verify`, doctrine gates, brand/custody/vendor scans   | Primary CI — **extend**, don’t replace                                                       |

### 4.3 What research says **not** to do

- Latency vanity rewrite of matching
- RFQ/solver theater without liquidity partners
- Marking best execution without an independent reference
- Scaffolding DEX execute that returns synthetic fills
- Treating unit-test green as real-money stable

---

## 5 · Gap board (complete named residuals)

Every item is either **ship**, **prove**, **Denon §8**, or **socket**.

### G0 — Law & orientation

| ID   | Item                                        | Class  | Action                   |
| ---- | ------------------------------------------- | ------ | ------------------------ |
| G0.1 | Merge / land #272 direction + ADR Accepted  | N docs | First fire — law on main |
| G0.2 | Claim LIVE-LANES `order-route-harden`       | ops    | Coordinator              |
| G0.3 | Rebase residual R6 engine order to Denon §1 | docs   | Amend campaign pointer   |

### G1 — Dual-book Option B (highest silent risk)

| ID   | Item                                                       | Class                 | Notes                                                            |
| ---- | ---------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| G1.1 | Disable 25 money controllers **at the door**               | M / posture carve-out | May need Denon OK if “custody” carve-out; prepare PR + ask shape |
| G1.2 | `member_wallet` read-only projection path (or dead writes) | M                     | No second book                                                   |
| G1.3 | Ban four DAO mutators in `vendor-shell-scan`               | P/M                   | Scan invert                                                      |
| G1.4 | `custody-scan` walks **Java** under vendor                 | P                     | Denon named gap                                                  |
| G1.5 | Close eleven dual-book doc dependents / tracker honesty    | N                     | After code                                                       |

### G2 — CEX order-route residual (beyond existing suite)

| ID   | Item                                                                                                         | Class   | Notes                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------- |
| G2.1 | **Chaos suite**: kill between hold and engine submit; redelivery storm; concurrent cancel+fill               | M tests | Industry “conformance lab”                                          |
| G2.2 | **Indeterminate submit recovery**: operator/job or documented cancel path auto-reconcile open+hold vs engine | M       | Design already says cancel recovers — automate + prove              |
| G2.3 | Pending-row sweeper (crash after insert before hold)                                                         | P       | Already delete on hold fail — prove crash window                    |
| G2.4 | Multi-replica matching journal story                                                                         | eng     | Single FileJournal today — document HA bar or single-writer enforce |
| G2.5 | Snapshot sink durability (MemorySnapshotSink in prod boot?)                                                  | eng     | Verify production config                                            |
| G2.6 | clientOrderId uniqueness policy (day-scope / global)                                                         | P       | FIX guidance                                                        |
| G2.7 | End-to-end platform: trade + matching + ledger + NATS under `platform:up`                                    | M       | Integration proof                                                   |
| G2.8 | Reconcile job: open orders hold vs ledger hold vs engine live                                                | M       | Conservation                                                        |

### G3 — DEX plane

| ID   | Item                                                                                                                            | Class          | Notes            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------- |
| G3.1 | Adversarial quote matrix (stale, future, degrade, partial, effective price) already strong — **extend** rate-limit 429 behavior | P              |                  |
| G3.2 | Never implement synthetic submit                                                                                                | ban            | Keep throw       |
| G3.3 | When AMM reserves projectable: venue adapter without inventing reserves                                                         | later          | Depends protocol |
| G3.4 | Best-execution **audit fields** on quote response (venues asked, ages, effective prices)                                        | P              | TCA foundation   |
| G3.5 | Shell never renders `routePreview` as price                                                                                     | Stream A coord | Honesty          |

### G4 — Seed books / mm-bot (Denon #1 engine order)

| ID   | Item                                                                   | Class     | Notes                   |
| ---- | ---------------------------------------------------------------------- | --------- | ----------------------- |
| G4.1 | Resume `feat/spine-market-seeder` + **Mongo driver pin**               | eng       | Unblocks vendored stack |
| G4.2 | Seeded order flag in data model + API                                  | M product | Denon non-negotiable    |
| G4.3 | Exclude seeded volume from user-facing 24h / depth stats               | M         | Honesty                 |
| G4.4 | Bot killable via kill-switch                                           | M         |                         |
| G4.5 | Prove bot never manufactures unfair crosses vs real users (tape proof) | M         | Denon                   |

### G5 — Multi-asset (Denon #2)

| ID   | Item                                         | Class       | Notes                  |
| ---- | -------------------------------------------- | ----------- | ---------------------- |
| G5.1 | Rebase `feat/multi-asset-instruments` on tip | eng         | Resume, not greenfield |
| G5.2 | Additive: spot suite identical               | proof       |                        |
| G5.3 | Missing schedule entry → refuse, not throw   | P           |                        |
| G5.4 | Forex/commodities list only when rails exist | product law | Don’t list prod        |

### G6 — Adjacent money (same “real money” story)

| ID   | Item                                              | Class      | Notes       |
| ---- | ------------------------------------------------- | ---------- | ----------- |
| G6.1 | Pay durable broadcast journal (#266 or successor) | M          | Denon §3 #1 |
| G6.2 | Pay external-value / scope grants stay §8         | ban invent |             |
| G6.3 | Futures **engine** not started until G4+G5 bar    | program    | Recipes OK  |

### G7 — Ops / go-live scoreboard (human §8)

| ID   | Item                                                       | Owner               |
| ---- | ---------------------------------------------------------- | ------------------- |
| G7.1 | Secrets rotation / heapdump residual                       | Nitro human + Denon |
| G7.2 | Kill drill e2e sign-off                                    | Nitro human         |
| G7.3 | Prod RPC / signing custody                                 | Denon §8            |
| G7.4 | Sanctions content                                          | Counsel             |
| G7.5 | **Readiness scoreboard** (agent-maintained, human-flipped) | This program        |

### G8 — Explicit out of program (do not “helpfully” build)

Copy trading · iceberg · cross-margin · leverage param invent · card UI · claim protocol.amm done on anvil · replace matching engine · force-push abandoned spines without triage

---

## 6 · Wave plan (execution order after green light)

| Wave   | Goal                                                                             | Exit proof                                                  |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **W0** | Orient tip · merge #272 · claim lane · amend R6 order pointer                    | Direction on main; LIVE-LANES claim                         |
| **W1** | Research already done — freeze gap board; optional leverage deep-dives per slice | This doc linked from START-HERE / residual campaign         |
| **W2** | Dual-book enforce (G1)                                                           | Scans red on mutators; controllers dead at door; ADR closed |
| **W3** | Order-route chaos + recovery (G2)                                                | New suite green; reconcile documented/job                   |
| **W4** | DEX quote harden + audit fields (G3)                                             | Adversarial tests; no execute invent                        |
| **W5** | Seed / mm-bot honesty (G4)                                                       | Seeded flags + volume exclusion + kill                      |
| **W6** | Multi-asset resume (G5)                                                          | Spot suite unchanged                                        |
| **W7** | Adjacent pay broadcast (G6) if open                                              | Class M gates                                               |
| **W8** | WAVE-AUDIT + readiness scoreboard (G7)                                           | Denon can judge real-money posture                          |

**Parallelism:** ≤3 lanes (e.g. dual-book scan work ∥ chaos suite ∥ seed research) with LIVE-LANES.

**Class M recipe changes:** draft PR + Denon carve-out ask — never silent merge.

---

## 7 · Methodology (right research frame + anti-laziness)

### 7.1 Every slice

1. Re-derive `origin/main` + open PRs + LIVE-LANES
2. 1-page research note if greenfield or money
3. Written DoD (pass/fail)
4. Worktree · implement · `pnpm verify` real output
5. Class M: second-agent adversarial or cool-down pass
6. Merge under matrix + Denon carve-outs
7. Tracker honesty + residual named
8. Rebuild NEXT QUEUE — never stop at “one PR shipped”

### 7.2 Chaos matrix (minimum for “stable under real money”)

| Scenario                                 | Expected                                                    |
| ---------------------------------------- | ----------------------------------------------------------- |
| Retry same clientOrderId × N concurrent  | One order, one hold                                         |
| Fill event redelivered × N               | One tradeFill                                               |
| Cancel after partial × redelivery        | One remainder release                                       |
| Engine HTTP 500 after hold               | Open + hold; cancel → release if never live                 |
| Engine accepts, trade dies before settle | Recovery consumer settles                                   |
| Kill-switch mid-day                      | New refuse; cancel works                                    |
| Matching restart mid-book                | Journal replay byte-identical; no double fill on bus replay |
| Seed bot + real user                     | Tape distinguishes seed; public volume honest               |

### 7.3 Readiness scoreboard (what “stable” means without claiming go-live)

| Axis        | Green when                                                   |
| ----------- | ------------------------------------------------------------ |
| Books       | Dual-book Option B enforced in code + scans                  |
| CEX route   | Chaos matrix green + reconcile job/path                      |
| DEX         | Quote refuses invent; execute still honest socket            |
| Depth       | Seed books live + honesty flags                              |
| Instruments | Multi-asset additive or explicit residual                    |
| Rails       | Durable broadcast at least; go-live still §8                 |
| Ops         | Kill drill, secrets, counsel listed as open or done by human |

---

## 8 · Collision map (other work)

| Surface                              | Rule                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| Stream A Wave A PRs (#267 etc.)      | Do not steal shell files; coordinate dual-book **labels** only |
| Residual campaign R6 “futures first” | **Override** with Denon seed-first                             |
| #271 recipes on main                 | Do not build futures engine in this program’s early waves      |
| #266 pay broadcast                   | Compatible adjacent lane                                       |
| Denon spine branches                 | Follow #272 table; seeder = priority resume                    |

---

## 9 · Enhanced “better” definition

**Better** = more of Denon’s real-money bar proven, with less invention and less silent risk:

1. Dual-book cannot move value
2. Spot path proven under chaos, not only unit happy paths
3. Seed depth without market lies
4. DEX never misleads on price or custody plane
5. Engine roadmap respects his order
6. Scoreboard so “stable” is checkable
7. You stay out of the loop except §8 and green lights

**Not better** = more features, more PRs, futures theater, HFT rewrite, fake green.

---

## 10 · Immediate next actions (when Nitro says execute)

1. Worktree from tip (not main checkout)
2. Land #272 if not merged (docs Class N)
3. Update LIVE-LANES claim `order-route-harden`
4. Open W2 dual-book implement plan from G1 inventory (Java controller list from vendored tree)
5. Parallel: scaffold `order-route-chaos` test package outline (G2.1)
6. Do **not** start futures engine or DEX execute

---

## 11 · Research sources (non-exhaustive)

- In-repo: svc-trade/matching/dex READMEs + test suites; DIRECTION #272; residual campaign; VENDORED-OVERLAP-AUDIT; dual-book ADR
- Industry: FIX ClOrdID uniqueness; exchange-core journal/snapshot model; Paxos best-execution 2026 (independent benchmark, LP monitoring); DEX aggregator stale/MEV risk literature; market-making honesty / seed flag practices
- Tooling: vitest concurrency, JetStream redelivery, our doctrine scans

---

## 12 · Changelog

| When       | What                                                   |
| ---------- | ------------------------------------------------------ |
| 2026-07-31 | Initial research funnel + hardened program (this file) |
