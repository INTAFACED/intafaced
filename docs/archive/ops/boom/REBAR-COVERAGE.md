# Rebar coverage ledger — FINISHED hunt

Tip `origin/main` after #4263. Zero `UNHUNTED`. Stage 3 cycle 1 + critic: zero new OPEN. Cycle 2: coordinator re-verified C-P1 public KMS refuse + HMAC-LIST empty on origin/main.

| id    | status | evidence                                                                                             |
| ----- | ------ | ---------------------------------------------------------------------------------------------------- |
| C-M1  | HUNTED | #4263 `earn-service.ts` `bank.position_id_required` + `deposit-retry-id.test.ts`                     |
| C-M2  | HUNTED | #4263 `schedule-retry-id.test.ts`                                                                    |
| C-M3  | HUNTED | S2-3 `getTxByKey` not exposed — occupancy rejected                                                   |
| C-M4  | HUNTED | #4263 repay/propose + S2-4 addCollateral                                                             |
| C-M5  | HUNTED | S3-3 OTC quote occupancy rejected                                                                    |
| C-M6  | HUNTED | #4262 `copy-service.test.ts`                                                                         |
| C-L1  | HUNTED | #4261 `recipe-gate.test.ts`                                                                          |
| C-L2  | HUNTED | no second book on #4261/#4262/#4263                                                                  |
| C-H1  | HUNTED | HMAC-LIST empty on tip; every mutate `verifyServiceHeaders` has `rawBody`+`mode`; compose pin SEALED |
| C-A1  | HUNTED | S8-1 JWT-after-expiry `CLOSE_UNAUTHORIZED`                                                           |
| C-D1  | HUNTED | FixAcceptorMain compose                                                                              |
| C-D2  | HUNTED | drop-copy blank OWNER + completeness honesty                                                         |
| C-D3  | HUNTED | CompID/TIF refuse before POST                                                                        |
| C-D4  | HUNTED | native L3 not L2                                                                                     |
| C-D5  | HUNTED | SBE Real Logic octets                                                                                |
| C-D6  | HUNTED | startBasket / POV hitch                                                                              |
| C-D7  | HUNTED | `spot/combo-place.ts` one hold; `trade.combo_double_hold`                                            |
| C-D8  | HUNTED | options exercise/assignment/expiry JobHost                                                           |
| C-D9  | HUNTED | what-if never `post`                                                                                 |
| C-D10 | HUNTED | promo budget/end unset refuse                                                                        |
| C-D11 | HUNTED | rulebook compose empty                                                                               |
| C-D12 | HUNTED | DEX fee `:-` empty                                                                                   |
| C-V1  | HUNTED | venue empty consensus / price<=0                                                                     |
| C-Q1  | HUNTED | Q census LIVE/NAMED-REFUSE/SKIP/KEEP/SOCKET                                                          |
| C-R1  | HUNTED | R leftover LIVE or NAMED-REFUSE                                                                      |
| C-I1  | HUNTED | dual-control wraps freeze                                                                            |
| C-P1  | HUNTED | `offers.create` → `p2p.instrument_kms_required` 412                                                  |
| C-F1  | HUNTED | named DEX fee empty                                                                                  |
| C-S1  | HUNTED | skip register anvil only                                                                             |
| C-P2  | HUNTED | packages KEEP                                                                                        |

**Out (not a scope cut — law):** frontend Vue · INTACHAIN P1 · owner §8 magnitudes · npm ccxt · second book · compose HMAC `require` · occupancy mill.
