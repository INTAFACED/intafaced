# INTAFACED RFQ, Block, OTC, and Institutional Allocation Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S09`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M12-R01–R08`

**Predecessors:** `PX-S01` rulebook/lifecycle, `PX-S02` participant authority, `PX-S03` orders/execution, `PX-S04` connectivity/data, `PX-S05` terminal/OMS/TCA, `PX-S06` collateral/risk/default, `PX-S07` product/FX settlement, `PX-S08` options/volatility, `PX-S11` institutional reporting/service, `PX-S12` custody/reconciliation/wind-down, `PX-S13` resilience; reuses [`SPEC-OTC-RFQ-AND-EARN-2026-08-02.md`](SPEC-OTC-RFQ-AND-EARN-2026-08-02.md) Part A

**Systems of record:** PX-S02 owns client/account/delegation authority; PX-S03 owns orders/executions; PX-S06 owns risk/credit/default; PX-S12 owns custody/settlement/reconciliation; `packages/ledger-client` plus `svc-ledger` remain the only money book; this contract owns RFQ/block/OTC capacity truth, quote/session lifecycle, institutional allocation/give-up workflow, and their product-specific evidence

---

## 1. Product promise, professional jobs, and boundary

Institutional takers, market makers, brokers, agency and principal desks, fund managers, executing/carrying firms, operations, credit, compliance, surveillance, finance and auditors can negotiate large or complex trades privately, compare firm outcomes, control information exposure, allocate only to authorized accounts, settle through an explicit counterparty/custody model, and reconstruct every human or electronic action.

This determines primary-venue adoption because large trades cannot safely use a visible central book alone. Institutions will not center flow where a quote can be repriced after acceptance, an affiliate learns private intent, a failed child allocation changes the parent truth, a block evades public reporting, or an external maker obligation is silently booked to the platform.

Catastrophic or dishonest outcomes include concealed principal capacity or markup; “firm” last look; partial multi-leg execution without consent; quote leakage/front-running; aggregation used to manufacture block eligibility; allocation exceeding mandate or changing beneficial owner; average price transferring value between clients; one settlement leg final while the other is not; a three-step posting stranding holds; or a voice trade bypassing risk, fees, surveillance and the ledger.

M12 remains grouped. RFQ negotiation, block rules, OTC counterparty/settlement, allocations, give-up and manual capture share one causal execution and post-trade chain. Splitting them would let front-office firmness diverge from legal owner, carrying account, money and public-reporting truth.

Non-goals:

- no legal entity, jurisdiction, eligible participant, maker/counterparty, capacity model, credit/custody/settlement path, block threshold/reporting delay, quote lifetime, spread/markup/fee, size, netting right, allocation method, tolerance, SLO or commercial term is invented;
- P2P escrow remains its existing product and ledger recipes; it is not relabeled institutional DvP or used as an unapproved RFQ settlement shortcut;
- no second RFQ engine, OMS, risk book, allocation ledger, custody system, money book or product SPA is created;
- private negotiation never means unaudited, undisclosed to required authorities, exempt from risk, or exempt from market-integrity rules;
- a green tracker row proves only its platform-principal single-leg slice, not the M12 north star.

## 2. Research delta and durable patterns

Current official sources add durable contract requirements:

- [Deribit Block RFQ](https://docs.deribit.com/api-reference/block-rfq/private-create_block_rfq) binds signed legs, targeted makers, disclosed/anonymous mode, one optional hedge leg and broker/client pre-allocation; its [RFQ state surface](https://docs.deribit.com/api-reference/block-rfq/private-get_block_rfqs) distinguishes open/filled/cancelled/expired and all-or-none versus partial quotes.
- [OKX group-RFQ change contract](https://www.okx.com/docs-v5/log_en/) requires parent and per-account identities, equal leg ratios, account-level results, parent truth based on actual successful children, and public parent-level reporting. Partial success is a first-class outcome, not a boolean shortcut.
- [CME Rule 526 guidance](https://www.cmegroup.com/rulebook/files/cme-group-Rule-526.pdf) reinforces product/strategy-specific minimums, fair/reasonable pricing, exact execution time, credit checks, prescribed reporting windows, and the separation of privately negotiated blocks from regular-book order triggering.
- [FIX post-trade allocation](https://www.fixtrading.org/wp-content/uploads/download-manager-files/FIX-Latest-Specification-PostTrade.pdf) distinguishes preliminary, calculated, ready-to-book and warehouse instructions; supports average-price or execution-price allocation and fragmented messages whose quantities must reconcile.

These are workflow and evidence patterns only. INTAFACED does not copy thresholds, eligibility, allocation law, anonymity rules or legal applicability.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT`     | `svc-trade/otc` has durable single-leg quotes and `open → bound → settled` storage; server-side mid freshness; exact bigint price/spread math; disclosed platform/maker mode and ID; quote size/expiry; no-last-look acceptance; principal inventory/taker holds and fill through `ledger-client`; stable settlement IDs; mounted policy/quote/accept/settle doors and substantive tests. |
| `PARTIAL`   | Platform-principal settlement is real but is three ordered idempotent ledger posts, not an atomic workflow. Existing generic order/multi-leg, portfolio risk, broker/sub-account, manual-fill, report, reconciliation and P2P escrow foundations are reusable. Terminal/API fragments expose bounded OTC actions.                                                                         |
| `SPECIFIED` | The predecessor contracts and `SPEC-OTC-RFQ-AND-EARN` already forbid last look, require counterparty/markup/size/expiry truth, and bind authority, risk, money, correction and wind-down boundaries.                                                                                                                                                                                      |
| `SOCKET`    | Desk law, legal counterparty/capacity, maker routing/ledger/custody, venue mid feed, credit, products, RFQ maker/anonymity/partial rules, block eligibility/reporting, allocations/give-up, settlement/netting and voice governance require owner/legal/external authority.                                                                                                               |
| `EXTERNAL`  | Makers, brokers, clients, carrying/clearing firms, custodians, venues, price sources, settlement networks, trade repositories and regulatory/public-report channels need authenticated contracts and exit evidence.                                                                                                                                                                       |
| `ABSENT`    | No matched-principal/agency lifecycle, multi-maker quote comparison, targeted/anonymized multi-leg RFQ, block-rule engine/reporting, institutional pre/post-allocation, average-price/bunched allocation, give-up/claim/take-up, confirmation/affirmation, counterparty credit/limit integration, or governed voice/chat/manual capture was found.                                        |

The `trade.otc` tracker row and mount are explicitly bounded: platform principal is real, while `gap.socket_otc_maker_routing` and `gap.connect_venue_vault_custody` remain. The access stake gate is an existing product condition, not evidence of institutional eligibility, legal capacity or credit.

## 4. Terms, actors, objects, identifiers, and clocks

Capacity is one of:

- `PRINCIPAL`: the disclosed INTAFACED legal entity is the client's counterparty and uses approved house inventory/capital;
- `MATCHED_PRINCIPAL`: the disclosed entity faces both sides under one governed, contingent execution/settlement lifecycle without retaining an undisclosed market position;
- `AGENCY`: the desk/broker routes or arranges between named or disclosure-governed counterparties and does not become principal merely because it transports or records the trade.

Actors include legal/beneficial owner, organization, fund/client, master/sub-account, portfolio manager/trader, broker/authorized manager, executing desk/firm, carrying/clearing firm, principal, maker, settlement/custody agent, credit/risk, operations, compliance/surveillance, reporter, manual capturer, approver and auditor. Capacity and duties are explicit at every stage.

Canonical objects include `RfqSession`, `RfqRequest`, `RfqLeg`, `HedgeLeg`, `MakerInvitation`, `RfqQuote`, `QuoteComparison`, `RfqExecution`, `BlockEligibilityDecision`, `BlockReport`, `AllocationGroup`, `AllocationInstruction`, `AllocationLine`, `AveragePriceGroup`, `GiveUpInstruction`, `TakeUpClaim`, `Confirmation`, `Affirmation`, `SettlementInstruction`, `SettlementCase`, `ManualExecutionCapture`, and `CorrectionCase`.

Stable IDs include owner/account/sub-account/client/fund, actor/session/key, RFQ/request/parent/group/invitation, quote/maker/quote-set, leg/instrument, block/execution/trade/fill, allocation-group/instruction/line/version, average-price group, give-up/claim/carrying account, confirmation/affirmation, settlement/instruction/rail/counterparty, ledger transaction/entry, report/disclosure, manual source/evidence, correction/case/incident and rule/schema/model versions.

Clocks distinguish request creation/open/close, maker invitation/view/quote/update/withdraw, quote receipt/validity/acceptance, trade agreement/execution capture, block reporting deadline/publication, allocation cutoff/approval/ready-to-book, give-up/claim/accept/reject, confirmation/affirmation, settlement instruction/value/finality, correction and source event/receive/publish time. Server time and clock quality are authoritative; client timestamps remain evidence, not state authority.

## 5. Constitutions, eligibility, and capacity truth

Every enabled workflow has a versioned `RfqOtcConstitution` linked to PX-S01: legal service entity/capacity, eligible participants/accounts/jurisdictions/products, maker/broker/client roles, counterparty disclosure, request/quote/acceptance rules, information policy, fees/markup, risk/credit/custody/settlement, block thresholds/reporting, allocation/give-up, manual capture, corrections, records, suspension and wind-down.

Before request or quote, PX-S02/PX-S06 establish actor authority, client mandate, product/account eligibility, counterparty/credit/custody limits and conflicts. A broker cannot aggregate clients, select capacity, disclose identity, allocate, affirm, change settlement instructions or accept risk without a grant covering that exact action.

Missing constitution, legal counterparty ID, capacity, credit line/cap, inventory, settlement path or disclosure refuses at the smallest scope. Code labels such as `platform:otc-desk`, feature flags, stake tiers, environment JSON and generic house accounts are not legal-entity/capacity authority.

## 6. RFQ request, information exposure, and maker invitation

An `RfqRequest` binds requester/beneficial owner/account, capacity, product and signed legs/ratios, aggregate quantity, package/leg price convention, settlement terms, optional hedge leg, requested firmness/partial rules, response/execution window, eligible/targeted makers, anonymity/disclosure stages, allocation intent, client restrictions and rule/risk versions.

State is:

`DRAFT → VALIDATED → OPEN → QUOTING → QUOTE_SELECTION → EXECUTION_PENDING → EXECUTED`

with `CANCEL_PENDING`, `CANCELLED`, `EXPIRED`, `REFUSED`, `PARTIAL`, `OUTCOME_UNKNOWN`, `ALLOCATION_PENDING`, `SETTLEMENT_PENDING`, `CORRECTION_REQUIRED` and `WIND_DOWN` as applicable. Cancel cannot erase a firm acceptance or completed child. Timeout is unknown until authoritative lookup/reconciliation.

Maker targeting and anonymity are owner/legal rules. The taker sees which identity attributes each maker receives, when, for what purpose and retention; makers see only entitled request fields. Aliases never hide identity from authorization, credit, compliance, surveillance or settlement. Invitation/view/download/quote events are audited to detect leakage, selective disclosure and front-running.

## 7. Quote, comparison, firmness, and acceptance

Each quote binds request/session, maker/legal counterparty/capacity, leg instruments/sides/ratios, executable aggregate and remaining quantity, package and governed leg prices, exact amounts/currencies, fees/markup/spread, settlement/custody/credit terms, all-or-none/partial rule, quote/version IDs, creation/expiry, model/reference provenance and refusal conditions.

`INDICATIVE` is never executable. `FIRM` means an authorized acceptance received before expiry either executes those exact terms or returns a named technical/risk/capacity failure; no maker or platform may observe post-acceptance market movement and reprice. Quote withdrawal/update creates a new version and cannot outrun an already ordered authoritative acceptance.

Comparison normalizes only genuinely comparable quantity, legs, price convention, fees/markup, credit, custody, value date, settlement/finality and partial terms. Non-comparable differences stay visible. Ranking methodology, conflicts and excluded quotes are reproducible; best displayed price is not automatically best settleable outcome.

Acceptance requires an idempotency key, current mandate/risk/credit, quote version and explicit partial/AON consent. Atomic multi-leg execution follows PX-S03/PX-S08. Child/leg/hedge results preserve parent causality and actual successful quantity; parent success cannot include failed children.

## 8. Principal, matched-principal, agency, and maker routing

Principal execution reserves approved inventory/capital before binding the client and identifies the platform legal counterparty, price source, spread/markup/fees, conflict, custody and settlement. It cannot call a general house label a legal identity.

Matched-principal execution has two linked obligations and defined contingency: neither leg may create an unapproved open position, unmatched client claim or hidden financing. Agency routing identifies maker/execution venue, broker role, fee/markup, client consent, settlement arrangement and what happens if the maker fails before or after execution.

`socket.otc-maker-routing` remains refuse-closed until owner-published maker eligibility, authenticated quote route, credit/custody/settlement contract, exact ledger recipes, reconciliation and exit path exist. A maker ID supplied by a caller is not routing proof. No mode silently falls back to platform principal or a different maker.

## 9. Block eligibility, execution, reporting, and book interaction

A `BlockEligibilityDecision` resolves product/strategy, account/participant class, exact aggregate/leg quantities, threshold/rule version, aggregation authority, execution method/time, price/tick reasonableness, credit, consent and reporting obligation before execution. Thresholds and reporting windows are owner/legal sockets; no external example becomes INTAFACED law.

Aggregation across accounts is allowed only under explicit legal/client authority and cannot manufacture eligibility by mixing unauthorized beneficial owners. Each underlying account remains identifiable. A block or cross cannot interact with, trigger, elect, trade through or gain priority over the central book except as the published PX-S01/PX-S03 rule explicitly states.

Execution time is when parties become bound under the constitution, distinct from entry, capture, confirmation, allocation and settlement. Each leg has an exact price/quantity and parent package price where applicable. Late, amended, cancelled, busted or corrected reports retain original facts and authority.

Public/delayed reporting publishes only the rule-authorized fields/timing at parent and/or leg level, protects prohibited identities, and never hides a reportable affiliate/house/block trade. Reporting failure enters `REPORT_OVERDUE` and escalation; it does not rewrite execution time or make the trade disappear. Surveillance receives complete private facts regardless of public delay.

## 10. Pre-allocation and post-trade allocation

An `AllocationGroup` binds parent RFQ/order/executions, broker/manager authority, client/fund/sub-account set, allocation method, price method, total quantity, fee/commission policy, cutoff and version. Each `AllocationLine` binds beneficial owner, destination account, signed leg quantities/ratios, price or average-price group, fees, risk/margin, eligibility and status.

Pre-allocation validates every account, mandate, product, ratio, quantity total, risk/credit, settlement instruction and duplication before request/acceptance. If policy permits partial account success, that fact is disclosed before quoting; successful and failed children are both retained with reasons. Otherwise one failed child refuses the group.

Post-trade allocation cannot change aggregate executed quantity, side, instrument/leg ratio, total gross/net money or beneficial-owner authority. State is:

`DRAFT → VALIDATING → PRELIMINARY → APPROVAL_PENDING → APPROVED → READY_TO_BOOK → BOOKING → BOOKED → RECONCILED`

with `PARTIAL`, `REJECTED`, `BREAK`, `CORRECTION_PENDING`, `CANCELLED` and `WAREHOUSED` only under explicit policy. Every transition is versioned/idempotent; concurrent amendments use optimistic version/fencing, never last writer wins.

Average price is exact and reproducible from named fills, quantity weights, rounding and residual allocation law. It cannot transfer value between clients through arbitrary rounding or cherry-picked fills. Fees/commissions remain per-account facts and totals reconcile. Execution-price allocation remains distinct.

## 11. Give-up, carrying accounts, bunched orders, affirmation, and confirmation

An `AveragePriceGroup` closes before give-up and retains source fills, running/final average, completion time and correction. A `GiveUpInstruction` identifies executing firm/account, carrying/clearing firm/account, client/fund, group/trades, quantity, price method, fees, settlement terms, agreement and deadline.

Give-up state is:

`PROPOSED → VALIDATED → SENT → ACKNOWLEDGED → CLAIM_PENDING → CLAIMED → ACCEPTED → BOOKED → RECONCILED`

or `REJECTED`, `EXPIRED`, `BREAK`, `RETURNED`, `CORRECTION_PENDING`. Rejection never deletes the executing account's obligation; it creates an explicit warehouse/carrying exposure under owner-approved credit and default law. A miscellaneous house account is not a plug.

Affirmation confirms economic and allocation facts; confirmation records the agreed legal trade terms; neither proves settlement. Instruction changes authenticate both authority and version, preserve the prior instruction, rerun sanctions/counterparty/custody checks, and cannot redirect value after the irreversible point without governed cancel/reissue.

Bunched orders preserve underlying client mandates from parent through fills, average price, allocations, give-up and reports. Broker, executing, clearing/carrying and beneficial-owner identities remain distinct even where public output is anonymous.

## 12. Settlement, custody, DvP, netting, limits, fails, and disputes

PX-S12 owns custody/finality/reconciliation. Each executed obligation names debtor/creditor, legal counterparty, assets/currencies and exact amounts, trade/value/settlement dates, custody locations/accounts, rail, instruction version, DvP/PvP/escrow/gross/net method, finality, credit exposure, collateral and failure/default/exit path.

DvP/PvP is claimed only when the named mechanism proves conditional final transfer of both legs. Internal paired ledger postings, pre-funding, bilateral netting or escrow can mitigate risk but cannot impersonate external finality. Netting is used only with enforceable owner/legal authority and preserves gross trades/obligations, allocations and residual exposures.

Counterparty/settlement limits are checked at request, quote, acceptance, allocation, instruction change and before external dispatch. Missing or stale limit/capacity refuses new exposure. Existing obligations remain visible and enter containment, margin/default or recovery.

Settlement states distinguish `INSTRUCTED`, `ACCEPTED`, `MATCHED`, `FUNDED`, `PARTIAL`, `ONE_LEG_FINAL`, `SETTLED`, `FAILED`, `RETURNED`, `OUTCOME_UNKNOWN`, `DISPUTED`, `DEFAULTED`, `CORRECTION_REQUIRED`. A timeout or ledger post does not prove external settlement.

Every internal hold/transfer/release/reversal/correction uses an approved balanced `ledger-client` recipe. Decimal strings cross boundaries and scaled bigint holds money in memory. Multi-post workflows use a durable journal/state machine with compensation/release paths. The existing principal OTC `mmHold → takerHold → fill` sequence is idempotent but not atomic: any failure after a hold must be observable, resumable and releasable without manual balance edits.

## 13. Voice, chat, and manual-assisted execution

Human-assisted intent uses an approved recorded channel and creates a `ManualExecutionCapture` with source/evidence reference, client/legal owner/account, actor/desk, authority/mandate, counterparty/capacity, instruments/legs, exact economics, timestamps/timezone, quote/consent/firmness, fees/markup, risk/credit, block/reporting, allocation and settlement.

Capture follows dual control where policy requires and enters the same server-side validation, execution/fill, ledger, drop-copy, reporting and surveillance chain as electronic flow. A pasted chat, phone note or operator row cannot create a fill or move value by itself. Late capture is labeled, escalated and never backdated to conceal a reporting breach.

Corrections append linked versions and balanced compensating postings. They distinguish capture error, client instruction change, execution error, allocation break and settlement correction; authority and loss ownership are explicit. Manual work cannot waive last-look, client consent, sanctions, market integrity or evidence retention.

## 14. API, FIX, WebSocket, terminal, events, and reports

PX-S04 transports canonical request/invitation/quote/acceptance/execution/allocation/give-up/confirmation/settlement objects through REST, private WebSocket, FIX and drop copy with sequence/replay, idempotency, entitlements and versioning. Bulk/fragmented messages declare total parts/quantities and refuse incomplete reconciliation.

The PX-S05 terminal supplies request construction, maker targeting/anonymity preview, quote comparison, capacity/counterparty/fee/settlement truth, block eligibility/reporting timer, allocation matrix, give-up/confirmation queues and break dashboards. `FIRM`, `INDICATIVE`, `PARTIAL`, `STALE`, `EXPIRED`, `OUTCOME_UNKNOWN`, `REPORT_OVERDUE`, `UNALLOCATED`, `WAREHOUSED`, `SETTLEMENT_FAILED` and `PAPER` are unambiguous.

Events and drop copy preserve parent/session/quote/leg/child/allocation/give-up/manual/settlement causality, actor/source protocol, rule versions, exact decimal facts, corrections and public-report linkage. Reports reconcile RFQ response quality, execution, counterparty/capacity, fees/markup, allocations, blocks, confirms, settlement, credit exposure, ledger, breaks and correction under PX-S11.

## 15. Concurrency, replay, correction, degraded states, and recovery

Race tests cover quote update/withdraw versus accept; cancel versus execution; maker/taker disconnect; duplicate accept/settle; group child failure; allocation amend/approval/cutoff; give-up claim/reject; instruction change/dispatch; public-report retry; and manual capture/correction. One authoritative version/watermark selects outcomes; queue arrival order never does.

Recovery rehydrates constitutions, RFQ sessions, invitations/quotes, executions, block reports, allocations/give-ups, confirmations, settlements, ledger links and corrections before new exposure. Accepted economics are not repriced from current markets. Partial/unknown states remain customer/operator-visible and reconcile.

Named degraded scenarios include no/stale/divergent mid, maker withdrawal/default, credit/custody/rail outage, quote/cancel storm, private-data leak, incomplete group execution, allocation/give-up break, missed report deadline, confirmation mismatch, one-leg-final settlement, operator/channel outage, clock fault, region loss and ledger/reconciliation failure.

Safety stops new requests/quotes/acceptance/exposure before cancel, evidence, accepted-trade completion and governed settlement/recovery. Customer status names affected stage and scope; “OTC operational” cannot mean only that the policy endpoint is reachable.

## 16. Integrity, conflicts, security, privacy, and retention

Surveillance correlates beneficial owners, brokers, makers, affiliates/house capacity, private RFQs/quotes, blocks, book/underlying flow, allocations, manual capture, reporting and settlement. It covers wash/prearranged abuse, block-threshold evasion, off-book trading, spoof requests/quotes, quote leakage/front-running, selective maker access, last look, marking, allocation cherry-picking, fee shifting and concealment through corrections.

Principal/affiliate/internal makers are legally reviewed, segregated and disclosed as required. They cannot access competitor quotes or client identity/intent beyond the published RFQ disclosure stage, receive hidden priority/data/fees/error treatment, or use allocation/manual tools to cure unauthorized risk.

Scopes separate request, quote, accept, block, allocate, approve, give-up/claim, confirm/affirm, settlement instruction, manual capture, correction and reporting. Credentials bind organization/account/capacity/environment and revoke active sessions. Private intent, identities, strategies, credit and settlement data are least-privilege, encrypted, redacted and retained/deleted under policy/legal hold.

## 17. Capacity, SLO, observability, incident behavior, and wind-down

PX-S13 owns magnitudes. Capacity dimensions include sessions/makers/legs/quotes, invitation/private fan-out, quote bursts, group accounts/allocation lines, block reports, confirmation/give-up/settlement queues, credit/custody quotas, long sessions, private/drop-copy/report delivery and break backlog.

Fault/load proof covers hot multi-maker RFQs, burst accept/cancel, complex legs, correlated account failures, reporting deadlines, allocation close, settlement cutoffs, external/region loss and replay storms. Optional comparison/analytics shed before authoritative accept/cancel/risk/report/settlement/evidence. Tenant fairness prevents one desk from starving others.

Observability separates request validation, maker delivery, quote receipt, acceptance, execution, risk/credit, ledger, allocation, report, confirmation and external settlement. Metrics expose age/backlog/partial/break/retry/reconciliation without private high-cardinality labels. Incident communications preserve anonymity while stating product/stage/action impact.

Rollout is paper/sandbox/shadow before bounded approved entities/products/counterparties; simulated quotes/trades never post or report as live. Rollback stops new exposure, reconciles accepted facts and preserves client/reporting duties. Wind-down inventories all requests/quotes/trades/blocks/allocations/give-ups/settlements/holds/reports/disputes and proves zero or explicit residual obligations plus portable evidence.

## 18. Definition of Done

PX-S09 is implementation-complete only when evidence proves:

1. principal, matched-principal and agency workflows disclose legal counterparty/capacity/markup and refuse missing inventory, credit, custody or route;
2. firm quote lifecycle, targeting/anonymity, multi-leg/hedge, comparison, expiry/withdraw/accept and no-last-look pass race/replay tests;
3. block eligibility, fair-price/tick, execution time, book interaction, public/delayed reporting and surveillance pass product/rule fixtures;
4. pre/post-allocation validates authority, totals, ratios, risk, price/fees, partial success, breaks, approval, correction and reconciliation;
5. average-price/bunched and give-up/claim/take-up/carry workflows preserve all parties/accounts and never warehouse exposure without authority/limits;
6. confirmation/affirmation/instruction and DvP/net/gross/escrow settlement states reconcile exact money, credit, custody and external finality;
7. every partial multi-post settlement failure resumes or compensates without stranded client/house holds or manual balance edits;
8. voice/chat/manual execution enters identical authority, risk, fee, execution, ledger, report, correction and surveillance paths;
9. API/FIX/WebSocket/drop-copy/terminal/reports agree on IDs, state, exact amounts, capacity, allocation, finality, degraded truth and corrections;
10. confidentiality/conflicts/abuse, severe-load, dependency/region recovery, rollout/rollback and wind-down pass adversarial exercises;
11. all eight M12 requirements below pass integrated proof against predecessor contracts.

A completed spec, single principal quote/settle path, policy door, P2P escrow, generic multi-leg schema or green tracker row is not a complete institutional RFQ/block/allocation venue.

### 18.1 Requirement proof map

| Requirement   | Contract closure                                                                                                          | Required implementation evidence                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PTX-M12-R01` | §§4–8 define principal/matched-principal/agency legal counterparty, capacity, routing, markup and conflict truth          | Owner/legal constitution plus inventory, route, credit, disclosure and no-fallback conformance   |
| `PTX-M12-R02` | §§6–7 define exact leg/direction/ratio/amount/price/expiry/settlement/maker/firmness and no-last-look lifecycle           | Quote version/withdraw/accept/expiry/partial/race/replay and exact settlement proof              |
| `PTX-M12-R03` | §§6–7 define maker targeting, staged anonymity, hedge legs, comparable quote ranking and leakage controls                 | Entitlement/audit, multi-maker, alias, comparison, hedge and adversarial information-flow tests  |
| `PTX-M12-R04` | §10 defines pre/post allocation for accounts/funds/clients, average/execution prices, fees, partial/break/correction      | Authority, ratios/totals, concurrent version, booking, ledger/report and break reconciliation    |
| `PTX-M12-R05` | §9 defines block thresholds, price/time, book interaction, reporting, surveillance and wash/aggregation controls          | Owner/legal rule engine, timely private/public report, late/corrected and abuse evidence         |
| `PTX-M12-R06` | §12 defines DvP/escrow/custody, confirmation, net/gross, finality, fails/disputes, exact postings and counterparty limits | Integrated credit/custody/rail, partial-post recovery, reconciliation/default and exit exercises |
| `PTX-M12-R07` | §13 binds voice/chat/manual flow to ordinary authority, risk, fee, compliance, execution, ledger, correction and audit    | Recorded-consent/capture/approval/late/error fixtures and cross-channel/drop-copy parity         |
| `PTX-M12-R08` | §11 defines give-up, carrying accounts, average-price groups, bunched identity, affirmation/confirmation and breaks       | FIX/API group/claim/take-up/reject/warehouse/instruction/correction and party-identity proof     |

## 19. Owner and external sockets

| Socket       | Required authority/input                                                                                                                 | Refuse-closed behavior while absent                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `PX-S09-O01` | Legal entities/capacity, participant/maker/broker/client eligibility, jurisdictions, agreements and disclosures                          | Affected live RFQ/OTC/block/manual workflow refuses                          |
| `PX-S09-O02` | Products/legs/sizes, quote lifetime, firmness/partial rules, makers, targeting/anonymity, hedge and information policy                   | Request/quote disabled or explicitly indicative paper only                   |
| `PX-S09-O03` | Principal inventory/capital, matched-principal contingency, agency/maker routes, conflicts, spread/markup/fees and legal counterparty ID | Capacity remains unavailable; no fallback to generic platform/house label    |
| `PX-S09-O04` | Block eligibility/aggregation/thresholds, price/tick, execution time, book interaction, public/delayed reporting and exceptions          | Block path disabled; trade cannot claim/report block status                  |
| `PX-S09-O05` | Allocation accounts/clients/funds, authority, pre/post/partial method, average-price/rounding/fees, cutoffs/approvals/corrections        | Group allocation disabled; execution stays in authorized originating account |
| `PX-S09-O06` | Give-up/clearing/carrying parties/accounts, agreements, average-price group, claim/take-up, warehouse exposure/limits and breaks         | Give-up/bunch disabled; rejected obligation stays explicit                   |
| `PX-S09-O07` | Counterparty/credit/collateral/custody/escrow/DvP/netting/settlement assets, rails, instructions, finality, limits and default           | New exposure/settlement dispatch refuses                                     |
| `PX-S09-O08` | Voice/chat/recording/consent, capture/approval, late/error/correction, privacy/retention and supervision policy                          | Manual trade capture cannot create execution or money                        |
| `PX-S09-O09` | Capacity/SLO, retention, support, rollout/rollback/suspension/wind-down and accepted residuals                                           | No performance/completeness claim; affected feature stays unavailable        |
| `PX-S09-X01` | Authenticated makers/brokers/clients/carrying/clearing firms, credit/custody/settlement contracts and exit evidence                      | Counterparty/route/allocation/give-up/settlement ineligible                  |
| `PX-S09-X02` | Reference/venue prices and clocks, data licenses, corrections, quote/route availability and outage evidence                              | Quote/comparison/block-price validation unavailable                          |
| `PX-S09-X03` | Trade repository/public report, confirmation/affirmation, allocation/give-up/clearing and settlement interfaces/certification            | Affected live workflow/reporting disabled                                    |
| `PX-S09-X04` | Applicable legal/regulatory block, consent, record, communications, surveillance, reporting, netting and client-asset requirements       | Affected entity/product/jurisdiction remains ineligible                      |

## 20. Cross-spec dependencies and contradiction register

- **PX-S01:** owns rules, market state, block/error-trade/reporting/surveillance authority, disputes and corrections. PX-S09 supplies workflow objects.
- **PX-S02:** owns legal owner, broker/DMA/client/sub-account grants, approvals, revocation and manual authority. Allocation cannot transfer authority.
- **PX-S03:** owns order/multi-leg/matching/fill/finality/correction. PX-S09 owns private negotiation, block and allocation specialization.
- **PX-S04/PX-S05:** own protocol/recovery/drop-copy and terminal/OMS/TCA. RFQ UI or message formats cannot become economic SoRs.
- **PX-S06:** owns risk, institutional credit, counterparty/default boundaries. A firm quote never bypasses current risk/credit.
- **PX-S07/PX-S08:** own product, fixing, option combo/MMP and settlement inputs. PX-S09 cannot make unlike products comparable by grouping them.
- **PX-S10:** owns liquidity/maker/fee/incentive/affiliate constitution. PX-S09 exposes capacity/conflicts without inventing maker economics.
- **PX-S11/PX-S12/PX-S13:** own reports/service, custody/reconciliation/wind-down and resilience/incident law.

Resolved contradictions and explicit gaps:

1. `trade.otc` is delivered for a single-leg platform-principal RFQ/settlement slice. Its tracker/mount “backend product-complete” claim is bounded by two named gaps and does not prove matched-principal/agency, multi-maker/multi-leg, blocks, allocations, give-up, credit or manual workflows.
2. Existing quote math and last-look refusal are strong. The current desk-law parser nevertheless defaults `quoteTtlMs` when a published law omits it despite comments calling TTL owner-set. Production contracts must require an explicit owner value; the code default is bounded implementation behavior, not canonical policy.
3. Platform-principal quotes default the display ID `platform:otc-desk`. This is not a selected legal entity or counterparty capacity. A live constitution must supply the legal counterparty identity; no UI/code label closes that socket.
4. Existing principal settlement uses exact recipes and stable IDs but posts house hold, taker hold and fill separately. Idempotency prevents duplicate economics; it does not make partial success atomic. Durable recovery/release and reconciliation are required before the slice is professionally complete.
5. Maker mode can collect a caller-supplied maker ID but settlement refuses. That is correct: identity text is not authenticated routing, capacity, credit, custody or ledger authority.
6. The existing stake tier is an access gate. It does not establish institutional identity, client mandate, sophistication, block eligibility, credit or settlement readiness.
7. P2P escrow has real human-dispute and ledger recipes. It is a distinct bilateral retail/custodial workflow, not automatic proof of institutional DvP, legal netting or RFQ counterparty settlement.
8. PX-S05 care-order allocations/manual fills and generic broker/account schemas are predecessor contracts, not implemented institutional allocation/give-up books.
9. Public parent block reporting and private account/leg allocations must coexist: public anonymity cannot erase the internal beneficial-owner/execution chain, and a child trade ID cannot replace parent package truth.
