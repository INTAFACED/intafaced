# 03C — L4 Plane · L5 Edge · L6 Mount · L7 Terminal — PR #228

**Scope:** AMM compile honesty + terminal equity/charts + owner ops checklist  
**Tip (freeze):** `4b77c173cd04c1d347da53cefaecb0c8fdd42c0c`  
**Primary:** PR #228 AMM compile + terminal equity/charts + owner ops checklist  
**Method:** CODE-REVIEWED (read-only deep-read of named surfaces). **Not** MONEY VERIFIED E2E.  
**UTC:** 2026-07-31

---

## Question map (7)

| #   | Question                                                    | Answer                                                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | AMM invent success addresses / 0x0 success / fake reserves? | **No.** Chain-sourced reads refuse; 0x0 factory refused on `buildCreatePool`; pure quote labeled `reservesFromChain: false`.                                 |
| 2   | Artifacts honest about compile vs deploy?                   | **Yes (code + out/).** Compile suite `expect: 'compiles'`; artefacts committed with `sourceHash`; deploy still not claimed. Stale **docs** residual (below). |
| 3   | Account equity → real ledger projection or invent balances? | **Real path:** edge → trade `GET /api/v1/account/balance` → `userBalances` → ledger; empty `{}` honest; unsigned → fail.                                     |
| 4   | Dual-book labeled? money as `number` in UI?                 | Dual-book **labeled**. Wire free/used/total stay **decimal strings**. Chart uses `Number()` only for SVG geometry (display), not as stored money.            |
| 5   | Charts invent OHLCV or honest empty?                        | **Honest empty** `[]` end-to-end; no fabricated candles.                                                                                                     |
| 6   | Mount/register: claimed done but not edge-routed?           | **No.** Terminal mounts both panels; both use `edge.restGet` on `/api/v1/*` (preservePath → trade).                                                          |
| 7   | Owner ops checklist invents agent-done human items?         | **No.** Explicitly human/counsel/Denon mountains; does not mark them done.                                                                                   |

---

## Findings

| id                        | layer | file:line (approx)                                                          | claim                                                                             | severity | evidence                                                                                                                      | status                                             |
| ------------------------- | ----- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **DOC-AMM-STALE**         | L4/L8 | `services/svc-protocol/README.md:287`                                       | Still says **`ConstantProductPool` does not compile** after #228 fixed compile    | **P2**   | Contradicts same file L237 + `contract-sources.mjs` `expect: 'compiles'` + committed `contracts/out/ConstantProductPool.json` | **OPEN residual** (docs only; runtime honest)      |
| **DOC-COMPILE-HDR**       | L4    | `services/svc-protocol/scripts/compile-contracts.mjs:12-13`                 | Header still: pool "does not compile and never has"                               | **P2**   | Stale narrative vs suite/tests                                                                                                | **OPEN residual**                                  |
| **TEST-GAP-CREATEPOOL-0** | L4    | `router.ts:804-809`                                                         | Zero-factory refusal on `buildCreatePool` has no dedicated test hit in suite grep | **P2**   | Code refuses `isZeroAddress(factory)`; no matching `it(...)` found                                                            | **OPEN residual** (behavior present)               |
| L4-AMM-RESERVES           | L4    | `client.ts:242-265`, `router.ts:668-791`, `router.mount.test.ts:329-350`    | `poolReserves` / `quoteFromPool` never invent zero reserves                       | —        | Refuse `chain_unreachable` / not_deployed; explicit anti-zero-reserve tests                                                   | **HOLDS**                                          |
| L4-AMM-0x0-FACTORY        | L4    | `router.ts:804-809`, `env.ts` default 0x0, `availability.ts:162-167`        | 0x0 factory does not yield success CREATE2 product surface                        | —        | `PRECONDITION_FAILED` + documented fictional-address failure mode                                                             | **HOLDS**                                          |
| L4-AMM-QUOTE-LABEL        | L4    | `router.ts:638-666`, mount test 422-437                                     | Caller-supplied reserves cannot be mistaken for chain quote                       | —        | `reservesFromChain: literal false \| true`                                                                                    | **HOLDS**                                          |
| L4-AMM-ORIENT             | L4    | `router.ts:755-774`, mount test 387-400                                     | Unknown `tokenIn` not defaulted to token1                                         | —        | `amm.token_not_in_pool`                                                                                                       | **HOLDS**                                          |
| L4-ARTIFACTS              | L4    | `artifacts.ts`, `artifacts.test.ts:197-239`, `contract-sources.mjs:131-142` | Compile ≠ deploy; missing artefact fails load; ABI match                          | —        | `MissingArtifactError`; sourceHash gate; AMM suite compiles                                                                   | **HOLDS**                                          |
| L4-BYTECODE               | L4    | `contracts/out/{ConstantProductPool,PoolFactory}.json`                      | Real bytecode committed (not stub)                                                | —        | `_generated` header; non-empty bytecode; suite `amm`                                                                          | **HOLDS**                                          |
| L4-BUILD-UNSIGNED         | L4    | `amm/build.ts`                                                              | Call builders return unsigned `{to,data,value:0}` only                            | —        | No deploy/tx/success address invent                                                                                           | **HOLDS**                                          |
| L5-EDGE-V1                | L5    | `svc-edge/src/routes.ts:69`, `edge-client.ts:195-222`                       | `/api/v1/*` preservePath → trade                                                  | —        | routes test + rest client absolute path                                                                                       | **HOLDS**                                          |
| L5-BALANCE-GATE           | L5/L3 | `private-rest.ts:575-588`                                                   | Self-only principal; `trade:read`; ledger projection                              | —        | `principal.userId` only; `presentCcxtBalances` strings                                                                        | **HOLDS** (CODE-REVIEWED + UNIT, no DB this audit) |
| L6-TERMINAL-MOUNT         | L6    | `terminal.tsx:35-36,95,102`                                                 | Claims match mounts                                                               | —        | `LiveChart` + `AccountEquity` in exchange grid                                                                                | **HOLDS**                                          |
| L7-EQUITY                 | L7    | `account-equity.tsx`, `rest.ts:45-50`, `rest.test.ts:35-55`                 | No invented zeros when anonymous/empty                                            | —        | sign-in / empty / live / failed states; dual-book note                                                                        | **HOLDS**                                          |
| L7-CHART                  | L7    | `live-chart.tsx`, `rest.ts:31-43`, `public-rest.ts:360-402`                 | No invented candles                                                               | —        | empty series UI; trade `[]` honest; no zero-fill buckets                                                                      | **HOLDS**                                          |
| L7-DISPLAY-NUM            | L7    | `live-chart.tsx:34-37`                                                      | `parseDec` → `Number` for SVG only                                                | info     | Wire remains strings; last close shown as string                                                                              | **ACCEPTABLE residual** (display geometry)         |
| OPS-CHECKLIST             | human | `docs/OWNER-OPS-CHECKLIST-2026-07-31.md`                                    | Human/counsel/mountains not agent-closed                                          | —        | Billing, PG, licence, secrets rotate, futures/otc/algo/copy; smart accounts still not `done`                                  | **HOLDS**                                          |
| OPS-AMM-SCOPE             | human | checklist §5-6                                                              | Compile ≠ protocol.amm done; lending/router not invented                          | —        | Explicit                                                                                                                      | **HOLDS**                                          |

---

## Layer detail

### L4 Plane (AMM / artefacts)

- **Compile path:** `SUITES.amm.expect === 'compiles'`; `_swap` private shared body fixes external-call bug; artefacts loadable via `loadArtifact('ConstantProductPool'|'PoolFactory')`.
- **Deploy path:** `PROTOCOL_AMM_FACTORY_ADDRESS` defaults **0x0**. `deploy-dev.ts` has **no** PoolFactory deploy. README (correct half) + checklist: factory deploy + audit remain open. Tracker `done` for full `protocol.amm` must stay refused.
- **Quote honesty:**
  - `quoteExactIn` = pure math over **caller** reserves; flags `reservesFromChain: false`.
  - `quoteFromPool` = chain `getReserves` + token orientation; refuses without chain; never defaults wrong side.
  - `poolReserves`: documented refusal rather than zero liquidity invent.
- **Unsigned builders:** encode only; `value: '0'`; platform never holds LP keys (contract + build comments align).
- **Math:** bigint unscaled wei; empty reserves throw `amm.no_liquidity` (honest for **known** empty, not a stand-in for "never read").

### L5 Edge

- Browser uses `createEdgeClient.restGet` → `{edge}/api/v1/...`.
- Edge maps `/api/v1` → trade with `preservePath: true` (balance + ohlcv land on trade absolute routes).
- Auth: balance requires bearer when `auth: true`; client-side pre-check if `!signedIn` → `unauthenticated` without inventing balances.
- Kill-switch: `GET /api/v1/account/balance` allowed under trade kill (read path) — expected; not an invent issue.

### L6 Mount

- Exchange plane mounts equity + chart; protocol plane separate (no fake equity there).
- Terminal header inventory matches implementation for these two panels.
- Protocol AMM procedures are tRPC under `/api/protocol` (edge prefix) — not claimed as terminal "live" product in the exchange grid.

### L7 Terminal

- **Equity:** dual-book sentence fixed in UI copy; empty vs failure vs anonymous distinct.
- **Chart:** 30s poll; failed shows `FailureNotice`; empty copy "market has not traded"; no synthetic OHLC zeros when parse fails (`geometry` null → empty copy).
- **Money type:** REST zod enforces string free/used/total and string OHLCV fields.

### Owner ops checklist

- Sections 1–4: billing, Postgres e2e, licence/counsel, secrets — **owner-only** actions named; agents get scans only.
- §5: claimable mountains remain multi-week; "Shipped adjacent" limited to charts/equity wiring + AMM **compile** + WS #227 — does not claim futures/otc/algo/copy done.
- §6: smart accounts not `done`; AMM compile does **not** implement lending/router.

---

## Residual verdicts (this batch)

| Item                                          | Verdict                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| AMM no fake reserves / no 0x0 success product | **HOLDS** CODE-REVIEWED + UNIT (mount/refusal suites)                         |
| Artifacts compile honesty                     | **HOLDS** in code + `contracts/out/`; **docs stale** P2                       |
| AMM factory deployed / mainnet ready          | **NOT claimed** — correctly open (Human/X)                                    |
| Equity edge → ledger projection               | **HOLDS** CODE-REVIEWED + UNIT (no DB this fire) — **not** MONEY VERIFIED E2E |
| Dual-book label                               | **HOLDS**                                                                     |
| OHLCV honest empty                            | **HOLDS**                                                                     |
| Terminal mount matches claim                  | **HOLDS**                                                                     |
| Owner checklist invent agent-done             | **HOLDS** (does not invent)                                                   |
| README/compile header vs compile fix          | **BROKEN (P2 docs)** → fix residual                                           |

---

## L3 language (mandatory)

All money-adjacent paths in this batch: **CODE-REVIEWED + UNIT (no DB)**. Never **MONEY VERIFIED E2E** from this plane pass alone.

---

## Agent-fixable this batch

| Severity | Count | IDs                                                     |
| -------- | ----- | ------------------------------------------------------- |
| **P0**   | 0     | —                                                       |
| **P1**   | 0     | —                                                       |
| **P2**   | 3     | DOC-AMM-STALE · DOC-COMPILE-HDR · TEST-GAP-CREATEPOOL-0 |

No P0/P1 invent-money or invent-success defects on the #228 plane/edge/mount/terminal surface.

---

## VERDICT

**PASS (plane/edge/mount/terminal honesty) with P2 docs/test residuals.**

#228 does **not** invent AMM success addresses, zero-reserve liquidity claims, fabricated equity, or fake OHLCV. Equity and charts are edge-routed to real trade REST. Owner ops checklist does not launder human work as agent-done. Close P2 docs contradiction in svc-protocol README + compile script header so narrative matches compile reality; optional test for zero-factory `buildCreatePool`.

**GATE-3C:** layers L4–L7 on primary #228 surfaces judged → **PASS**.
