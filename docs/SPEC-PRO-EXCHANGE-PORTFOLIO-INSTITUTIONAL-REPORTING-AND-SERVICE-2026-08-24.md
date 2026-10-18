# INTAFACED Portfolio Analytics, Institutional Reporting, Onboarding, and Service Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S11`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M14-R01–R07`, `PTX-M20-R01–R07`

**Predecessors:** `PX-S01` rule/evidence authority, `PX-S02` organization/account/security authority, `PX-S03` order/execution facts, `PX-S04` connectivity/data delivery, `PX-S05` terminal/OMS/TCA, `PX-S06` risk, `PX-S12` custody/reconciliation/wind-down, `PX-S13` resilience/service truth

**Systems of record:** each order, fill, position, risk, transfer, custody, identity, support, and rule domain retains its existing SoR; `packages/ledger-client` plus `svc-ledger` remain the only money book; this contract owns reconciled portfolio presentation, derived performance, evidentiary reports, institutional onboarding-case orchestration, service operations, and controlled offboarding semantics

---

## 1. Product promise, professional jobs, and boundary

Portfolio managers, traders, fund administrators, finance/controllers, operations, risk, compliance, auditors, regulators, legal/procurement/security reviewers, technical integration teams, authorized signatories, and service staff can explain current exposure and historical economics from common authoritative facts; qualify and activate an organization without hidden gates; operate against measurable service commitments; make controlled account changes; and exit without stranded risk, assets, evidence, or cases.

This determines primary-venue adoption because an institution must reconcile the venue into its own books, NAV, risk, audit, client reporting, counterparty oversight, and continuity program. A trading surface without reproducible statements, controlled onboarding, credible diligence evidence, and accountable service cannot become primary infrastructure.

Catastrophic or dishonest outcomes include a portfolio view silently treating an unavailable source as zero; PnL disagreeing with ledger/fills/statements; a report changing when regenerated; cross-client aggregation leaking authority; a tax or legal conclusion being invented; KYC approval being presented as complete KYB/credit/legal onboarding; an undocumented account change widening authority; an SLA implied by a queue score; or offboarding closing access before orders, liabilities, assets, records and disputes are resolved.

M14 and M20 remain one bounded contract. Institutional onboarding must prove which portfolio, reporting, custody, risk and service products the entity can actually consume, and service/offboarding must preserve the same evidence. Splitting them would create a legal/service case detached from operational truth or reporting without accountable delivery and correction.

Non-goals:

- no second ledger, balance, position, order, custody, risk, identity, compliance, CRM or ticket book is created;
- this contract does not choose legal entities, jurisdictions, accounting/tax standards, custody models, counterparties, service tiers, support hours, SLOs, file formats, delivery networks, retention periods, audit claims, insurance, fees, credit or commercial terms;
- no report, dashboard, tracker row, KYC tier or support ticket independently proves solvency, regulatory compliance, tax treatment, best execution, product eligibility or contractual acceptance;
- no product code, new SPA, live policy value or external-provider commitment is authorized here.

## 2. Research delta and durable patterns

Current official sources materially add these durable requirements:

- [Coinbase business onboarding](https://docs.cdp.coinbase.com/api-reference/v2/business-onboarding) separates entity creation from verified business approval and from explicit linking of custodial accounts before protected APIs become available. It reinforces a staged capability grant tied to incorporation, beneficial-owner and address evidence rather than a generic “institutional” flag.
- [Coinbase Prime portfolio activities](https://docs.cdp.coinbase.com/api-reference/prime-api/rest-api/activities/list-activities) uses stable activity/reference IDs, creator/action history, category/status, hierarchy, time filters and cursor pagination across order, transaction, account, allocation and lending activity. It reinforces common causal lineage rather than report-only identifiers.
- [Coinbase Exchange report generation](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/reports/create-report) treats reports as asynchronous jobs with type, scope, period, status, human/machine formats and expiring delivery artifacts; point-in-time balance snapshots remain distinct from interval account/fill reports.
- [Coinbase Prime auditor access](https://help.coinbase.com/en/prime/audits) reinforces scoped auditor roles/read-only API access and customer-authorized direct support rather than sending uncontrolled copies or granting trading authority.
- [Coinbase Prime consensus settings](https://help.coinbase.com/en/prime/securing-your-account/security-settings) reinforces explicit entity/portfolio approval policy for high-consequence account and transaction activity; vendor defaults are not adopted as INTAFACED policy.
- [CME Customer Center service guidance](https://www.cmegroup.com/content/dam/cmegroup/education/files/cme-customer-center-services-guide.pdf) separates global account management, entity/due-diligence/contracting, access/entitlements, connectivity certification and technical support into accountable operating functions.
- [SEC electronic-recordkeeping guidance](https://www.sec.gov/investment/amendments-electronic-recordkeeping-requirements-broker-dealers) reinforces recreating an original record plus its complete time-stamped modification/deletion/actor trail and producing records in a reasonably usable electronic form. It is a durable evidence pattern, not a finding that the cited rule applies to INTAFACED.

These sources shape product evidence and failure semantics. They do not establish legal applicability, accounting policy, required forms, retention, or commercial commitments.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BUILT`     | The ledger supplies exact balances, bounded history, postings, hash/reconciliation foundations and a mounted S2S portfolio door. `portfolio-view` renders ledger holdings as decimal strings and names an unwired chain/indexer half rather than fabricating zero. Individual KYC submit/review/status, encrypted document storage and operator attribution exist. |
| `PARTIAL`   | Spot/futures balance, position, realized/unrealized PnL, funding, fee and execution projections exist across several SoRs. `svc-support` has durable tickets, comments, lifecycle, exclusive claims, KB, audit events, grounded case files and escalation. It deliberately exposes queue score as no SLA and has no money authority.                               |
| `SPECIFIED` | PX-S01/PX-S02/PX-S03/PX-S05/PX-S06/PX-S12/PX-S13 bind rule, actor, order, TCA, risk, money/custody, correction, resilience and wind-down facts consumed here.                                                                                                                                                                                                      |
| `SOCKET`    | Accounting/tax/valuation policy, base/reporting currencies, NAV mapping, statement/legal form, retention, entity/KYB/credit/legal gates, service tiers, coverage/SLO/compensation, approvers and delivery policy require owner/legal authority.                                                                                                                    |
| `EXTERNAL`  | Verification providers, banks/custodians/venues, tax/legal/accounting advisers, auditors, insurers, benchmark/FX/reference data, SFTP/API/email providers, client fund administrators and regulatory channels require external evidence.                                                                                                                           |
| `ABSENT`    | No unified institutional onboarding case, contract/diligence package, product-entitlement activation plan, professional performance/attribution engine, immutable statement/NAV/regulator export service, named coverage/TAM/service-review product, institutional change workflow or complete offboarding orchestration was found.                                |

The `ops.portfolio` and `ops.support` tracker rows are truthful for their bounded delivered slices. The portfolio mount explicitly leaves the indexer and house halves incomplete. The support mount explicitly leaves live-compose observation, the desk UI and SLA wording unresolved. Neither row makes M14 or M20 complete.

Individual `institutional` KYC tier is not a legal-entity KYB case: the current record is keyed to a user, contains a jurisdiction/tier/status/provider pointer, and grants custodial access through a human operator decision. It does not model incorporation, UBO/control graph, authorized signatories, mandates, tax, credit, agreements, institutional accounts, service or periodic review.

## 4. Canonical objects, identifiers, versions, and clocks

Canonical objects include `PortfolioSnapshot`, `ValuationSet`, `PositionView`, `PerformanceSeries`, `PnLAttribution`, `AccountingMapping`, `ReportDefinition`, `ReportRun`, `Statement`, `Confirmation`, `Invoice`, `TaxLotView`, `Delivery`, `Correction`, `InstitutionCase`, `EntityProfile`, `ControlPerson`, `EvidenceItem`, `Agreement`, `EligibilityDecision`, `EntitlementPlan`, `ImplementationPlan`, `ServicePlan`, `CoverageAssignment`, `ServiceReview`, `ChangeCase`, `OffboardingCase`, and `DiligencePackage`.

Stable IDs include legal entity/organization, person/control role, account/sub-account/portfolio, mandate/agreement/evidence/decision, product/venue/instrument/currency, valuation/price/FX/model/rule version, order/client-order/execution/fill/allocation, ledger transaction/entry/account, position/risk/collateral, transfer/custody/settlement, report definition/run/artifact/delivery, statement/correction, onboarding/change/offboarding case, task/approval, support ticket/escalation/incident and external reference.

Timestamps distinguish source economic event, effective/as-of, valuation, ingestion, reconciliation watermark, report requested/generated/available/delivered/downloaded/expired, evidence issued/received/verified/expires, decision proposed/approved/effective/revoked, case opened/updated/completed/reopened, and service response/action/closure. Every timestamp records source, timezone rendering and clock quality where material.

Definitions, mappings, valuation/accounting methodologies, templates, schemas, agreements, evidence, decisions and reports are immutable versions with effective intervals. A later correction or reclassification creates a linked version; it never overwrites the original delivered fact.

## 5. Legal entity, organization, account, and trust boundaries

PX-S02 owns organization, account/sub-account, actor, grant and delegation. PX-S11 binds an `InstitutionCase` to the intended legal entity, control/ownership graph, authorized signatories, brokers/advisers, requested products, accounts, custody/settlement model and external counterparties. A user KYC tier cannot substitute for any of them.

Every portfolio/report/delivery resolves legal owner, organization, account/sub-account, beneficial-owner visibility, acting principal, purpose, entitlement and effective policy server-side. Read aggregation never grants write authority. Cross-account or cross-entity aggregation is permitted only by an explicit read grant and preserves each source boundary; drills and exports filter at the same authority layer.

Third-party auditor, administrator, adviser, broker and regulator access uses named roles, least privilege, time/portfolio/report scope, strong authentication, download audit and revocation. A shared file link, email address or support relationship is not authority. Client-confidential data is never used in peer benchmarks, diligence responses or service reviews without an approved basis.

## 6. Portfolio snapshot and reconciliation contract

A `PortfolioSnapshot` is an as-of view over named SoRs, not a mutable balance store. It includes source watermarks, asset/instrument/reference versions, exact quantities, holds/encumbrances, liabilities/receivables, settled/unsettled/unknown status, valuation/FX source and age, reconciliation state, missing sources and corrections.

Required measures include ledger balances by account kind/purpose; equity; available/buying/withdrawal power as distinct owner-defined measures; IM/MM and other PX-S06 requirements; collateral value/haircuts; borrow principal/accrued interest; funding accrued/settled; fees/rebates; transfers and settlement receivables/payables. Each measure names its authority and formula version. Unknown, stale, disputed, unpriced and unavailable are not zero.

Snapshot state is `ASSEMBLING → RECONCILING → COMPLETE | PARTIAL | FAILED`, with `CORRECTED` as a linked successor. `COMPLETE` requires every mandatory source at or beyond the declared watermark and balanced ledger reconciliation. Optional absent sources remain explicitly absent and can still produce `PARTIAL`; a timeout cannot be relabeled complete.

The current portfolio-view custodial half is a valid building block. Its `indexer.portfolio_positions_unwired` state remains a named gap until address ownership, source sequence/finality, valuation and reconciliation are wired. No house/customer or custodial/on-chain aggregation may collapse legal owners.

## 7. Position, exposure, PnL, and performance semantics

Position views preserve product-specific quantity, direction, cost/entry basis, mark/index, realized/unrealized state, settlement, Greeks and risk-model versions. They aggregate by instrument, strategy, sub-account, account, organization, underlying, currency, venue and counterparty only from common IDs. Aggregation is read-only and reports eliminations, netting eligibility and non-comparable units.

PnL separates trading realization, mark movement, funding, fees, rebates, borrow interest, settlement, liquidation/default, transfer, corporate action and FX translation. It distinguishes economic PnL from cash movement, realized from unrealized, gross from net, local from reporting currency, exchange from external venue, and original from corrected. Components reconcile to order/fill/position and ledger facts; an unexplained residual remains named.

Performance analytics include time series of equity/NAV-ready values, drawdown, returns, exposure, concentration, Greeks, basis and approved benchmark comparison. Each declares inception/period, cash-flow treatment, return methodology, valuation calendar/cutoff, reporting currency, FX/price source, fees/tax treatment, benchmark, missing data and confidence. No annualization, benchmark, tax or accounting convention is assumed.

Attribution decomposes only supported factors and preserves residual/unattributed amounts. Correlation is not causality; strategy/trader/client comparisons require sufficient sample and privacy policy. TCA remains PX-S05; portfolio performance may link its results but cannot recompute or reinterpret them silently.

## 8. Exact-money, valuation, correction, and reconciliation law

Decimal strings cross every boundary; scaled bigint or another approved exact representation is used in memory. Money never enters a JavaScript `number`. Display rounding is presentation-only and reports scale/rounding policy. Totals are derived from exact components; rounded rows are not summed into a new authority.

No report or analytics service posts, holds, settles, reverses or corrects money. Every value change uses an existing balanced `ledger-client` recipe in the owning service with the original economic idempotency root. Positions reconcile to orders/fills and ledger settlements; custody/external assets reconcile under PX-S12.

Valuations identify source, price type, timestamp, market state, FX path, adjustments, stale/outlier handling and methodology version. Absent owner-approved price/FX/fixing policy yields unvalued components and a partial report, not a guessed rate.

Corrections are append-only: detect, case, source correction, balanced money/position treatment, recompute, compare, approve, issue replacement, deliver, and link superseded artifacts. The original remains retrievable with its exact inputs and delivery history. A correction does not backdate authority or erase client reliance.

## 9. Reporting product constitution

A `ReportDefinition` specifies type, owner, permitted population, sources, as-of/period/cutoff, timezone/calendar, accounting/valuation/mapping versions, grouping, columns, exact units/precision, output formats, delivery, retention, approvals and correction policy.

The report catalog covers, where owner/legal-authorized:

- balance/equity/position and activity statements;
- trade and execution confirmations with PX-S03/PX-S05 causal IDs;
- fees/rebates, funding, interest/borrow, liquidation and settlement reports;
- invoices and commercial adjustments under PX-S10;
- tax-lot and cost-basis views labeled by approved jurisdiction/method, never tax advice;
- custody, transfer and reconciliation statements under PX-S12;
- performance, attribution, risk and TCA-linked reports;
- audit, regulator, client and internal-control exports.

A `ReportRun` state is `REQUESTED → AUTHORIZED → QUEUED → ASSEMBLING → RECONCILING → READY | PARTIAL | FAILED`, then `DELIVERED`, `EXPIRED` or `SUPERSEDED`. Cancellation stops unfinished work but does not delete evidence. Idempotent requests reuse the same run/economic scope; retries do not create conflicting statements.

Every artifact carries stable ID, definition/method/schema/template/software versions, scope, as-of/period, source watermarks and digests, generation time, completeness/correction state, precision, page/row counts, checksum and human-readable limitations. PDF and machine-readable results are generated from one canonical dataset and reconcile exactly.

## 10. NAV, accounting mappings, and scheduled delivery

NAV-ready data supplies exact holdings, cash/encumbrances, receivables/payables, positions, realized/unrealized components, fees/funding/interest, transfers/custody activity, prices/FX, timestamps, legal owner/account dimensions, source IDs and reconciliation state. It does not declare an official fund NAV; the authorized administrator/accounting authority does.

Accounting mappings translate canonical events/accounts/assets/products into owner-approved chart-of-account, book, legal entity, strategy, cost-center and external-system codes. Mappings are effective-dated, reviewed and never alter ledger purposes. Unmapped or ambiguous records enter an exception queue and block “complete” delivery.

Scheduled delivery uses explicit recipient/endpoint entitlement, format/schema/version, calendar/cutoff, encryption/signing, key rotation, retry, acknowledgement, duplicate detection, checksum, expiration and revocation. SFTP, API, object delivery, portal download and notification are adapters, not new report authorities. Email may notify but does not carry sensitive artifacts unless policy explicitly permits it.

Delivery states distinguish `PENDING`, `SENT`, `ACKNOWLEDGED`, `FAILED`, `UNKNOWN`, `REVOKED` and `EXPIRED`. A successful upload is not recipient ingestion. Replays preserve the report ID and delivery attempt IDs; a corrected artifact uses a new report/correction version and cannot be confused with the original.

## 11. Audit and regulator reconstruction

An authorized reconstruction joins user/service principal, session/device/key, organization/legal owner, account/sub-account, order/client-order, route/venue, execution/fill/allocation, fee/rebate, position/risk, ledger transaction/entry, transfer/custody/settlement, rule/model/schema and operator/correction records through common causal IDs and source times.

Exports preserve original records and every change/deletion/correction event, actor/authority, time, reason, signatures/digests and effective versions. The system can recreate the artifact as originally delivered and separately generate a corrected current view. Human and machine formats are reasonably usable, documented, paginated/manifested and independently verifiable.

Applicability, retention, legal hold, production deadline, regulator format and designated record authority are owner/legal sockets. An unconfigured regulator adapter or expired artifact remains unavailable and regenerable from retained canonical evidence where policy permits; it never results in a fake submission/delivery claim.

## 12. Institutional onboarding case and evidence state machine

One `InstitutionCase` orchestrates but does not replace identity, compliance, legal, risk, credit, custody, tax, security, commercial and product SoRs. It contains requested entity/accounts/products, owners/controllers/signatories, mandates, jurisdictions/tax classifications, counterparties/custody/settlement, evidence checklist, decisions, agreements, entitlements, implementation tasks, exceptions, periodic-review/expiry and audit history.

Case state is:

`DRAFT → SUBMITTED → EVIDENCE_REQUIRED → UNDER_REVIEW → DECISION_PENDING → CONDITIONALLY_APPROVED | APPROVED | REJECTED | WITHDRAWN | EXPIRED`

Activation is separate:

`NOT_ENTITLED → IMPLEMENTING → CERTIFYING → CUTOVER_PENDING → ACTIVE | SUSPENDED | ROLLBACK_REQUIRED | CLOSED`

No reviewer, provider webhook or commercial agreement can jump directly to `ACTIVE`. Every requested product/account has its own resolved legal entity, jurisdiction, user/person eligibility, counterparty capacity, risk/credit, custody/settlement, agreement, fee/data entitlement, technical certification and operational-readiness decision. Partial approval activates only the enumerated subset.

Evidence items state issuer/source, subject, type, version, issue/receipt/verification/expiry, reviewer, confidence and privacy classification. Missing, expired, contradictory or unverifiable evidence creates a typed requirement/refusal. Rejection and withdrawal preserve the audit record subject to lawful retention/erasure decisions.

## 13. KYB, UBO, mandate, tax, suitability, credit, and eligibility

The entity profile distinguishes legal name/identifier, formation and operating jurisdictions, registered/operating addresses, business activity, regulatory/licensing representations, ownership/control graph, UBOs/controllers, directors/officers, authorized signatories, brokers/advisers, source/purpose of funds and expected activity. Required content and thresholds are owner/legal decisions; none are prefilled here.

Natural-person identity/KYC records link to roles in the entity case but remain in the encrypted identity boundary. Institutional review records status/digests/pointers, not replicated PII documents. Sanctions/PEP/adverse-media/tax/suitability/accreditation decisions require approved data, policy and reviewer authority; absent lists or rules refuse and remain explicit.

Mandates enumerate who may open/close accounts, grant roles, trade products, borrow/use margin, move assets, approve settlements, receive reports and change service details. Credit/counterparty decisions specify approved facility/product, limit socket, collateral/guarantee, expiry, review and suspension; no limit is inferred from KYC or sales status.

Eligibility is continuously reevaluated on evidence expiry, control/ownership change, jurisdiction/rule change, sanctions/compliance signal, credit deterioration, agreement change, product lifecycle and incident. The smallest affected scope suspends new risk while preserving governed cancel, reduce, repay, settle, withdraw/return, evidence and dispute paths where authoritative.

## 14. Agreements, disclosures, and diligence package

The agreement register covers the enabled relationship only: platform/trading, custody, margin/credit, market/data licensing, API/FIX/certification, RFQ/block/OTC, broker/agency, off-exchange settlement, fees/service, privacy/data processing, security, dispute venue and any product schedule. Each records parties/entity/capacity, version, effective/expiry/termination, signatories/authority, products/accounts, governing-law/dispute sockets, amendments and delivery/acceptance evidence.

Missing or unsigned required agreement prevents that capability from activation; it does not block unrelated approved products. Click-through acceptance is not used where authorized-signatory or negotiated agreement proof is required. A changed term follows PX-S01 notice/effective-version law and cannot be made retroactive.

The diligence package is a versioned, recipient-scoped evidence manifest, not a marketing folder. It may include authorized corporate/legal, regulatory, financial, solvency/attestation, custody/segregation, insurance, security/privacy, penetration/SOC or other audit, risk/model, market integrity, BCP/DR, operational-control, incident/status, data/subprocessor and exit evidence. Every claim cites issuer, date/scope, effective/expiry, confidentiality, limitations and verification.

Unavailable or unauthorized evidence is labeled; a questionnaire cannot turn an absent audit, insurance, legal entity, SLO or control into truth. Confidential room access is time-limited, watermarked/audited where policy permits, revocable and non-transferable.

## 15. Connectivity implementation and production cutover

PX-S04 owns protocol certification. PX-S11 owns the institution-specific implementation plan: organization/accounts, environments, contacts/escalation, credential/entitlement grants, IP/network policy, rate/capacity allocation, FIX/REST/WebSocket/drop-copy/data sessions, report delivery, custody/settlement rails, test cases, outstanding exceptions, production date, monitoring and rollback.

Test and production credentials, endpoints, accounts and data are distinct. Certification proves only the tested version/scenarios; any unresolved limit, product or schema remains disabled. Cutover requires dual acknowledgement of exact scope, current rules/agreements, time/clock, open test intent cleanup, production controls, first-live monitoring and abort conditions.

Rollback revokes or disables only the new production capability, reconciles unknown commands/deliveries and preserves evidence. It cannot erase accepted orders, postings, transfers or reports. Re-cutover is a new approved implementation version.

## 16. Service plan, support, escalation, and reviews

A `ServicePlan` declares organization/accounts/products, support channels, coverage roles, authentication, operating hours/holidays, language, severity definitions, response/update/resolution SLO sockets, exclusions, escalation chain, incident linkage, maintenance/change notices, service-review cadence, data/report delivery commitments and any compensation authority.

Missing owner-approved values mean no SLA promise. The existing support queue score remains prioritization only. A ticket age, category weight, automated response or health metric cannot be rendered as response-by, resolution or compensation commitment.

Named coverage and technical account management are roles with current assignment, backup, authorization and handoff—not personal inboxes or trading authority. Support can read only ticket-scoped account grounding and cite evidence. It never moves money, changes balances, approves KYC/credit, places trades, changes limits or resolves disputes outside the owning authority.

Ticket states reuse the existing `open/pending/resolved/closed` lifecycle, user-reply reopen and terminal close semantics. Institutional overlays add service plan, organization, severity, affected products/accounts, incident/change/report IDs, delivery commitments and stakeholder visibility without duplicating the ticket. Escalation case files preserve source digests and explicitly unread dependencies.

Service reviews use measured incidents, SLOs where approved, capacity, tickets, report delivery, certification/change, risk/credit/custody/settlement exceptions and open actions. They distinguish observation from commitment and do not expose other clients or invent peer benchmarks.

## 17. Authenticated account and commercial change control

A `ChangeCase` covers organization/legal/control/UBO/signatory, account/sub-account, mandate/role/key, product/limit/credit/risk, fee/data/service tier, custody/settlement/bank/address, report recipient/endpoint, tax/accounting mapping and closure changes.

State is `REQUESTED → IDENTITY_VERIFIED → IMPACT_ASSESSED → APPROVAL_REQUIRED → APPROVED → SCHEDULED → APPLIED → VERIFIED → CLOSED`, with `REJECTED`, `EXPIRED`, `PARTIAL`, `UNKNOWN`, `ROLLBACK_REQUIRED` and `CORRECTION_REQUIRED`. High-consequence fields require independent approval under owner policy. Support or sales cannot self-approve because they opened the case.

The case records old/new exact values or protected digests, reason, authority, affected accounts/products/open risk/deliveries, prerequisites, effective time, notifications, idempotency, target-level results, rollback and reconciliation. Client requests are authenticated out of band only by an approved method; email/chat alone never authorizes a change.

Fee/limit/service changes remain owner-set and effective-dated. Nothing here moves money; resulting fees, adjustments or reversals use PX-S10 and the ledger authority. Partial or unknown application constrains affected new risk until all SoRs reconcile.

## 18. Offboarding and exit state machine

Offboarding can be client-requested, agreement expiry/termination, ineligibility, risk/compliance, product/venue wind-down, provider failure or incident. Authority and notice are recorded; the reason does not permit confiscation, record deletion or silent cancellation.

State is:

`REQUESTED → AUTHORITY_VERIFIED → PLAN_APPROVED → NEW_RISK_STOPPED → ORDERS_RESOLVING → POSITIONS_RESOLVING → LIABILITIES_SETTLING → ASSETS_RETURNING → REPORTS_DELIVERING → ACCESS_REVOKING → RETENTION_HOLD → CLOSED`

Each stage can be `PARTIAL`, `BLOCKED_EXTERNAL`, `DISPUTED`, `CORRECTION_REQUIRED` or `UNKNOWN`. Closure requires every account/product/counterparty to be terminal or explicitly case-bound; open orders/algos/RFQs/care ownership, positions/liquidations, borrow/funding/fees, transfers/custody/settlement, collateral/receivables, ledger breaks, statements/tax/NAV reports, support/disputes, keys/sessions, data exports and legal holds are reconciled.

New risk stops before closure while governed cancel, reduce, repay, settlement, asset return, evidence and dispute access remain where authoritative. Credential revocation is sequenced so the client does not lose the only safe exit or records channel prematurely. Residual dust, unsupported assets, frozen claims, chain/bank/custodian failure and disputed ownership remain visible with owner/external resolution paths.

Final evidence includes closure authority, asset/liability/account zero-or-residual proof, report/export manifest, recipient acknowledgements, credential/endpoint revocation, retained/legal-held records, deletion decisions, unresolved cases and post-close contact. Reopening requires a new case; historical closure is immutable.

## 19. Concurrency, replay, stale state, partial success, and recovery

Every snapshot/report/case/task/change/delivery command carries schema/version, optimistic version, idempotency key and actor authority. Concurrent reviewers cannot approve incompatible states; the losing action receives conflict/current truth. Batch operations return per-target results and never infer total success.

Event consumers persist source sequence/watermark and deduplicate by original causal/economic ID. Replay uses effective historical rules, mappings and methodologies and produces the same artifact digest or a documented non-determinism/correction case. A recovered projection cannot call itself current until it catches up and reconciles with each SoR.

Customer-visible states distinguish `CURRENT`, `STALE`, `PARTIAL`, `UNRECONCILED`, `CORRECTED`, `UNAVAILABLE` and `UNKNOWN`, with last-good time, missing source, safe actions and incident/case link. Empty reports, queues or portfolios are only “empty” after authoritative completion; otherwise they are unavailable/partial.

## 20. Security, privacy, market integrity, and retention

Institutional data is tenant/legal-owner isolated, encrypted in transit/at rest, least-privilege, purpose-bound and audited. PII documents remain in the encrypted identity vault or approved external provider; reports/cases hold pointers, classifications and digests. Secrets, bank/custody details and sensitive documents never enter logs, support comments or general analytics.

Downloads, exports, SFTP/API keys, report recipients, diligence rooms and auditor access use strong authentication, step-up/dual control where approved, time/scope bounds, malware/content controls, rate/size limits, checksums, access logs and revocation. CSV/spreadsheet output prevents formula injection. Signed URLs expire and cannot substitute for entitlement at generation.

Surveillance and conflict controls cover operator/report corrections, fee/limit changes, affiliate/house/client visibility, selective disclosure, backdated mappings and use of non-public portfolio information. Institutional service status cannot create execution or information advantage outside transparent policy.

Retention, legal hold, erasure, localization/residency, regulator/auditor access and breach notice are owner/legal sockets by object and jurisdiction. An erasure request cannot destroy required ledger/order/evidence integrity; a retention claim cannot be made without configured policy and proof.

## 21. Capacity, SLO, degraded behavior, and incidents

PX-S13 owns magnitudes. Capacity dimensions include organizations/control graphs/accounts, positions/assets/history rows, concurrent snapshots, valuation sources, report periods/rows/bytes, scheduled bursts/cutoffs, deliveries/retries, onboarding evidence/tasks/reviews, support tickets/comments/case files, diligence downloads and offboarding cases.

Load evidence covers month/quarter/year-end and tax/reporting peaks, severe markets plus valuation/reconciliation bursts, large portfolios, mass corrections/regeneration, provider/SFTP/API outage, auditor/regulator export, identity/compliance degradation, support/incident spikes and client-wide offboarding. Optional analytics and duplicate exports shed before authoritative portfolio, correction, safe exit, incident and evidence paths.

Degraded reports name missing sources and cannot be delivered as final unless the definition explicitly permits `PARTIAL` and recipients see it. A failed provider or channel cannot silently switch jurisdiction, recipient, price, FX, evidence or delivery finality. Incidents follow PX-S13; resolution requires report/case/delivery reconciliation and correction, not merely service restart.

## 22. Migration, compatibility, suspension, rollback, and decommissioning

Implementation reuses ledger history/portfolio view, order/risk/custody SoRs, identity KYC/document controls, support tickets/case files, PX-S04 delivery and the existing shell. Build canonical read models and manifests before presentation; do not scrape screens or duplicate source records into an ungoverned warehouse.

Schemas, mappings and templates use expand/migrate/contract compatibility. Shadow portfolio/report calculations are non-authoritative, compare against current evidence and never drive postings, eligibility or client reports. Rollout is scoped by organization/account/product/report and requires exact reconciliation before promotion.

Suspension stops affected new reports, entitlements or risk while preserving authorized history, correction, asset return and support. Software rollback cannot roll back issued reports or approved cases; it restores processing for new work and reconciles accepted facts. Decommissioning exports definitions/mappings/artifacts/cases/evidence under retention policy, revokes deliveries/access, resolves queued work and preserves reproducibility through the required period.

## 23. Definition of Done

PX-S11 is implementation-complete only when evidence proves:

1. every portfolio measure and PnL component reconciles across ledger, order/fill, position/risk, transfer/custody and external SoRs with exact money and explicit missing state;
2. all required aggregation dimensions preserve legal/account boundaries, eliminate only approved relationships and cannot enable cross-leak writes;
3. performance, attribution, exposure, concentration, Greeks, basis and benchmark calculations reproduce approved methodologies and inputs;
4. every report class uses one canonical dataset, immutable versions, complete manifests, correction lineage and identical human/machine totals;
5. NAV/accounting mappings, scheduled SFTP/API/portal delivery and recipient acknowledgements pass cutoff, retry, duplicate, correction, outage and key-rotation tests;
6. audit/regulator reconstruction joins every required common ID and can reproduce originals plus modifications in authorized usable formats;
7. institutional cases prove entity/control/UBO, mandate, jurisdiction/tax, suitability, credit/counterparty, product and evidence state without treating individual KYC as KYB;
8. agreements/diligence evidence and every activated product/account/entitlement bind correct parties, versions, approvals, limitations and expiry;
9. connectivity implementation/certification/cutover/rollback passes PX-S04 conformance for each institution-specific scope;
10. service plans, named coverage, support/TAM, incidents and service reviews measure only owner-approved commitments and preserve the no-money/no-authority support boundary;
11. every high-consequence account/limit/fee/settlement/permission/closure change passes authentication, dual control, version, partial/unknown, rollback and reconciliation tests;
12. offboarding exercises close or case-bind all orders, positions, liabilities, assets, reports, access, support/disputes and retention/legal holds without stranding safe exit;
13. security, privacy, surveillance, external-provider failure, capacity, recovery, migration, suspension and decommissioning pass adversarial review;
14. all 14 requirements below pass integrated proof against PX-S01/PX-S02/PX-S03/PX-S04/PX-S05/PX-S06/PX-S12/PX-S13.

A completed specification, KYC approval, ledger view, support ticket or green tracker row is not an institutional reporting and service product.

### 23.1 Requirement proof map

| Requirement   | Contract closure                                                                                    | Required implementation evidence                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PTX-M14-R01` | §§6 and 8 define reconciled balances/equity/power/margin/liabilities/accruals/collateral/holds      | Cross-SoR snapshot, exact-money, stale/missing/correction and reconciliation evidence           |
| `PTX-M14-R02` | §§7–8 define separated realized/unrealized trading/funding/fee/interest/settlement/transfer/FX PnL  | Component-to-ledger/fill/position fixtures with residual and correction proof                   |
| `PTX-M14-R03` | §§5–7 define read-only position aggregation across all required dimensions and trust boundaries     | Tenant/legal-owner isolation, unit/netting and cross-leak adversarial tests                     |
| `PTX-M14-R04` | §7 defines equity/drawdown/return/attribution/exposure/concentration/Greek/basis/benchmark law      | Versioned methodology/input reproduction, missing-data and non-causality tests                  |
| `PTX-M14-R05` | §§9 and 11 define immutable reproducible statements/confirmations/invoices/fees/tax/exports         | Canonical dataset, original/correction replay, manifest, format parity and access evidence      |
| `PTX-M14-R06` | §10 defines NAV-ready facts, accounting mappings, schedules, SFTP/API and correction delivery       | Fund-admin fixtures, mapping exceptions, cutoff/retry/ack/key-rotation/corrected-delivery tests |
| `PTX-M14-R07` | §11 defines common-ID user/session/order/fill/fee/ledger/position/transfer/custody reconstruction   | Complete historical replay, modification trail and usable authorized export evidence            |
| `PTX-M20-R01` | §§12–13 define one traceable entity/control/UBO/mandate/jurisdiction/tax/suitability/credit case    | Case state, evidence expiry, partial eligibility, periodic review and privacy tests             |
| `PTX-M20-R02` | §14 defines party/capacity/version/signatory/product-scoped agreement register and activation gate  | Signed/effective/amended/expired/terminated agreement and entitlement conformance               |
| `PTX-M20-R03` | §14 defines versioned recipient-scoped corporate/security/financial/custody/BCP/risk evidence       | Evidence manifests, scope/expiry/limitation/access audit and unavailable-claim refusal          |
| `PTX-M20-R04` | §16 defines named coverage, support/TAM, incident escalation, measured commitments and reviews      | Service-plan/SLO authority, handoff, incident/ticket/delivery metrics and no-promise tests      |
| `PTX-M20-R05` | §15 defines institution-specific credentials/certification/cutover/limits/contacts/monitor/rollback | PX-S04 certification plus production cutover, unknown-intent cleanup and rollback exercises     |
| `PTX-M20-R06` | §17 defines authenticated dual-controlled account/limit/fee/settlement/permission/closure change    | Concurrent approvals, effective versions, per-target partial/unknown, reconciliation and audit  |
| `PTX-M20-R07` | §18 defines complete order/position/liability/report/key/data/asset/case/legal-hold offboarding     | End-to-end client/provider/failure exit exercises with zero-or-explicit-residual closure proof  |

## 24. Owner and external sockets

| Socket       | Required authority/input                                                                                                         | Refuse-closed behavior while absent                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PX-S11-O01` | Reporting/base currencies, valuation/FX/price, accounting/NAV, return, attribution, benchmark, tax-lot and cost-basis policy     | Native exact facts only; dependent valuations/analytics/reports remain partial |
| `PX-S11-O02` | Report/statement/confirmation/invoice/tax/regulator forms, legal language, cutoff/calendar, approval and correction policy       | No official/final/legal/tax/regulatory artifact claim                          |
| `PX-S11-O03` | Retention, legal hold, WORM/audit-trail choice, residency, erasure, download and auditor/regulator access policy                 | Evidence retained only under existing law; no compliance/retention claim       |
| `PX-S11-O04` | Legal entities, jurisdictions, entity/UBO/control thresholds, tax/suitability, sanctions/compliance and periodic-review rules    | Institutional case cannot approve or activate                                  |
| `PX-S11-O05` | Credit/counterparty/custody/settlement/product eligibility, facility/limit/collateral and suspension policy                      | No credit or affected product entitlement                                      |
| `PX-S11-O06` | Agreement parties/capacities, governing law/dispute, authorized signatories, required schedules/disclosures and acceptance       | Dependent capability remains not entitled                                      |
| `PX-S11-O07` | Service tiers, named coverage, hours/holidays, severity, response/update/resolution SLOs, review cadence and compensation        | Queue score only; no SLA, coverage or compensation promise                     |
| `PX-S11-O08` | Change classes, authentication/dual-control, approvers, notice/effective/rollback and emergency authority                        | High-consequence change refuses; current value remains                         |
| `PX-S11-O09` | Offboarding/termination authority, notice, sequencing, residual/dust treatment, safe access, final evidence and closure criteria | Stop new risk only under existing authority; closure cannot be declared        |
| `PX-S11-X01` | Verification/sanctions/tax/credit/legal/accounting/audit/insurance providers and reliable evidence                               | Evidence unknown/expired; no decision or claim                                 |
| `PX-S11-X02` | Banks/custodians/venues/settlement counterparties and asset/liability/finality/reconciliation evidence                           | Affected snapshot/report/offboarding stage partial or blocked external         |
| `PX-S11-X03` | Approved price/FX/benchmark/reference data and historical corrections/licensing                                                  | Dependent valuation/benchmark unavailable; native quantities remain            |
| `PX-S11-X04` | Client administrators/OEMS/accounting systems, SFTP/API/object/email channels, acknowledgements and schema agreements            | Delivery unavailable/unknown; no recipient-ingestion claim                     |
| `PX-S11-X05` | Regulator/auditor submission channels, formats, access authority and delivery evidence                                           | Export may be generated for authorized review only; no submission claim        |

## 25. Cross-spec dependencies and contradiction register

- **PX-S01:** owns rule, product/instrument state, evidence claims, disputes, surveillance and public corrections. Reports identify effective rules and cannot approve claims independently.
- **PX-S02:** owns organization/account/sub-account, principal, delegation, approval, identity/security/privacy and revocation. Institutional cases orchestrate rather than duplicate those SoRs.
- **PX-S03:** owns order/fill/execution state and correction. Reports and portfolios reference its causal facts without rewriting them.
- **PX-S04:** owns protocol/data sequence, certification, entitlement, schema/change and delivery diagnostics. PX-S11 owns client-specific implementation and report semantics.
- **PX-S05:** owns terminal/OMS/TCA, care ownership, manual-fill/allocation evidence and best-ex reconstruction. Portfolio analytics link to, but do not silently recalculate, TCA.
- **PX-S06:** owns risk/margin/collateral/position/liquidation/default truth. Portfolio displays cannot become a second risk engine.
- **PX-S10:** owns fee/incentive/commercial economics and corrections. PX-S11 reports approved facts and never invents a tier/rate/compensation.
- **PX-S12:** owns ledger/custody/settlement reconciliation, solvency/attestation and wind-down. This contract owns participant reporting/service and institutional exit orchestration without moving value.
- **PX-S13:** owns SLO/capacity/recovery/status/incident law. Service plans select approved commitments; ticket queues and health checks do not create them.

Resolved contradictions and explicit gaps:

1. `ops.portfolio` is tracker-complete for its Stage-1 ledger view, not M14. Its source explicitly names the indexer half unwired and house exposure residual; it has no complete PnL/performance/reporting/NAV product.
2. Ledger history and reconciliation are authoritative building blocks, but a transaction listing is not a statement until scope, cutoff, valuation, mapping, completeness, correction and artifact reproduction are proven.
3. Current spot/futures projections expose useful realized/unrealized PnL and positions in distinct SoRs. No evidence proves one reconciled cross-product methodology; PX-S11 forbids silently summing them.
4. The `institutional` KYC tier is an individual custodial-access state, not KYB, UBO/control, mandate, legal agreement, credit/counterparty, service or activation proof.
5. `ops.support` is a substantive ticket/KB/audit/case-file backend. Its source explicitly refuses SLA invention and names UI/live-compose gaps; it does not prove named 24/7 coverage, TAM, incident commitments or service reviews.
6. Support account grounding is a ticket-scoped read from identity and can be explicitly unread. It must not become a copied identity/KYB store or authority to change accounts, money, trading, risk or compliance decisions.
7. `svc-ops` CRM/revenue surfaces and portfolio-agent drafts are operational/assistive projections, not institutional onboarding, accounting, reporting or official portfolio authorities.
8. Audit-trail patterns from external rules strengthen reproducibility requirements but do not decide INTAFACED's entity, applicability, retention or designated record authority.
9. PX-S12 owns the custody position register, ledger/external reconciliation and entity finance close. PX-S11 owns authorized participant/auditor/regulator report composition and delivery from those facts; its accounting mappings cannot become a parallel general ledger or alter ledger purposes.
