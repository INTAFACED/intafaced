# Rebar queue — 2026-09-17 (audit-3)

**Law:** [`docs/SPEC-REBAR-ALL-OUT-2026-09-17.md`](../../SPEC-REBAR-ALL-OUT-2026-09-17.md)  
**STATUS:** [`REBAR-STATUS.md`](REBAR-STATUS.md) — mill writes `FINISHED` after squash-merge + cleanup. Nitro has no step.  
**Leftover:** `PLAN` · `OPEN` · unfalsified `IN-LEAD` · unexploded `HMAC-LIST`  
**Terminal:** `LIVE-DOOR` · `NAMED-REFUSE` · `SEALED` · `SOCKET` · `FRONTEND` · `KEEP` · `SKIP`  
**`IN-LEAD`:** merged PR named; Stage 1 default-kill; **no writer** until falsify.  
**`OPEN`:** only after Stage 1 + critic (`path:line` missing door).

Do not recook M00–M28. Taxonomy (FAILURES #13): SEALED / leftover-software / SOCKET / OWNER-SET / FRONTEND.

Stage 3 stamp `origin/main` after #4263. Zero leftover software.

| id                | service                  | status       | evidence / falsify file                                                                           |
| ----------------- | ------------------------ | ------------ | ------------------------------------------------------------------------------------------------- |
| H1                | svc-fix                  | LIVE-DOOR    | compose `java … FixAcceptorMain`; NOS→`matching.submit`                                           |
| H1b               | svc-fix                  | NAMED-REFUSE | `DropCopyCompleteness` incomplete while ui/rest/ws/algo/liquidation/rfq/broker missing            |
| H2                | svc-matching             | LIVE-DOOR    | #3783 `l3.router.test.ts`                                                                         |
| H2-ws             | svc-ws                   | LIVE-DOOR    | `NativeL3Hub` matching GET `/depth/l3`; L2 tuples refuse                                          |
| H3                | svc-ws                   | LIVE-DOOR    | #3968 SBE Real Logic octets                                                                       |
| H4                | svc-matching             | LIVE-DOOR    | #3796 combo one instrument                                                                        |
| H4-trade          | svc-trade                | LIVE-DOOR    | `spot/combo-place.ts` one `orderHold`/`tradeFill`; per-leg → `trade.combo_double_hold`            |
| H5                | svc-matching             | LIVE-DOOR    | #3787 mass-quote                                                                                  |
| H6                | svc-trade                | LIVE-DOOR    | #3790 JobHost dated settlement                                                                    |
| H7                | svc-trade                | LIVE-DOOR    | #3792 QuantLib link-or-refuse                                                                     |
| H7-adapter        | greeks-adapter           | LIVE-DOOR    | QuantLib 1.43 hitch                                                                               |
| H8-skip           | money roots              | SOCKET       | register = `svc-pay` `evm-chain.live.test.ts` anvil only; do not mill                             |
| H8c               | svc-trade                | LIVE-DOOR    | #3831                                                                                             |
| H8c-matching      | svc-matching             | LIVE-DOOR    | #3815                                                                                             |
| H8e               | svc-matching             | LIVE-DOOR    | #3807/#4245 FileJournal                                                                           |
| H9                | svc-matching             | LIVE-DOOR    | #3800                                                                                             |
| H10               | svc-execution            | LIVE-DOOR    | #3850/#3855 basket children                                                                       |
| H11               | svc-dex                  | NAMED-REFUSE | compose `DEX_INTERNAL_BOOK_FEE_BPS:-` empty → `dex.internal_book_fee_unset`                       |
| A1                | svc-matching             | LIVE-DOOR    | #3702 STP surveillance                                                                            |
| A2                | svc-trade                | LIVE-DOOR    | #3703 convert 10/200 refuse                                                                       |
| A3                | svc-execution            | LIVE-DOOR    | `startBasket` HTTP hitch posts matching children                                                  |
| A4                | svc-execution            | LIVE-DOOR    | POV `slicePovParent` + live algo hitch                                                            |
| A5                | svc-fix                  | LIVE-DOOR    | unmapped CompID / missing TIF refuse before POST                                                  |
| A6                | svc-fix                  | LIVE-DOOR    | ack named `accepted`/`sequence` only (fills stripped)                                             |
| A7                | svc-matching             | NAMED-REFUSE | empty `MATCHING_RULEBOOK_VERSION:-` → `matching.rulebook_unpublished`                             |
| R-A7              | svc-matching             | NAMED-REFUSE | same door as A7                                                                                   |
| R-E5              | svc-trade                | LIVE-DOOR    | JobHost `options.exercise` / `.assignment` / `.expiry`                                            |
| R-E6              | svc-trade                | LIVE-DOOR    | #3806 delta-hedge unset refuse                                                                    |
| R-E7              | svc-trade                | LIVE-DOOR    | `greeks/what-if.ts` never `post`                                                                  |
| R-E8              | svc-trade                | SOCKET       | do not redo                                                                                       |
| R-copy            | svc-trade                | NAMED-REFUSE | blank jurisdiction → follow closed all regions                                                    |
| R-agentic         | svc-agents               | NAMED-REFUSE | install/watch ≠ trading authority; money-write denylist                                           |
| R-fx              | svc-trade                | NAMED-REFUSE | production FX/commodity refuse until settlement law                                               |
| R-quant           | svc-quant                | NAMED-REFUSE | paper book; live deploy pin empty refuses                                                         |
| R-security        | svc-identity             | LIVE-DOOR    | `installPrivilegedDualControl`                                                                    |
| R-onboard         | svc-identity             | LIVE-DOOR    | limit/fee-tier dual-control                                                                       |
| R-promo           | svc-trade                | NAMED-REFUSE | `trade.promo_budget_unset` / `trade.promo_end_unset`                                              |
| R-auth            | svc-identity             | LIVE-DOOR    | place/fill require session or API-key                                                             |
| Q-proto           | svc-protocol             | NAMED-REFUSE | `audited` literal `false`; AMM `0x0` refuse                                                       |
| Q-index           | svc-indexer              | SOCKET       | `DevVenue` fixture — not live CLOB                                                                |
| Q-dex             | svc-dex                  | NAMED-REFUSE | duplicate of H11                                                                                  |
| Q-pay             | svc-pay                  | NAMED-REFUSE | `pay.chargeback_ledger_unwired`                                                                   |
| Q-bank            | svc-bank                 | NAMED-REFUSE | `BANK_CARD_ISSUER:-none` simulator                                                                |
| Q-token           | svc-token                | NAMED-REFUSE | auto-tick default off; unpublished mint refuse                                                    |
| Q-mine            | svc-mining-pool          | LIVE-DOOR    | JobHost epoch payout; unset emission refuses                                                      |
| Q-edge            | svc-edge                 | NAMED-REFUSE | not a WS proxy; leftover named                                                                    |
| Q-notify          | svc-notify               | KEEP         | in-app; email/push/SMS Class X dark                                                               |
| Q-p2p             | svc-p2p                  | NAMED-REFUSE | `offers.create` → `p2p.instrument_kms_required` (412); `createOffer` never runs                   |
| Q-market          | svc-market               | NAMED-REFUSE | recurring refuse; blank commission ≠ 0                                                            |
| Q-ledger          | svc-ledger               | KEEP         | do not recut statements                                                                           |
| Q-ops             | svc-ops                  | NAMED-REFUSE | blank wrap → `ops.custody_wrap_unset`                                                             |
| Q-tax             | svc-tax                  | SOCKET       | jurisdiction map OWNER                                                                            |
| Q-academy         | svc-academy              | KEEP         | paper ≠ ledger                                                                                    |
| Q-agents          | svc-agents               | NAMED-REFUSE | with R-agentic                                                                                    |
| Q-support         | svc-support              | KEEP         | no refund money (not SKIP)                                                                        |
| Q-blueprint       | svc-blueprint            | SKIP         | mock / no money                                                                                   |
| Q-rust            | svc-matching-rust-stage1 | SKIP         | TS matching SoT                                                                                   |
| S2-1              | svc-bank                 | LIVE-DOOR    | #4263 omit `positionId` → `bank.position_id_required`                                             |
| S2-2              | svc-bank                 | LIVE-DOOR    | #4263 `scheduleId` required; `ON CONFLICT (id)` reuse                                             |
| S2-3              | svc-bank                 | NAMED-REFUSE | `getTxByKey` not exposed; occupancy rejected                                                      |
| S2-4              | svc-bank                 | LIVE-DOOR    | `add-collateral-retry-id.test.ts`                                                                 |
| S2-5              | svc-bank                 | LIVE-DOOR    | #4263 repay `eventId` required                                                                    |
| S2-6              | svc-bank                 | LIVE-DOOR    | #4263 propose `clientId` required                                                                 |
| S3-2              | svc-trade                | LIVE-DOOR    | #4262 planMirror loads `trade.fills`; invented qty refused                                        |
| S3-3              | svc-trade                | NAMED-REFUSE | OTC quote retry occupancy rejected (same fingerprint)                                             |
| S4-3              | svc-ledger               | LIVE-DOOR    | #4261 `assertKnownRecipePost`; assembled journal `ledger.recipe_required`                         |
| S8-1              | svc-ws                   | LIVE-DOOR    | JWT after `exp` closes `CLOSE_UNAUTHORIZED`                                                       |
| S14-1             | venue-adapter            | LIVE-DOOR    | empty consensus → `inconclusive`, `consensusMid=null`                                             |
| S14-2             | venue-adapter            | LIVE-DOOR    | `price<=0` → `no_quote`                                                                           |
| AUG7-funding      | svc-trade                | LIVE-DOOR    | `margin_current` on tip; no Class M rewrite                                                       |
| HMAC-compose      | packages/config          | SEALED       | pin test forbids `:-require`                                                                      |
| HMAC-LIST         | inbound mutate S2S       | SEALED       | empty remainder; every mutate `verifyServiceHeaders` passes `rawBody`+`mode`; do not flip compose |
| pkg-ledger-client | packages/ledger-client   | KEEP         | only money writes; dual-book scan on money PRs                                                    |
| pkg-sbe           | packages/sbe-codec       | KEEP         | hitch H3                                                                                          |
| pkg-greeks        | packages/greeks-adapter  | KEEP         | hitch H7                                                                                          |
| pkg-contracts     | packages/contracts       | SEALED       | Zod 3; no Zod 4                                                                                   |
| pkg-events        | packages/events          | KEEP         | NATS                                                                                              |
| pkg-execution-mm  | packages/execution-mm    | KEEP         | MMP law in-repo                                                                                   |
| pkg-execution-arb | packages/execution-arb   | KEEP         | external-only house                                                                               |
| pkg-venue         | packages/venue-adapter   | KEEP         | with S14                                                                                          |
| pkg-market-data   | packages/market-data     | KEEP         | do not fork                                                                                       |
| pkg-auth          | packages/auth            | KEEP         | WebAuthn adapter                                                                                  |
| pkg-quant-honesty | packages/quant-honesty   | KEEP         | with R-quant                                                                                      |
| pkg-db-config     | packages/db + config     | KEEP         |                                                                                                   |
| pkg-ui            | packages/ui              | FRONTEND     | Codex                                                                                             |
| 05_Web_Front      | vendor                   | FRONTEND     | Codex                                                                                             |
| W0-3777           | docs                     | SOCKET       | closed **unmerged** harden spec — not a mill                                                      |
| W0-3708           | docs                     | SOCKET       | closed **unmerged** inventory                                                                     |
| W0-3746           | svc-protocol             | NAMED-REFUSE | same as Q-proto                                                                                   |
| W0-3707           | deps                     | SOCKET       | closed unmerged GHSA — not mill stop                                                              |
| P1-chain          | svc-chain                | SOCKET       | INTACHAIN ADR                                                                                     |
| mega-§2           | owner env                | SOCKET       | never invent                                                                                      |
| money-skip-evm    | svc-pay                  | SOCKET       | only register row; anvil CI                                                                       |
