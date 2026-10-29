# Roadmap

What gets built until INTAFACED is finished, in what order, and what waits on what. The top half is the plan; the bottom half is generated from the Operation Zero spec slices by `node tooling/scripts/roadmap.mjs` and is never edited by hand. Rules for how to build stay in [`../AGENTS.md`](../AGENTS.md); where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

## Finished

Finished is the Operation Zero definition: every build row of all 21 modules complete on labelled TEST data, every enabled control gives a success, a typed refusal, or the allowlisted notice naming an outside service, the cross-module journeys pass, and it is proven in the real app. Getting there has three stages:

1. **Push (now).** Build every slice. Proof per slice: its tests, the journey it serves, and screenshots.
2. **Polish (part of finishing, after the push).** Review against the reference apps with a rubric, scripted persona tasks per module, nightly re-runs, dependency upgrades, leftover review findings.
3. **Real-funds day.** One named switch that only the owner turns on. Before it: a bought custody signer behind the existing signer interface, live owner values (listed by `node tooling/scripts/owner-settings.mjs`), service keys only (the shared secrets removed), ledger idempotency in `refuse` mode, the items on the owner's must-fix list, every slice whose title starts "Before real money:" (Phantom's fault table, admin acceptance tests and his 2026-10-23 controls: proof of reserves, AML transaction monitoring, 3-D Secure and sanctions screening proven in a journey, and a check that production runs in live mode with no TEST shortcuts reachable; linked from the money journeys they protect but not steps of them), the readiness review of the first launch unit, and an external security audit of the money code (the audit is external; agents never mark anything audited).

## How work flows

- **Lanes.** A lane is one service, or one app area, so two lanes never edit the same files. A lane keeps one thread across many slices and takes its next slice from its queue (`node tooling/scripts/roadmap.mjs --lane "<lane>"`). Trader-journey slices go first.
- **Slice ids.** A PR that builds a slice names its id in the title (for example `svc-trade: SP-order-entry-02 market order by value`), so progress is counted from merged PRs, not typed (`node tooling/scripts/roadmap.mjs --progress`).
- **How to build and review a slice:** `docs/agents/build-slice.md`, with the lane brief and the reviewer brief beside it. A slice lands as one PR: its contracts or events, one service and that service's screen (owner decision 2026-10-22).
- **Before building a slice,** re-read its spec and re-check every cited `file:line` against today's main. The specs were written against main of 2026-10-18; drop what is already built and say so in the PR.
- **Journeys.** Each cross-module journey has one owner whose job is keeping it green in the real app: trader first; then bank to fund to trade to withdraw; merchant payout to bank; one portfolio.
- **Front end.** Build on the default design tokens. Look choices go to the owner in one batch per phase, as two or three rendered options side by side; without an answer the default stays.
- **Outside services.** A slice whose rail, vendor or chain is missing is still built in full; only the outside call refuses, with the allowlisted notice.

## Decisions many slices sit on

Settled before lanes go wide. Each has one owner.

| Decision                       | Pick                                                                                                                                                                                                                               | State                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Futures engine                 | Matched traders with a margin book beside matching; svc-ledger stays the only balance and settles through ledger-client recipes; insurance fund and auto-deleveraging. Batch settlement designed, built only when volume needs it. | ADR being written                                                        |
| Service-to-service auth        | Each service signs with its own key                                                                                                                                                                                                | Rolling out service by service; keys-only flip is on the real-funds list |
| Ledger keys                    | Per-operation key prefixes and one shared lost-reply classifier, before money lanes widen                                                                                                                                          | In progress                                                              |
| TEST settings                  | Labelled TEST profile for the rigs (`tooling/profiles/test-owner-values/`, one file per service); live values stay blank                                                                                                           | On main; extended as journeys need                                       |
| Customer app shell and types   | Navigation skeleton first; new screens take response types from `packages/contracts`; one refusal catalogue                                                                                                                        | In progress                                                              |
| Seams                          | A slice's contracts and events land in the slice's one PR; once merged they stay frozen while the journey builds on them                                                                                                           | Per journey                                                              |
| Merchant webhooks              | Self-hosted open-source webhook server, no purchase; payout, refund and dispute as explicit state machines first                                                                                                                   | Pay lane                                                                 |
| On-chain contracts and Predict | Open to agents (owner decision 2026-10-22; @shehzad002 may take a part back); audited libraries; never `audited: true`                                                                                                             | Agents                                                                   |
| Custody signer                 | Signer interface on main; provider bought before real funds                                                                                                                                                                        | Closed for test money                                                    |

## Where the specs are

The full slice specs (behaviour, tests, failure cases, references) live in the project's shared Operation Zero folder, `modules/<module>/specs/`. `docs/roadmap/slices.json` is the committed index of them: id, title, module, spec file, lane, what it touches, dependencies, journeys, outside service, size. Rebuild it with `node tooling/scripts/roadmap.mjs --index <operation-zero folder>` when the specs change.

<!-- generated by tooling/scripts/roadmap.mjs: do not edit below this line -->

## Generated: what is left, by module, lane and journey

1502 slices left in 21 modules. 284 need no other slice. 47 sit in a dependency loop that the lane untangles first. 358 end in a refusal that names an outside service (built, switched on later). Size: 707 L, 689 M, 106 S.

### Journey map

Done is defined by 460 journeys (3037 steps) in `modules/<module>/acceptance/journeys.md`; a journey is finished when its browser test passes on the real stack built from main. Order 1 is a module's first usable journey, and lane queues take its slices first. 33 steps still need a capability no slice covers yet.

| Module         | Journeys | Order 1 | Order 2 | Order 3 | Steps | Steps with no slice |
| -------------- | -------- | ------- | ------- | ------- | ----- | ------------------- |
| merchant       | 42       | 6       | 15      | 21      | 242   | 5                   |
| dex-protocol   | 32       | 5       | 16      | 11      | 277   | 0                   |
| copy-bots-otc  | 30       | 5       | 13      | 12      | 206   | 1                   |
| bank           | 28       | 4       | 15      | 9       | 164   | 7                   |
| derivatives    | 24       | 1       | 13      | 10      | 165   | 0                   |
| identity       | 21       | 4       | 11      | 6       | 133   | 1                   |
| p2p            | 21       | 2       | 12      | 7       | 117   | 0                   |
| pay            | 21       | 2       | 11      | 8       | 121   | 1                   |
| wallet         | 21       | 4       | 9       | 8       | 110   | 0                   |
| academy        | 20       | 4       | 9       | 7       | 135   | 0                   |
| agents         | 20       | 2       | 11      | 7       | 120   | 3                   |
| campaigns      | 20       | 4       | 9       | 7       | 123   | 0                   |
| cex-spot       | 20       | 2       | 13      | 5       | 169   | 0                   |
| more-catalogue | 20       | 5       | 10      | 5       | 127   | 1                   |
| ops-console    | 20       | 4       | 13      | 3       | 176   | 7                   |
| support-public | 20       | 4       | 11      | 5       | 161   | 4                   |
| charts-desk    | 19       | 1       | 10      | 8       | 120   | 0                   |
| developer      | 18       | 4       | 9       | 5       | 116   | 0                   |
| algo-dev       | 16       | 1       | 8       | 7       | 104   | 0                   |
| portfolio      | 16       | 2       | 9       | 5       | 93    | 3                   |
| home-ia        | 11       | 3       | 5       | 3       | 58    | 0                   |

### By module

| Module         | Slices | Need nothing | Refuse for an outside service | Large |
| -------------- | ------ | ------------ | ----------------------------- | ----- |
| merchant       | 211    | 35           | 10                            | 105   |
| copy-bots-otc  | 125    | 42           | 18                            | 47    |
| ops-console    | 118    | 25           | 42                            | 66    |
| dex-protocol   | 111    | 4            | 102                           | 40    |
| bank           | 98     | 40           | 7                             | 57    |
| identity       | 90     | 17           | 30                            | 27    |
| wallet         | 77     | 25           | 27                            | 26    |
| p2p            | 70     | 12           | 2                             | 40    |
| derivatives    | 67     | 12           | 20                            | 32    |
| academy        | 60     | 3            | 14                            | 34    |
| cex-spot       | 53     | 5            | 13                            | 33    |
| support-public | 52     | 10           | 15                            | 21    |
| more-catalogue | 51     | 3            | 22                            | 19    |
| pay            | 49     | 7            | 3                             | 19    |
| agents         | 46     | 1            | 10                            | 22    |
| developer      | 42     | 12           | 1                             | 23    |
| campaigns      | 41     | 2            | 11                            | 23    |
| charts-desk    | 41     | 6            | 2                             | 27    |
| algo-dev       | 40     | 5            | 3                             | 25    |
| portfolio      | 35     | 9            | 4                             | 15    |
| home-ia        | 25     | 9            | 2                             | 6     |

### By lane

A lane is one service, or one app area, so two lanes never edit the same files. `--lane "<name>"` prints its queue.

| Lane                          | Slices | Need nothing | In the trader journey | In an Order 1 journey | In no journey |
| ----------------------------- | ------ | ------------ | --------------------- | --------------------- | ------------- |
| svc-pay merchant              | 232    | 36           | 11                    | 36                    | 35            |
| svc-bank                      | 195    | 53           | 35                    | 37                    | 25            |
| svc-trade spot                | 163    | 41           | 42                    | 48                    | 6             |
| svc-identity                  | 136    | 29           | 68                    | 39                    | 11            |
| svc-protocol                  | 75     | 4            | 1                     | 19                    | 4             |
| svc-p2p                       | 62     | 10           | 0                     | 19                    | 1             |
| svc-academy                   | 60     | 3            | 0                     | 19                    | 3             |
| svc-trade futures             | 56     | 10           | 0                     | 9                     | 0             |
| svc-agents                    | 49     | 2            | 0                     | 8                     | 3             |
| svc-ops                       | 42     | 11           | 4                     | 1                     | 12            |
| svc-notify                    | 39     | 15           | 3                     | 11                    | 1             |
| svc-support                   | 36     | 7            | 2                     | 10                    | 3             |
| svc-pay wallet                | 32     | 9            | 14                    | 9                     | 6             |
| svc-quant                     | 31     | 4            | 0                     | 9                     | 0             |
| ledger                        | 25     | 9            | 7                     | 4                     | 3             |
| svc-matching                  | 21     | 2            | 4                     | 2                     | 3             |
| svc-execution                 | 20     | 3            | 5                     | 0                     | 13            |
| customer: trade               | 19     | 1            | 3                     | 4                     | 1             |
| svc-edge                      | 19     | 1            | 2                     | 4                     | 5             |
| customer: more                | 16     | 2            | 3                     | 7                     | 0             |
| svc-market                    | 15     | 0            | 0                     | 6                     | 0             |
| svc-token                     | 15     | 2            | 0                     | 4                     | 0             |
| customer shell                | 12     | 5            | 3                     | 6                     | 1             |
| svc-tax                       | 12     | 2            | 7                     | 2                     | 3             |
| customer: pay                 | 11     | 1            | 1                     | 5                     | 0             |
| admin: ops-desk               | 10     | 6            | 0                     | 3                     | 3             |
| svc-indexer                   | 10     | 1            | 0                     | 6                     | 1             |
| svc-ws                        | 10     | 2            | 3                     | 2                     | 0             |
| customer: account             | 8      | 1            | 1                     | 2                     | 0             |
| svc-blueprint                 | 8      | 0            | 0                     | 0                     | 1             |
| customer: protocol            | 7      | 1            | 0                     | 3                     | 1             |
| svc-dex                       | 7      | 0            | 0                     | 3                     | 0             |
| svc-mining-pool               | 7      | 0            | 0                     | 4                     | 0             |
| contracts                     | 6      | 2            | 2                     | 2                     | 0             |
| customer: public              | 5      | 2            | 0                     | 2                     | 0             |
| svc-fix                       | 5      | 0            | 1                     | 0                     | 0             |
| admin: merchants              | 4      | 1            | 0                     | 0                     | 0             |
| admin shell                   | 2      | 0            | 0                     | 0                     | 0             |
| admin: founder-ops            | 2      | 1            | 1                     | 0                     | 0             |
| admin: protocol-desk          | 2      | 0            | 0                     | 0                     | 0             |
| config                        | 2      | 2            | 0                     | 0                     | 2             |
| customer: money               | 2      | 1            | 1                     | 0                     | 1             |
| acceptance (Polish)           | 1      | 1            | 1                     | 0                     | 1             |
| admin: console-status-banner  | 1      | 0            | 0                     | 1                     | 0             |
| admin: flag-state             | 1      | 0            | 0                     | 0                     | 0             |
| admin: jurisdiction-board     | 1      | 0            | 0                     | 0                     | 1             |
| admin: launch-sequence        | 1      | 0            | 0                     | 0                     | 0             |
| admin: module-state-inspector | 1      | 0            | 0                     | 1                     | 0             |
| admin: modules                | 1      | 0            | 0                     | 0                     | 0             |
| admin: nav                    | 1      | 0            | 0                     | 1                     | 0             |
| admin: support-ticket-actions | 1      | 0            | 0                     | 1                     | 0             |
| ci gate                       | 1      | 1            | 0                     | 0                     | 1             |
| customer: coin                | 1      | 0            | 0                     | 0                     | 0             |
| docs                          | 1      | 0            | 0                     | 0                     | 1             |

### By journey

| Journey                  | Slices | Need nothing |
| ------------------------ | ------ | ------------ |
| trader                   | 225    | 56           |
| bank-fund-trade-withdraw | 51     | 17           |
| merchant-payout-to-bank  | 84     | 23           |
| one-portfolio            | 35     | 9            |

### Trader journey queue

First milestone. Lanes take these before their other slices.

- `SP-developer-status-01` Trading modes, maintenance notices and closed-market handling (M, depth 1, journey order 1)
- `SP-fees-vip-01` Maker and taker schedule by pair group, minimum fee and rebates (L, depth 1, journey order 1)
- `SP-order-entry-01` Typed create body, stash removal and order-type availability (M, depth 1, journey order 1)
- `C-chart-core-01` Chart workbench at /charts/:symbol with a shared symbol and interval, and a live market chart widget (L, depth 1, journey order 1)
- `C-trade-dom-05` Business idempotency keys for desk place and replace (defect CD-1) (S, depth 1, journey order 1)
- `HM-dashboard-01` Home total value tile: display unit, account-level hide-amounts, link to Assets, and the reads-only invariant test (M, depth 1, journey order 1)
- `HM-navigation-01` Avatar menu with profile summary, account entries and a real account mode (M, depth 1, journey order 1)
- `HM-navigation-02` Top bar doors: Home, Assets, Bank, Trade, Pay, More, with complete dropdowns (M, depth 1, journey order 1)
- `I-kyc-compliance-01` KYC case record, reason codes and history (L, depth 1, journey order 1, refuses for an outside service)
- `I-signin-sessions-03` Password reset with equal work and handle recovery (M, depth 1, journey order 1, refuses for an outside service)
- `I-signin-sessions-05` Sessions as sign-in families: device list, sign out others (M, depth 1, journey order 1)
- `I-signin-sessions-21` Social and wallet-linked sign-in: honest refusal (S, depth 1, journey order 1, refuses for an outside service)
- `OPS-ledger-desk-01` Ledger read desk: transaction browser, account browser, business-key trace, statistics (L, depth 1, journey order 1)
- `PF-balances-01` Exact balance breakdown by lock kind, and the ledger entries behind every balance (customer, finance-treasury and support views) (L, depth 1, journey order 1)
- `PF-cost-basis-01` Lot source from ledger legs: cost basis, average price and fees in basis and proceeds (L, depth 1, journey order 1)
- `W-balances-04` Membership subscription tier (decision-gated) (S, depth 1, journey order 1)
- `W-balances-05` One supported asset and network registry (L, depth 1, journey order 1)
- `W-deposit-01` Custody deposit port adapter, address issue and memo/tag display (L, depth 1, journey order 1, refuses for an outside service)
- `W-withdraw-05` Per-tier withdrawal limits and remaining allowance (D-148) (L, depth 1, journey order 1)
- `W-withdraw-06` Withdrawal state machine, status vocabulary, history list and failure reasons (L, depth 1, journey order 1)
- `W-withdraw-08` Address book: list, save, rename, delete (M, depth 1, journey order 1)
- `W-withdraw-13` Withdrawal hold after card, ACH or PayPal purchase (M, depth 1, journey order 1)
- `RC-cex-spot-07` Venue unit economics report (M, depth 1, journey order 2)
- `HM-dashboard-02` Net worth over time on Home (Phantom #65): stored daily value, range switch and honest empty state (L, depth 1, journey order 2)
- `HM-shell-02` Theme: follow system, light or dark (rendered options first, owner picks) (M, depth 1, journey order 2)
- `I-account-lifecycle-01` Display and locale saved on the account; UID display (S, depth 1, journey order 2)
- `I-account-lifecycle-02` Notification preferences by category and channel (M, depth 1, journey order 2, refuses for an outside service)
- `I-account-lifecycle-13` Staff freeze, suspension and closure with customer-visible reason (L, depth 1, journey order 2)
- `I-kyc-compliance-20` Business verification entry, entity types and requirements per type (L, depth 1, journey order 2)
- `I-signin-sessions-01` Step-up for security changes (contracts first) (M, depth 1, journey order 2)
- `I-signin-sessions-26` Official channels page and scam guides (S, depth 1, journey order 2)
- `I-signin-sessions-27` Report phishing and scams from the product (S, depth 1, journey order 2)
- `I-signin-sessions-29` Connected apps and API access (S, depth 1, journey order 2)
- `OPS-accounts-desk-01` Staff holds on funds and the closure balance sweep (L, depth 1, journey order 2, refuses for an outside service)
- `OPS-accounts-desk-03` Account product tiers and account limits with overrides (L, depth 1, journey order 2, refuses for an outside service)
- `OPS-ledger-desk-04` Ledger integrity check, response runbook and typed write-block reasons (M, depth 1, journey order 2)
- `OPS-ledger-desk-05` Backups, restore gates and joint restore watermarks (L, depth 1, journey order 2)
- `PF-activity-01` Activity feed with every balance-changing kind, and filters for date, asset, type, account, address and year (L, depth 1, journey order 2)
- `PF-activity-02` Activity detail: link from a purchase to the asset history, linked entries by reference, and trade history by order type (M, depth 1, journey order 2)
- `PF-activity-03` Notes and report description on an entry, and activity types grouped by tax effect (M, depth 1, journey order 2)
- `PF-balances-02` Allocation by asset, asset class and type; holdings change over a period (M, depth 1, journey order 2)
- `PF-overview-03` Display currency, account selector and cash by currency with in-place convert (M, depth 1, journey order 2)
- `W-balances-02` Small-balance (dust) conversion and its record (M, depth 1, journey order 2)
- `W-balances-03` Transfers between own wallets and accounts with history (S, depth 1, journey order 2)
- `W-balances-07` Founder ledger inspection, manual adjustments and reconciliation (M, depth 1, journey order 2)
- `W-deposit-08` Misrouted and unsupported deposit recovery desk (M, depth 1, journey order 2)
- `W-security-accounts-03` Emergency freeze of account or workspace (M, depth 1, journey order 2)
- `I-account-lifecycle-05` Organisation account: create, members, roles, segregated accounts, lifecycle (L, depth 1, journey order 3)
- `I-signin-sessions-31` Auth secret and signing-key rotation with overlap (M, depth 1, journey order 3)
- `PF-balances-03` Hide small balances with an owner-set threshold and convert them in bulk (L, depth 1, journey order 3)
- `W-security-accounts-01` API key fund-movement permissions and leak protection (M, depth 1, journey order 3)
- `W-security-accounts-04` Custody roles and separation of duties (M, depth 1, journey order 3)
- `W-security-accounts-05` Audit log of wallet and custody events (M, depth 1, journey order 3)
- `W-security-accounts-06` Sub-accounts: lifecycle, trading features, balances (M, depth 1, journey order 3)
- `W-security-accounts-07` Transfers between master, sub and organisation accounts, and sub-account wallets (M, depth 1, journey order 3)
- `SP-order-03` Reference checks: operational depth against two named competitors (acceptance only) (S, depth 1)
- `SP-order-entry-04` Time in force, self-trade mode, client id and tag, and quantity-unit flags (M, depth 2, journey order 1) · needs SP-order-entry-01
- `C-chart-core-02` Chart type switcher: candles, bars, line, area, columns and derived series (L, depth 2, journey order 1) · needs C-chart-core-01
- `C-chart-core-03` Interval switch, history loading, zoom and navigation (M, depth 2, journey order 1) · needs C-chart-core-01
- `HM-dashboard-03` Home work list (Phantom #64): what needs you now, from real records, or nothing (L, depth 2, journey order 1) · needs HM-desks-02
- `HM-navigation-03` More and All services generated from the one route table (M, depth 2, journey order 1) · needs HM-navigation-02
- `HM-navigation-04` Global search: help articles, module path, preview and blocker labels, search-miss count (M, depth 2, journey order 1) · needs HM-desks-02
- `I-kyc-compliance-02` Verification review queue: assign, manual review, notes, appeal decision (L, depth 2, journey order 1) · needs I-kyc-compliance-01
- `I-kyc-compliance-05` Per-level data requirements, deadlines and processing times (M, depth 2, journey order 1) · needs I-kyc-compliance-01
- `I-kyc-compliance-10` KYC attempt limits and lockout (S, depth 2, journey order 1) · needs I-kyc-compliance-01
- `I-signin-sessions-02` Passkey sign-in options without account enumeration (S, depth 2, journey order 1) · needs I-signin-sessions-01
- `I-signin-sessions-04` Password policy, breached-password screening and change password (M, depth 2, journey order 1) · needs I-signin-sessions-03
- `I-signin-sessions-07` Trusted devices and new-device sign-in authorisation (L, depth 2, journey order 1, refuses for an outside service) · needs I-signin-sessions-01, I-signin-sessions-03
- `I-signin-sessions-18` Register with email or phone (L, depth 2, journey order 1, refuses for an outside service) · needs I-signin-sessions-03
- `I-signin-sessions-20` One-time code delivery, resend, lockout and channel fallback (M, depth 2, journey order 1, refuses for an outside service) · needs I-signin-sessions-03
- `I-signin-sessions-32` Auth messages catalogue and hosted error pages (M, depth 2, journey order 1) · needs I-signin-sessions-03
- `W-deposit-02` Multiple deposit addresses, address list, labels and expiry (M, depth 2, journey order 1) · needs W-deposit-01
- `W-deposit-04` Deposit asset/network catalogue, availability switches and funding eligibility (L, depth 2, journey order 1, refuses for an outside service) · needs W-compliance-notices-01, W-deposit-01
- `W-deposit-05` Deposit record, crediting after confirmations, state model, history (L, depth 2, journey order 1, refuses for an outside service) · needs W-deposit-01
- `W-withdraw-03` Destination validation and fraud/tamper (poisoning) check (L, depth 2, journey order 1) · needs W-compliance-notices-02, W-withdraw-08
- `W-withdraw-04` Withdrawal fee quote and net-amount preview (M, depth 2, journey order 1) · needs W-custody-ops-10
- `W-withdraw-09` New-address cooling-off, email/device approval and customer security lock (L, depth 2, journey order 1, refuses for an outside service) · needs W-withdraw-08
- `SP-lifecycle-history-01` Order states, history filters and the detail view (M, depth 3, journey order 1) · needs SP-conditional-algo-01
- `SP-lifecycle-history-02` Edit and cancel, fill roles, trigger explanation and batch cancel (L, depth 3, journey order 1) · needs SP-conditional-algo-01, SP-order-entry-04
- `SP-markets-data-01` Public market data: instrument stream, depth, OHLCVT, spreads and price definitions (L, depth 3, journey order 1) · needs SP-markets-data-02
- `SP-ops-01` Listing desk: market state controls and halt or freeze of in-flight orders (L, depth 3, journey order 1, refuses for an outside service) · needs SP-developer-status-01, SP-markets-data-02
- `HM-dashboard-04` Recent activity on Home with a link to the full Activity room (S, depth 3, journey order 1) · needs HM-dashboard-03
- `I-kyc-compliance-04` Verification level ladder and what each level unlocks (M, depth 3, journey order 1) · needs I-kyc-compliance-05
- `I-kyc-compliance-08` Guided individual verification and accepted ID documents (L, depth 3, journey order 1, refuses for an outside service) · needs I-kyc-compliance-01, I-kyc-compliance-05
- `I-signin-sessions-08` Security event notices (events first) (M, depth 3, journey order 1, refuses for an outside service) · needs I-signin-sessions-05, I-signin-sessions-06, I-signin-sessions-07
- `I-signin-sessions-10` Passkey as second step and per-purpose security keys (M, depth 3, journey order 1) · needs I-signin-sessions-01, I-signin-sessions-09
- `I-signin-sessions-19` Sign in by identifier and by one-time code (L, depth 3, journey order 1, refuses for an outside service) · needs I-signin-sessions-03, I-signin-sessions-20
- `I-signin-sessions-30` Bot, brute-force and challenge protection controls (M, depth 3, journey order 1) · needs I-signin-sessions-06
- `W-balances-01` Balances, available/locked breakdown, wallet-type grouping, per-network totals (M, depth 3, journey order 1) · needs W-deposit-05
- `W-deposit-03` Deposit entry, method chooser, network picker and wrong-network guard (M, depth 3, journey order 1, refuses for an outside service) · needs W-deposit-01, W-deposit-04
- `W-deposit-09` Deposit notifications, webhooks and sandbox simulated deposit (M, depth 3, journey order 1, refuses for an outside service) · needs W-deposit-05
- `W-withdraw-02` Withdrawal network catalogue, default network, tag rules, minimum, maximum and step (L, depth 3, journey order 1) · needs W-balances-05, W-deposit-04
- `W-withdraw-17` Counterparty VASP directory and private-wallet ownership proof (M, depth 3, journey order 1) · needs W-withdraw-08, W-withdraw-16
- `SP-order-01` Spot desk completeness: market orders, pro book, per-order detail and positions (M, depth 4, journey order 1) · needs SP-conditional-algo-01, SP-lifecycle-history-02
- `I-kyc-compliance-07` KYC capability model with a terminal inactive state (M, depth 4, journey order 1) · needs I-kyc-compliance-01, I-kyc-compliance-04
- `I-kyc-compliance-09` Selfie, face match and liveness (M, depth 4, journey order 1, refuses for an outside service) · needs I-kyc-compliance-01, I-kyc-compliance-08, I-kyc-compliance-10
- `I-kyc-compliance-11` Proof of address request, submission and accepted documents (M, depth 4, journey order 1, refuses for an outside service) · needs I-kyc-compliance-01, I-kyc-compliance-05, I-kyc-compliance-08
- `I-kyc-compliance-17` Restriction states and reasons shown to the customer (M, depth 4, journey order 1) · needs I-kyc-compliance-03, I-kyc-compliance-22
- `I-signin-sessions-25` Anti-phishing code (M, depth 4, journey order 1) · needs I-signin-sessions-01, I-signin-sessions-08
- `PF-overview-01` Portfolio home: holdings table with price, cost basis and unrealised result; value breakdown; valuation disclosure; best and worst movers (L, depth 4, journey order 1) · needs PF-cost-basis-01, PF-cost-basis-03
- `PF-performance-01` Unrealised and realised profit and loss, and the indicator label with its method (L, depth 4, journey order 1) · needs PF-cost-basis-01, PF-cost-basis-03
- `W-withdraw-01` Withdrawal request, review, confirm with step-up, success panel (L, depth 4, journey order 1) · needs W-withdraw-02
- `SP-order-entry-02` Market order sizing by value, protection and spread limit (M, depth 5, journey order 1) · needs SP-ops-02, SP-order-entry-01
- `SP-order-entry-03` Price band, pair rules, minimums and open-order caps (L, depth 5, journey order 1) · needs SP-ops-02, SP-order-entry-01
- `I-kyc-compliance-18` Email and phone verification screens (S, depth 5, journey order 1, refuses for an outside service) · needs I-kyc-compliance-03, I-kyc-compliance-20, I-kyc-compliance-23
- `W-deposit-11` Custody-refuse-then-full deposit journey and unhidden Deposit room (M, depth 5, journey order 1, refuses for an outside service) · needs W-deposit-01, W-withdraw-01
- `SP-fees-vip-02` Fee visibility: my rate, fill detail, public schedule and fee API (M, depth 6, journey order 1) · needs SP-fees-vip-01, SP-fees-vip-03
- `I-kyc-compliance-06` Eligibility at registration: age, residence, nationality, account type (M, depth 6, journey order 1) · needs I-kyc-compliance-18
- `I-signin-sessions-22` Account status page and blocked-action reasons (M, depth 6, journey order 1) · needs I-signin-sessions-08, I-signin-sessions-13, I-signin-sessions-16
- `SP-conditional-algo-01` Triggered stop orders: stop-market, stop-limit and pending list (L, depth 2, journey order 2) · needs SP-order-entry-01
- `SP-markets-data-02` Listing lifecycle: intake, delisting notices, opening window and higher-risk zone (L, depth 2, journey order 2, refuses for an outside service) · needs SP-developer-status-01
- `C-chart-core-04` Chart settings, legend, crosshair, data window and price-line overlays (L, depth 2, journey order 2) · needs C-alerts-scan-01, C-chart-core-01, C-embed-feed-ops-01
- `I-account-lifecycle-08` Self-service account freeze (M, depth 2, journey order 2, refuses for an outside service) · needs I-account-lifecycle-01
- `I-account-lifecycle-10` Close account: request, checks, cooling-off (M, depth 2, journey order 2) · needs I-account-lifecycle-01
- `I-account-lifecycle-12` Appeal a restriction, ban or closure (L, depth 2, journey order 2) · needs I-account-lifecycle-01, I-account-lifecycle-02
- `I-kyc-compliance-21` Business application: sections, draft, save and resume, submit (L, depth 2, journey order 2) · needs I-kyc-compliance-20
- `I-kyc-compliance-26` Business account benefits and limits (S, depth 2, journey order 2) · needs I-kyc-compliance-20
- `I-signin-sessions-06` Session lifetime, idle sign-out and concurrent session limit (M, depth 2, journey order 2) · needs I-signin-sessions-05
- `I-signin-sessions-09` Passkey management: rename, type labels, per-account limit (S, depth 2, journey order 2) · needs I-signin-sessions-01
- `I-signin-sessions-11` Authenticator app lifecycle: replace, disable, rename, keep codes (M, depth 2, journey order 2) · needs I-signin-sessions-01
- `OPS-accounts-desk-02` Console account state control (freeze, unfreeze, close, reopen), staff detail edit and customer archive (L, depth 2, journey order 2, refuses for an outside service) · needs OPS-accounts-desk-01
- `OPS-ledger-desk-02` Reverse a transaction and post a reviewed manual adjustment (L, depth 2, journey order 2) · needs OPS-change-control-01, OPS-ledger-desk-01
- `PF-cost-basis-02` Lots list, own-account transfers carry basis, deposits and rewards valued at the time (L, depth 2, journey order 2) · needs PF-cost-basis-01
- `PF-statements-01` Statement and export center, and balance snapshot on a past date valued in a chosen fiat (L, depth 2, journey order 2) · needs PF-cost-basis-01
- `W-balances-06` Activity history: list, detail, types, statements and exports (M, depth 2, journey order 2) · needs W-withdraw-06
- `W-security-accounts-02` Register a custom token or asset (M, depth 2, journey order 2) · needs W-balances-05
- `W-withdraw-07` Cancel a pending withdrawal and returned-withdrawal recovery (M, depth 2, journey order 2) · needs W-withdraw-06
- `W-withdraw-14` Internal off-chain settlement between platform accounts (M, depth 2, journey order 2) · needs W-withdraw-05
- `SP-conditional-algo-02` OCO pair, attached TP/SL bracket and OTO close (L, depth 3, journey order 2) · needs SP-conditional-algo-01, SP-order-entry-01
- `C-trade-dom-01` Time and sales, depth chart, ladder view and the DOM tied to the chart symbol (L, depth 3, journey order 2) · needs C-chart-core-01, C-workspace-01
- `HM-navigation-05` Simple and Pro as one account-level preference record (also the base for tiles, hide-amounts and theme) (M, depth 3, journey order 2) · needs HM-dashboard-01, HM-navigation-01, HM-shell-02, HM-widgets-01
- `I-account-lifecycle-07` Link and unlink sign-in methods (M, depth 3, journey order 2, refuses for an outside service) · needs I-account-lifecycle-01, I-account-lifecycle-03
- `I-account-lifecycle-09` Unfreeze and reactivate (M, depth 3, journey order 2, refuses for an outside service) · needs I-account-lifecycle-08
- `I-account-lifecycle-14` Founder accounts desk: search, account detail and export (L, depth 3, journey order 2) · needs I-account-lifecycle-08
- `I-kyc-compliance-03` Request for information (RFI) with deadline (M, depth 3, journey order 2, refuses for an outside service) · needs I-kyc-compliance-01, I-kyc-compliance-02
- `I-kyc-compliance-22` Business document checklist and upload rules (M, depth 3, journey order 2, refuses for an outside service) · needs I-kyc-compliance-20, I-kyc-compliance-21
- `I-kyc-compliance-25` Business status lifecycle and rejection feedback with in-place correction (M, depth 3, journey order 2, refuses for an outside service) · needs I-kyc-compliance-20, I-kyc-compliance-21
- `I-signin-sessions-13` Authenticator troubleshooting and move to a new phone (S, depth 3, journey order 2) · needs I-signin-sessions-11
- `OPS-ledger-desk-03` Unidentified deposits in suspense and the in-flight money view (L, depth 3, journey order 2, refuses for an outside service) · needs OPS-accounts-desk-01, OPS-ledger-desk-02
- `PF-cost-basis-03` Cost basis method per account or asset, and specific-lot matching per sale (L, depth 3, journey order 2) · needs PF-cost-basis-01, PF-cost-basis-02
- `PF-cost-basis-04` Customer-entered entry price, and the missing-basis warning with a guided fix (M, depth 3, journey order 2) · needs PF-cost-basis-01, PF-cost-basis-02
- `PF-overview-02` Value over time and holdings on a past date (valuation history foundation) (L, depth 3, journey order 2) · needs PF-balances-02, PF-cost-basis-02, PF-statements-01
- `PF-statements-02` Background exports with a document center (L, depth 3, journey order 2) · needs PF-statements-01
- `W-deposit-06` Deposit holds, returns, release and reorg reversal (L, depth 3, journey order 2) · needs W-deposit-05
- `RC-cex-spot-08` Published trading rulebook versions (M, depth 4, journey order 2) · needs SP-developer-status-02, SP-ops-01
- `SP-ops-02` Fee schedule and pair risk limits: versioned operator writes (L, depth 4, journey order 2) · needs SP-fees-vip-01, SP-ops-01
- `SP-ops-03` Support order lookup and trade bust with reconciliation (L, depth 4, journey order 2) · needs SP-ops-01
- `C-trade-dom-02` Ladder trading, buy and sell with live spread, instant placement setting, one-click close and cancel, presets (L, depth 4, journey order 2) · needs C-trade-dom-01, C-trade-dom-05
- `I-account-lifecycle-11` Re-registration block after closure (M, depth 4, journey order 2) · needs I-account-lifecycle-10, I-account-lifecycle-14
- `I-kyc-compliance-13` Enhanced due diligence and source-of-funds tasks (L, depth 4, journey order 2) · needs I-kyc-compliance-01, I-kyc-compliance-02, I-kyc-compliance-03
- `I-kyc-compliance-23` Beneficial owners, authorised persons and attestations (L, depth 4, journey order 2, refuses for an outside service) · needs I-kyc-compliance-19, I-kyc-compliance-20, I-kyc-compliance-21
- `I-signin-sessions-12` Self-service second-factor reset and recovery codes (L, depth 4, journey order 2, refuses for an outside service) · needs I-signin-sessions-01, I-signin-sessions-03, I-signin-sessions-08
- `I-signin-sessions-28` Compromised-account response and stolen-funds report (M, depth 4, journey order 2) · needs I-signin-sessions-05, I-signin-sessions-08
- `RC-cex-spot-01` Firm and session pre-trade credit on the spot door (L, depth 5, journey order 2) · needs SP-ops-01, SP-ops-02
- `SP-convert-buy-01` Convert quote, limit mode and large-order OTC routing (L, depth 5, journey order 2) · needs SP-ops-02, SP-order-entry-04
- `SP-convert-buy-02` Convert source account, asset rules and maintenance (M, depth 5, journey order 2) · needs SP-ops-02
- `SP-fees-vip-03` VIP tiers by volume and assets, snapshot schedule and benefits (L, depth 5, journey order 2) · needs SP-fees-vip-01, SP-ops-02
- `SP-lifecycle-history-03` Dead-man switch, statement exports and ledger history (L, depth 5, journey order 2) · needs SP-ops-03, SP-order-entry-04
- `SP-markets-data-03` Quoted currencies, market analytics, tokenized equities and maker rebate tiers (L, depth 5, journey order 2, refuses for an outside service) · needs SP-fees-vip-01, SP-markets-data-02, SP-ops-02
- `C-trade-dom-03` Chart order entry: projected line, create at price, order and position lines, drag to reprice, drag protection (L, depth 5, journey order 2) · needs C-trade-dom-02, C-trade-dom-05
- `HM-shell-03` One shared service-off notice and typed refusal on every shell action (M, depth 5, journey order 2, refuses for an outside service) · needs HM-notifications-02, HM-shell-01
- `I-signin-sessions-14` Factor status and Security centre checklist (M, depth 5, journey order 2) · needs I-signin-sessions-09, I-signin-sessions-11, I-signin-sessions-25
- `I-signin-sessions-16` Withdrawal hold after security changes (identity decision) (M, depth 5, journey order 2) · needs I-signin-sessions-11, I-signin-sessions-12, I-signin-sessions-18
- `PF-performance-02` P&L views, transfers setting and fees booked into realised result (M, depth 5, journey order 2) · needs PF-cost-basis-01, PF-performance-01
- `PF-performance-03` Cumulative P&L chart, breakdown by asset, market and day, and the change-in-value bridge (L, depth 5, journey order 2) · needs PF-cost-basis-01, PF-cost-basis-02, PF-overview-02, PF-performance-01
- `W-balances-08` Historical balance snapshots and proof of reserves (M, depth 5, journey order 2) · needs W-custody-ops-04
- `RC-cex-spot-02` Pro desk flatten control (S, depth 6, journey order 2) · needs SP-order-01, SP-order-entry-02
- `RC-cex-spot-06` Maker incentive programme: tiers, obligations, monitoring and clawback (L, depth 6, journey order 2) · needs SP-fees-vip-01, SP-markets-data-03, SP-ops-02, SP-ops-04
- `SP-convert-buy-03` Convert history, cash-currency conversion through crypto and the convert API (L, depth 6, journey order 2) · needs SP-convert-buy-01, SP-convert-buy-02
- `SP-convert-buy-04` Buy and sell card: payment step, sell quote and target price (L, depth 6, journey order 2, refuses for an outside service) · needs SP-convert-buy-01, SP-order-entry-01
- `SP-markets-data-04` Retail price improvement liquidity layer (blocked on an engine note) (L, depth 6, journey order 2, refuses for an outside service) · needs SP-markets-data-03
- `SP-order-02` FIX and SBE adapters, matching and trade health, and market maker seed honesty (M, depth 6, journey order 2) · needs SP-ops-03, SP-ops-04
- `I-kyc-compliance-14` One account per person: duplicates, identity transfer, personal vs business exclusivity (L, depth 6, journey order 2) · needs I-kyc-compliance-01, I-kyc-compliance-02, I-kyc-compliance-16
- `I-signin-sessions-15` Fund password (M, depth 6, journey order 2) · needs I-signin-sessions-01, I-signin-sessions-16
- `I-signin-sessions-17` Personal withdrawal limits, large-withdrawal protection, channel restrictions (L, depth 6, journey order 2) · needs I-signin-sessions-16
- `I-signin-sessions-23` Change email or phone screens (M, depth 6, journey order 2, refuses for an outside service) · needs I-signin-sessions-01, I-signin-sessions-08, I-signin-sessions-16
- `W-balances-09` Custody and safeguarding disclosures (S, depth 6, journey order 2) · needs W-balances-08
- `RC-cex-spot-09` Launch-liquidity plan record per market (M, depth 7, journey order 2) · needs RC-cex-spot-06, SP-markets-data-02, SP-ops-01
- `RC-cex-spot-17` Internal book seeding: operator-written config and console (M, depth 7, journey order 2, refuses for an outside service) · needs RC-cex-spot-01, SP-ops-02, SP-order-02
- `SP-fees-vip-04` Fee currency, VIP application, fee-change notices and fiat buy fees (L, depth 7, journey order 2, refuses for an outside service) · needs SP-convert-buy-04, SP-fees-vip-01, SP-fees-vip-03, SP-order-entry-04
- `I-signin-sessions-24` Operator session tools, recovery link and support-assisted recovery (L, depth 7, journey order 2, refuses for an outside service) · needs I-signin-sessions-12, I-signin-sessions-22
- `RC-cex-spot-11` Pay trading fees in IFC with the published decay discount (L, depth 8, journey order 2) · needs SP-fees-vip-02, SP-fees-vip-04, SP-order-entry-04
- `SP-developer-status-02` Developer portal: overview, announcements, error format and changelog (M, depth 2, journey order 3) · needs SP-developer-status-01
- `I-account-lifecycle-03` Sub-account lifecycle: types, freeze control, delete (M, depth 2, journey order 3) · needs I-account-lifecycle-01
- `W-withdraw-10` Allowlist default-deny, one-time-send policy and governed changes (L, depth 2, journey order 3) · needs W-security-accounts-04, W-withdraw-08
- `W-withdraw-11` Multi-approval for withdrawals (N-of-M, amount locked at submit) (L, depth 2, journey order 3) · needs W-security-accounts-04, W-withdraw-06
- `W-withdraw-12` Create a withdrawal through a scoped API key (D-167) (M, depth 2, journey order 3) · needs W-security-accounts-01, W-withdraw-05
- `SP-conditional-algo-04` Trailing stop and the algo order API (L, depth 3, journey order 3) · needs SP-conditional-algo-01, SP-order-entry-01
- `SP-developer-status-03` Rate limits, demo environment and private balances stream (L, depth 3, journey order 3) · needs SP-developer-status-02
- `SP-order-entry-05` Chase orders and triggered market retry (L, depth 3, journey order 3) · needs SP-conditional-algo-01, SP-order-entry-01
- `I-account-lifecycle-04` Sub-account sign-in controls and switching accounts (L, depth 3, journey order 3) · needs I-account-lifecycle-01, I-account-lifecycle-03
- `I-kyc-compliance-19` Customer sanctions, PEP and adverse-media screening (L, depth 3, journey order 3, refuses for an outside service) · needs I-kyc-compliance-01, I-kyc-compliance-02
- `W-deposit-10` Lightning deposit by invoice (M, depth 3, journey order 3, refuses for an outside service) · needs W-deposit-05
- `RC-cex-spot-05` Historical tick, book and trade data downloads (L, depth 4, journey order 3) · needs SP-developer-status-02, SP-markets-data-01
- `C-chart-core-05` Compare symbols, snapshot, export and indicator panes (M, depth 4, journey order 3) · needs C-chart-core-01, C-drawings-indicators-01, C-drawings-indicators-02
- `C-trade-dom-04` Account panel, ticket layout, CSV export and paper trading (L, depth 4, journey order 3) · needs C-trade-dom-01
- `HM-shell-01` Exchange and Web3 switch: a separate Self-custody shell that remembers the last room in each (L, depth 4, journey order 3) · needs HM-navigation-03, HM-navigation-05
- `I-account-lifecycle-06` Organisation security policy: member 2FA and idle sign-out (M, depth 4, journey order 3) · needs I-account-lifecycle-01, I-account-lifecycle-05, I-account-lifecycle-14
- `W-balances-10` Link exchange account to self-custody wallet (M, depth 4, journey order 3) · needs W-withdraw-17
- `SP-conditional-algo-03` Iceberg, TWAP and the algo tracking tab (L, depth 5, journey order 3) · needs SP-ops-02, SP-order-entry-01, SP-order-entry-04
- `SP-ops-04` Trade surveillance views: read-only cases and adjudication record (M, depth 5, journey order 3) · needs SP-ops-02
- `I-kyc-compliance-16` Document renewal and periodic profile review (M, depth 5, journey order 3) · needs I-kyc-compliance-01, I-kyc-compliance-03, I-kyc-compliance-13
- `PF-cost-basis-05` Country-specific cost-basis methods and defaults (Preview) (S, depth 5, journey order 3) · needs PF-tax-01
- `PF-overview-04` Mask balances by tapping the value or on a timer; add, hide and reorder dashboard widgets (M, depth 5, journey order 3) · needs PF-overview-02, PF-performance-01
- `W-withdraw-15` Lightning invoice withdrawal (M, depth 5, journey order 3, refuses for an outside service) · needs W-withdraw-01
- `SP-desk-account-01` Order form settings, confirmation preferences and share order (M, depth 6, journey order 3) · needs SP-order-entry-02
- `I-kyc-compliance-15` Change verified details and residence (M, depth 6, journey order 3) · needs I-kyc-compliance-01, I-kyc-compliance-11, I-kyc-compliance-16
- `SP-desk-account-02` Mobile ticket, desk layout, favourites and depth widget, and spot account structure (L, depth 7, journey order 3) · needs SP-desk-account-01
- `OPS-screening-01` Sanctions-hit queue: status, match detail, review decision, bulk dismiss and force-resolve (L, depth 2, refuses for an outside service) · needs OPS-cases-01
- `W-withdraw-16` Travel-rule applicability, capture and status on withdrawals (L, depth 2, refuses for an outside service) · needs W-compliance-notices-04
- `I-kyc-compliance-12` Onboarding risk questionnaire and tax certification (M, depth 3) · needs I-kyc-compliance-01, I-kyc-compliance-05
- `OPS-screening-04` List refresh and health, screening audit log, trigger points and hit routing (L, depth 3, refuses for an outside service) · needs OPS-screening-01
- `W-deposit-07` Deposit travel-rule declaration and held/released state (M, depth 3, refuses for an outside service) · needs W-compliance-notices-04, W-deposit-05, W-withdraw-16
- `I-kyc-compliance-24` Business due-diligence and AML programme questionnaires (M, depth 4) · needs I-kyc-compliance-12, I-kyc-compliance-21
- `OPS-screening-03` Screening lists catalogue, match policy, presets, saved searches and internal watchlists (L, depth 4, refuses for an outside service) · needs OPS-screening-04
- `RC-cex-spot-04` Corporate action and token migration policies (L, depth 5, refuses for an outside service) · needs CM-airdrop-campaigns-01, SP-markets-data-02, SP-ops-01, W-compliance-notices-01
- `RC-cex-spot-13` Venue registry, adapter families and latency thresholds (L, depth 5, refuses for an outside service) · needs SP-ops-02
- `OPS-screening-02` Screening search: entity search, explainable scores, dataset selection, PEP filters and refinement (L, depth 5, refuses for an outside service) · needs OPS-screening-03, OPS-screening-04
- `RC-cex-spot-10` FX desk: forex pairs as their own product with conventions and fiat settlement (L, depth 6, refuses for an outside service) · needs SP-markets-data-03, SP-ops-01, SP-order-entry-03
- `RC-cex-spot-14` Venue Vault: durable encrypted external exchange keys, trade-only (L, depth 6) · needs RC-cex-spot-13
- `RC-cex-spot-16` Market-making engine console: parameters, inventory bands and per-venue kill (L, depth 6, refuses for an outside service) · needs RC-cex-spot-13, SP-ops-01, SP-ops-04
- `OPS-screening-05` Continuous screening: configurations, field mapping, monitored objects, triggers and routing to a case inbox (L, depth 6, refuses for an outside service) · needs OPS-cases-01, OPS-screening-02
- `RC-cex-spot-12` Consolidated book with per-source breakdown (M, depth 7, refuses for an outside service) · needs SP-markets-data-01, SP-order-02
- `RC-cex-spot-03` Account and order-routing profiles (M, depth 8) · needs SP-desk-account-01, SP-desk-account-02, SP-order-entry-04
- `RC-cex-spot-15` Cross-venue smart order router with execution reports (L, depth 8, refuses for an outside service) · needs RC-cex-spot-12, RC-cex-spot-13, RC-cex-spot-14
