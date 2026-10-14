# ADR: drop-copy completeness contract — replay, gap-fill, independent session

**Status:** proposed  
**Status note:** **Proposed (spec).** Completeness is **false** on tip. This file does not claim complete.  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Plane:** Fiat house book only. INTACORE does not emit FIX.  
**Does not edit:** `feat/svc-fix-dropcopy-hitch` (ingest in flight). Does not add `svc-chain`. Does not invent CompIDs.

**Ground truth on tip:**

- Drop-copy is a **second FIX session**. Blank `FIX_DROPCOPY_*` refuses. Port and CompIDs must not equal order-entry (`FixDropCopyConfig.requireIndependent`).
- Required sources: `ui`, `rest`, `ws`, `fix`, `algo`, `liquidation`, `rfq`, `broker` (`DropCopyCatalog.REQUIRED`).
- Streamable today: **`fix` only**. The process must not synthesize the others.
- `claimComplete()` is incomplete unless every required source has **actually published** and is streamable. The streamable list alone must not mint completeness.
- Order-entry session already has a sequence-gap → ResendRequest test (`FixAcceptorSessionTest.sequenceGapProducesResendRequest`). That is **not** drop-copy fill replay.

Ingest of fills into this hub is a **different PR** (svc-fix hitch). This ADR is the completeness contract that ingest, publishers, and later replay must not violate.

---

## Decision

> **A drop-copy session that cannot prove it has the same fills as the house, in order, with gaps detectable and fillable, is a drop-copy that lies.** Completeness is a claim about **sources that published**, plus **replay / gap-fill / interval**, plus **independent credentials**. It is never a green light because FIX order-entry works.

Do not fake-close. `ui` is FRONTEND (Codex). Missing publishers stay named missing.

---

## 1 · Independent credentials (already law; keep)

| Rule                   | Tip                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Second session         | `FixAcceptorMain`: drop-copy is not order-entry.                                                                   |
| Env                    | `FIX_DROPCOPY_BEGIN_STRING`, `SENDER_COMP_ID`, `TARGET_COMP_ID`, `SOCKET_ACCEPT_PORT`, `HEARTBTINT`, `STORE_PATH`. |
| Blank                  | `dropcopy_unconfigured` — do not start order-entry-only as a stand-in.                                             |
| Same port as OE        | `dropcopy_not_independent`.                                                                                        |
| Same CompID pair as OE | `dropcopy_not_independent`.                                                                                        |
| CompID **values**      | Owner-set. Agents do not git-default a map.                                                                        |

A later ingest path must not bind to the order-entry session “for convenience.”

---

## 2 · Completeness is a census of publishers

`DropCopyCatalog.claimComplete(published)`:

| Condition                                             | Result                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| A required source is not streamable                   | **Incomplete** (it is missing even if someone wishes it published).  |
| A required source is streamable but has not published | **Incomplete**.                                                      |
| Completeness derived from `STREAMABLE` alone          | **Forbidden.** Catalog comment: never mint from the streamable list. |
| All required are streamable **and** have published    | Complete — and **only then**.                                        |

On tip this is structurally incomplete: `STREAMABLE = [fix]`, `REQUIRED` has eight names. Shipping ingest for `fix` does not complete the census.

**Publishers (house book, after ingest exists):** the real fill bus — `svc-trade` / matching fills — one service per PR, **no ledger post on the FIX path**. FIX drop-copy is a report of fills the ledger (or the engine proposal, labelled pending) already knows. It is not a second money book.

`ui` publisher = Codex. Backend synthesizing UI executions = the defect the catalog forbids.

---

## 3 · Replay (missing on drop-copy)

When a drop-copy client connects or sends ResendRequest:

| Rule                                                                                       | Meaning                                                                                                     |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Replay is from a **durable fill log** keyed by drop-copy sequence, not from adapter memory | Crash between publish and TCP must not drop a fill forever.                                                 |
| ResendRequest (FIX 4.4: BeginSeqNo / EndSeqNo)                                             | Retransmit those execution reports. Gap is the client’s to detect; the acceptor must be able to fill it.    |
| Sequence reset / gap on the drop-copy session                                              | Must produce ResendRequest **on that session**, not on order-entry. OE’s existing test does not cover this. |
| Replay must not invent fills                                                               | If the log has no execution for that sequence, refuse / gap — do not synthesize.                            |
| Replay must not post the ledger                                                            | Report only.                                                                                                |

**Store:** blank `FIX_DROPCOPY_STORE_PATH` keeps an in-memory session (`ResetOnLogon=Y`) — restart forgets fills. An owner directory that already exists turns on QFJ `FileStore` and **no** reset, so ResendRequest can replay. svc-fix does not mkdir a path and does not default `/tmp`. Completeness still refuses while `ui` is FRONTEND.

---

## 4 · Gap-fill

| Rule                                     | Meaning                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher sequence vs drop-copy sequence | If the hub skips a source sequence, the client must see a **detectable** gap (FIX sequence), not a quietly short blotter.                                                                                                                                                   |
| Snapshot + stream                        | Same honesty as `venue-contracts` `MarketDataAdapter`: subscribe **before** snapshot if both exist, or the gap between them is invisible. Drop-copy is execution reports, not depth; the analogue is: do not start streaming at “now” while advertising a historical start. |
| After ingest                             | A publisher that has not actually published is **missing**, not an empty interval.                                                                                                                                                                                          |

---

## 5 · Interval completeness

A client that was connected for `[t0, t1]` must be able to ask: “were all fills from required **published** sources in that interval sent on this session?”

| Answer              | When                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| **No / incomplete** | Any required source missing, or replay log cannot cover the interval, or ingest was down.            |
| **Yes**             | Catalog complete **and** the durable log covers `[t0, t1]` **and** drop-copy sequence is contiguous. |

A heartbeat with no executions is **not** interval completeness. Silence can mean “no fills” or “we dropped them.” Only the log distinguishes.

Owner hole: how long the durable log is retained. Blank → do not advertise a retention interval.

---

## 6 · Tests that would go red

A FIX engineer opens **this file**, then:

1. `claimComplete()` with only `fix` published → incomplete, missing includes `ui,rest,ws,algo,liquidation,rfq,broker`.
2. `claimComplete()` with all eight **named** but only `fix` streamable → still incomplete (cannot mint from wishes).
3. Independent: OE port == drop-copy port → `dropcopy_not_independent`.
4. Blank `FIX_DROPCOPY_*` → unconfigured; OE must not stand in.
5. Blank `FIX_DROPCOPY_STORE_PATH` → memory, `ResetOnLogon=Y`, no invented directory. Owner directory → `FileStorePath` + `ResetOnLogon=N` on the **drop-copy** session only (order-entry stays reset). Missing seq does not invent a fill.
6. Ingest down for an interval → interval completeness **false**, even if the session stayed heartbeating.
7. A publisher posts a ledger recipe on the FIX path → **forbidden** (wrong mountain).

Pins already on tip (keep green): `FixDropCopyTest` independent credentials; `DropCopyCatalog` / hub completeness refuse; OE `sequenceGapProducesResendRequest` (OE only).

---

## Refuse cases

| Situation                                                    | Correct answer                       |
| ------------------------------------------------------------ | ------------------------------------ |
| “FIX is up, so drop-copy is complete”                        | **Incomplete.** Census + replay.     |
| Synthesize UI/REST/WS/algo/liquidation/RFQ/broker executions | **Forbidden.**                       |
| Share OE CompID / port                                       | **`dropcopy_not_independent`.**      |
| Ingest PR claims complete                                    | **No.** This contract still refuses. |
| Dual-edit `feat/svc-fix-dropcopy-hitch` from a docs session  | **Stop.** Path-intersect.            |
| Invent CompID map / ports                                    | **Owner env.**                       |
| Drop-copy as a second ledger                                 | **No.** Report only.                 |

---

## What is not this mountain

- INTACORE / FIX on chain.
- Codex Vue publishing `ui`.
- Building all seven missing publishers in one PR (one service per PR; after ingest).
- Professional care-order OMS (`svc-execution` already refuses care; different room).

---

## Done bar (this ADR)

**Spec done:** replay / gap-fill / independent session / interval / census are named; completeness stays refuse until they are true.

**Product done:** all eight sources streamable **and** published **and** drop-copy ResendRequest proven **and** interval query honest. That is **not** this commit.

## What agents may do without asking again

- Keep catalog completeness refuse.
- After ingest merges: publishers one service per PR; drop-copy durable log + ResendRequest on **that** session.
- Do not race the ingest worktree.

## What still needs the owner / Codex

- CompID / port / heartbeat values (env).
- Log retention interval.
- `ui` publisher (Codex).
- Whether broker / RFQ / algo are in-scope for the first complete census or stay named missing longer (catalog already lists them required — shrinking REQUIRED is an owner ADR, not a silent edit).
