# 01-DELTA — residual wave #229–#238 (+ #239 high water)

**Range:** `f42d41c` (#224) → `cd277dc` (#239)  
**Product high water:** through **#238** · **#239** docs only

## Merged PR list (named set)

| PR       | One-line                                                            | Risk tags                        | Money / auth impact                                                                                            |
| -------- | ------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **#229** | identity cascade blueprintCreated/Deleted → `profiles.blueprint_id` | **auth / ownership / cascade**   | **Auth-adjacent:** match-guarded clear; events bus only; closes §7.2 cascade hole; **no ledger / no balances** |
| **#230** | tracker honesty (launch/indexer ready; ops.notifications done)      | tracker honesty                  | none — docs/tracker only                                                                                       |
| **#231** | Stream A N2 order-entry validation + honest confirm                 | UI shell / dual-book note        | **No service money path**; confirm states venue wallet ≠ ledger                                                |
| **#232** | dual-book account banner + mobile module state (N3–N5)              | UI shell / dual-book             | **No money writes**; banner honesty only                                                                       |
| **#233** | depth empty vs waiting feed                                         | UI shell                         | none — no invented depth                                                                                       |
| **#234** | vendor-shell-scan + remove dead wallet mutators                     | **custody hygiene / CI**         | **Hardens** denylist; deletes dead PEACE residual Java mutators; scan in dod-gate                              |
| **#235** | UC money panes honest empty/error                                   | UI shell / money-display honesty | **No service path**; fail → unknown, never silent $0                                                           |
| **#236** | OTC/C2C honest empty/error; remove invented 7.00 / 21212            | UI shell / false-balance kill    | **Removes** hard-coded fake balances/quotes on fail                                                            |
| **#237** | high water docs A+B + partial wave audit                            | docs                             | none                                                                                                           |
| **#238** | Activity list empty ≠ error                                         | UI shell                         | none — no invented promotions                                                                                  |
| **#239** | residual ownership high water through #238                          | docs                             | none                                                                                                           |

## Path inventory (money / auth / deploy touch)

### Auth / identity (real backend)

- `services/svc-identity/src/blueprint-profile.ts` — set/clear `blueprint_id` (match-guarded delete)
- `services/svc-identity/src/events.ts` · `index.ts` · tests — bus consumers

### Custody / vendor hygiene

- `vendor/.../MemberWalletService.java` · `MemberWalletDao.java` — dead mutators removed
- `tooling/ci/vendor-shell-scan.mjs` · `dod-gate.mjs` — scan wired

### Stream A UI only (vendor shell — not books of record)

- Exchange order entry / dual-book banner / depth / UC money panes / OTC-C2C / Activity
- All under `vendor/upstream-exchange/05_Web_Front/...`

### Tracker / docs

- `tooling/tracker/features.mjs` · `docs/TRACKER.md` · `README.md`
- `docs/GRIND-LOOP-ACTIVE.md` · residual ownership · LIVE-LANES

### Not in this delta

- No `packages/ledger-client` changes
- No `svc-pay` / live rail merge (#226 remains **open**)
- No migrate / edge / compose / Dockerfile product change
- No dual-book ADR close

## Open third-party (not merged — pre-audit named)

| PR                               | Risk if merged without review    | Audit stance                       |
| -------------------------------- | -------------------------------- | ---------------------------------- |
| #226 live EVM crypto rail        | **CLASS M** real on-chain value  | Hold for Denon self-audit          |
| #227 WS positions stream         | owner-isolated private channel   | Prefer Denon; events catalog touch |
| #228 AMM + terminal OHLCV/equity | chain artefact + honest empty UI | Prefer Denon / split               |
