# Spec — Pro Exchange Custody, Reconciliation, and Wind-Down (`PX-S12`)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; the one-ledger and transfer workflow foundations have implementation evidence, while live custody models, external rails, solvency attestations, treasury policy, and wind-down arrangements remain owner/external sockets

**Authority:** `PX-S12`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Requirements:** `PTX-M15-R01–R08`, `PTX-M23-R01–R07`

**Hard predecessors:** [`PX-S01`](SPEC-PRO-EXCHANGE-RULEBOOK-LIFECYCLE-INTEGRITY-2026-08-23.md), [`PX-S02`](SPEC-PRO-EXCHANGE-AUTHORITY-AND-PARTICIPANT-SECURITY-2026-08-23.md), [`PX-S03`](SPEC-PRO-EXCHANGE-MICROSTRUCTURE-AND-ORDER-EXECUTION-2026-08-24.md), [`PX-S06`](SPEC-PRO-EXCHANGE-COLLATERAL-RISK-LIQUIDATION-DEFAULT-2026-08-24.md)

**Primary systems of record:** `svc-ledger` for internal value and liabilities; custody, bank, chain, bridge, venue, and settlement-counterparty evidence for controlled external assets and receivables; durable deposit/withdrawal/settlement workflows for transfer state; and immutable reconciliation, correction, attestation, finance-close, and wind-down records

This contract defines how client assets are owned, controlled, moved, reconciled, evidenced, returned, and protected through failure or venue exit. It never turns an external balance into a second book or authorizes a live custodian, rail, asset, legal entity, reserve claim, or wind-down conversion.

## 1. Product promise, professional jobs, and non-goals

A professional or institution can trust the venue only if they can:

- identify the legal entity, custody model, ownership, location, encumbrance, availability, and finality of every asset;
- deposit, withdraw, settle, and transfer without duplicate value, hidden states, or optimistic credit;
- distinguish internal ledger finality from chain, bank, custodian, venue, and legal finality;
- reconcile statements and balances to immutable transactions and understand every break, correction, claim, and delay;
- keep trading collateral separate from corporate, insurance/default-fund, fee, treasury, and other clients' property;
- leave the venue through ordinary withdrawal, transfer to another custodian, or a credible wind-down without opaque forced substitution.

The contract serves traders, asset owners, fund administrators, brokers, custodians, treasury, finance, settlement operations, compliance, security/key management, support, auditors/attestors, risk, and incident command.

Non-goals:

- no custodian, bank, PSP, chain, bridge, stablecoin, settlement network, legal entity, jurisdiction, address, key, cutoff, confirmation count, fee, exposure cap, reserve frequency, auditor, or SLO is selected;
- no claim of segregation, insurance, guarantee, reserves, solvency, or legal ownership is permitted without the named evidence;
- no service, custody adapter, exchange venue, or projection may hold its own internal balance;
- no proof-of-reserves mechanism is equated with solvency, title, absence of encumbrance, or complete liabilities;
- no product code is authorized and no second SPA, money book, treasury book, or shadow ledger is created.

## 2. Research delta and durable patterns

The 24 August 2026 primary-source review found no missing mountain and confirmed PX-S12 as a dependency-foundation contract:

1. Custody requires an agreement, position register, policy, statements, prompt return, segregation, and controlled delegation. [MiCA Article 75](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-75-providing-custody-and) supplies the current regulatory benchmark. Applicability and legal implementation remain owner/legal sockets.
2. Wind-down must preserve critical activities and avoid undue client harm. [MiCA Article 74](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-74-orderly-wind-down-crypto-asset) requires an appropriate plan; ESMA's [17 April 2026 statement](https://www.esma.europa.eu/sites/default/files/2026-04/ESMA75-113276571-1679_Statement_on_the_end_of_transitional_periods_under_MiCA.pdf) emphasizes executable offboarding, prior notice, and transfer to an authorized provider or self-hosted wallet.
3. Placing client assets with a third party can become a sub-custody relationship rather than mere settlement. ESMA's [Q&A 2608 on pre-funding client orders](https://www.esma.europa.eu/publications-data/questions-answers/2608) reinforces the need to classify the relationship and disclose the custodian, not normalize every external placement as a venue balance.
4. Operational wallets are different jobs, not interchangeable addresses. [Coinbase Prime's wallet overview](https://docs.cdp.coinbase.com/prime/concepts/wallets/wallets-overview) separates trading, custody, vault, and on-chain functions; INTAFACED expresses that durable pattern through governed custody locations and ledger boundary accounts.

Research sharpens custody classification, client return, and wind-down execution. It does not authorize a legal conclusion or copy a competitor's architecture.

## 3. Existing INTAFACED authority and evidence to reuse

- Doctrine and the ledger ADR make `svc-ledger` the single internal book. All modules post through `ledger-client`; decimal strings cross boundaries and scaled bigint is used in memory.
- Ledger accounts encode legal/economic owner, asset, kind, and purpose. Per-order, withdrawal, collateral, loan, escrow, fee, insurance, and external-boundary accounts prevent unrelated obligations from sharing a pot.
- `rail:<rail>`, `venue:<venue>`, `bridge:<chain>`, and `mint` treasury accounts represent the internal side of an external asset or obligation. A negative boundary balance is a claim against external reality, not spendable platform inventory.
- `svc-ledger` atomically balances entries, deduplicates economic keys, assigns a global serial sequence/hash chain, retains history, exposes freezes, and checks cached balances against replay plus zero totals by asset.
- Reconciliation failure freezes ledger posting before notification; a failed alert cannot leave a broken book writable.
- `svc-pay` deposit workflow claims `(rail, railRef)` before booking and replays the same ledger key. Withdrawal holds before irreversible rail dispatch, then settles or reverses through ledger recipes.
- The chain watcher retains a monotonic cursor, waits for a configured finalization port, signs its delivery, and relies on downstream rail-event deduplication. It does not move ledger value itself.
- PX-S03 distinguishes engine match from ledger fill finality. PX-S06 distinguishes collateral/obligation workflow from ledger ownership and external custody evidence.

Current evidence is not a complete custody or treasury product. Operator credits are intentionally limited; the live chain adapter is narrow; wrong-chain recovery, travel-rule integration, complete fiat returns/recalls, institutional custody choice, off-exchange collateral, external position reconciliation, legal segregation, key ceremonies, solvency, attestation, finance close, and executable wind-down are not proven.

## 4. Legal, account, counterparty, and trust boundaries

| Boundary                       | Authority                                                           | Forbidden inference                                                         |
| ------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Client/legal owner             | PX-S02 and custody agreement                                        | User ID, deposit address, organization view, or ledger owner label alone    |
| Internal liability/encumbrance | `svc-ledger` account and transaction                                | Service row, cached view, chain balance, or custodian statement             |
| Controlled external asset      | Authenticated source evidence plus control/legal classification     | Ledger boundary balance or provider API success alone                       |
| Custody location/model         | Effective custody constitution and agreement                        | Wallet type, address ownership, provider marketing, or asset symbol         |
| Transfer workflow              | Durable transfer record and causal evidence                         | HTTP acknowledgement, tx hash, bank reference, or webhook alone             |
| External finality              | Versioned rail/chain/custodian/settlement policy                    | Internal ledger post or elapsed wall time                                   |
| Reconciliation break           | Reconciliation case and evidence                                    | Automatic compensating balance or unexplained write-off                     |
| Solvency/attestation           | Scoped liability and controlled-asset evidence plus approved method | Ledger zero-sum, wallet signature, Merkle inclusion, or one timestamp alone |

Actors include client/legal owner, beneficial owner, account/sub-account, authorized operator, custodian/sub-custodian, bank/PSP, chain/validator, bridge, issuer/stablecoin administrator, external venue, settlement agent, treasury, finance, compliance, key custodian, auditor/attestor, insolvency/wind-down authority, support, and incident command. Principal, agent, trustee, nominee, debtor, and creditor roles must be explicit.

## 5. Custody constitution and models

Every supported asset/legal-entity/product combination binds a `CustodyConstitutionVersion` containing:

- custody model, client-title/claim treatment, governing entity/jurisdiction, insolvency treatment, and agreement version;
- custodian and any sub-custodian, location/account/wallet class, control arrangement, permitted delegates, and conflicts;
- omnibus versus dedicated identification, client position-register method, segregation, reuse/rehypothecation prohibition or explicit consent, liens/encumbrances, and insurance/guarantee truth;
- supported asset/network, acceptance and return paths, finality, fork/reorg, recovery, screening/travel-rule, fee, and suspension policy;
- reconciliation sources/frequency, statement cadence, incident/default/exit route, retention, and effective interval.

Models are distinct:

| Model                      | Required truth                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `OMNIBUS`                  | Aggregate external holding plus complete internal client position register and allocation reconciliation              |
| `DEDICATED`                | Client-specific external account/address and verified legal/control mapping; still reconciled to the ledger           |
| `THIRD_PARTY`              | Named custodian contract, instruction authority, sub-custody chain, statements, and return/portability                |
| `OFF_EXCHANGE_CONTROLLED`  | Who controls assets, when collateral is recognized/encumbered, settlement calls/cycles, shortfall/default and release |
| `SELF_CUSTODY_RETURN_ONLY` | Validated destination and return path; never advertised as venue-held collateral                                      |

No model is enabled by adding an account kind or adapter. Missing legal ownership, control, insolvency, return, reconciliation, or delegation evidence makes the asset unavailable for new deposit/collateral use. Client assets cannot be used for own-account purposes or another client's obligation absent an explicit lawful product and consent; visibility never supplies consent.

## 6. Canonical objects, identifiers, precision, and clocks

Required identifiers include legal owner/account/sub-account, `custodyConstitutionVersion`, `custodyLocationId`, `externalAccountId`, `assetId`, network/rail, deposit address or bank-account reference, transfer/settlement/statement/reconciliation/correction/attestation/wind-down IDs, and all related ledger transaction IDs.

Every external observation records source, source event/reference, source sequence or cursor, block/transaction/log where applicable, observed/received/booked/final timestamps, finality policy/version, authentication evidence, and raw-evidence retention reference.

Amounts, fees, balances, liabilities, assets, receivables, encumbrances, reserves, and reconciliation differences cross boundaries as canonical decimal strings and use scaled bigint or another exact non-floating form internally. Block height, log index, confirmations, sequence, and timestamps are integers with declared units; they are not money. Asset/network identity is canonical and never guessed from a ticker.

## 7. Asset and transfer state

### 7.1 Asset state

Each amount is classified, never merely “balance”:

```text
EXTERNAL_OBSERVED → PENDING_FINALITY → CONTROLLED_UNBOOKED → BOOKED_AVAILABLE
                                      ↘ HELD/ENCUMBERED
BOOKED_AVAILABLE → HELD → EXTERNAL_SUBMITTED → EXTERNAL_PENDING → EXTERNAL_FINAL
                       ↘ REVERSING → BOOKED_AVAILABLE
any state → DISPUTED / RECONCILIATION_BREAK / RECOVERY_REQUIRED
```

Pending, available, held, collateral, escrow, unsettled, externally placed, disputed, returned, lost, frozen, and escheat/unclaimed states are separate. Legal title, operational control, ledger recognition, and spendability are independent attributes.

### 7.2 Deposit

A deposit binds beneficiary, asset/network, acceptance address/tag, custody location, source transaction, amount, observation/finality policy, screening/travel-rule case, fee, and ledger transaction.

1. Address/tag ownership and supported asset/network are established before credit.
2. The authenticated watcher/rail observation is claimed durably by a natural external business key.
3. Reorg/reversal risk reaches the configured finality state; no read-time or tx-hash presence alone creates available money.
4. Screening, required originator/beneficiary data, account eligibility, and amount/asset identity pass.
5. One `deposit` recipe moves from the named external boundary to the legal owner's ledger account.
6. Crash after claim re-drives the same key; a conflicting amount/owner/asset for the same external reference refuses.

Wrong network/asset, missing/incorrect memo, unsupported token contract, duplicate reference, reorg, replaced transaction, and dust are explicit cases. Recovery is never promised until technical control, legal/compliance permission, cost, fee consent, and destination exist. A recovery posts as a new linked action.

### 7.3 Withdrawal

A withdrawal binds authenticated owner/authority, idempotency key, asset/network, exact gross/fee/net, allowlisted destination/tag, risk/compliance decisions, hold, rail attempt(s), external reference, and finality.

```text
RECEIVED → AUTHORIZED → SCREENED → HELD → SUBMITTING
         → EXTERNAL_PENDING → FINAL
         ↘ REFUSED        ↘ OUTCOME_UNKNOWN → RECONCILING
         ↘ REVERSING → REVERSED
```

The ledger hold precedes external dispatch. Step-up, cooling period, velocity/amount policy, destination ownership/name match, account/collateral risk, chain/rail health, fee preview, and sanctions/travel-rule inputs are explicit. A timeout after dispatch is `OUTCOME_UNKNOWN`; funds remain held until source lookup proves final or safely absent. Retry uses the same economic withdrawal and a sequenced attempt; it cannot create a new spend.

Batching preserves per-client ownership, amount, fee allocation, destination, and finality. Acceleration/replacement identifies the superseded transaction and fee authority. A rail rejection reverses only after absence of value movement is proved. Customer cancellation is allowed only before the published irreversible point.

## 8. Fiat, chain, bridge, and external settlement

Each adapter declares capability, legal counterparty, environments, supported assets/networks/currencies, authentication, idempotency, cutoff/calendar, finality, cancellation/reversal, returns/recalls, statement/report sources, quotas, health, and exit/portability.

- Fiat settlement distinguishes instructed, accepted, processing, settled, returned, recalled, rejected, and outcome-unknown. Bank holidays and cutoffs are calendar data, not guessed delays.
- Name match, source of funds, safeguarding location, reference requirements, correspondent/intermediary fees, chargeback/return rights, and beneficiary validation are versioned.
- Chain settlement distinguishes mempool/submitted, included, confirmation/finality, reorged, replaced, reverted, and orphaned. Network/contract identity, tag/memo, token behavior, fee asset, nonce, signing policy, and fork response are explicit.
- Bridge settlement is two external legs plus a bridge obligation; source finality never proves destination issuance.
- Stablecoin redemption/issuance, exchange-venue transfer, RFQ/OTC, and off-exchange collateral settlement each identify debtor/creditor, asset location, encumbrance, cycle, shortfall/default, and legal finality.

Internal ledger finality can precede or follow external finality only according to a named recipe and risk limit. The difference appears as a boundary obligation/receivable and reconciles; it is never hidden in a service balance.

## 9. Treasury and key-control contract

Treasury inventory is classified by client/corporate/insurance/default-fund ownership, legal entity, asset/network, custody location, liquidity horizon, operational purpose, encumbrance, and counterparty. Hot, warm, cold, custodian, bank, venue, bridge, and in-transit holdings are separate operational states, not risk labels alone.

Owner-approved policy defines withdrawal-liquidity targets, replenishment/rebalance triggers, network-fee inventory, single/counterparty/location concentration, transfer limits, signers/quorum, emergency authority, and escalation. Blank values prohibit automated rebalancing or claims of adequacy.

Key material never enters specs, logs, events, or ledger metadata. Key generation/import, backup, storage, signing, rotation, revocation, compromise, recovery, ceremony participants, device/firmware, access/session evidence, and destruction are separately governed and dual-controlled. A database administrator or ordinary application operator cannot unilaterally move external value.

A treasury transfer uses preview, source/destination and ownership classification, scoped approval, durable intent, ledger reservation where applicable, signer evidence, external outcome, reconciliation, and closure. “Internal wallet move” is not an exemption.

## 10. One-ledger accounting and external boundaries

The ledger is the canonical internal liability and allocation book. Services own workflows and domain objects, not balances. Every economic transition is an atomic balanced `ledger-client` recipe whose accounts state owner, asset, kind, and purpose.

External boundary accounts answer what the book believes the outside owes or holds. They are not external truth. For example, booking a deposit changes a rail boundary and client liability together; reconciling the rail later determines whether the external asset supports that boundary.

The chart of accounts distinguishes at minimum:

- client available, holds, collateral, escrow, and unsettled claims by legal owner/account;
- custody/rail/chain/bridge/venue receivables or obligations by counterparty/location;
- client liabilities, corporate assets/liabilities, fee/revenue, operating expense, tax, insurance/default fund, and capital;
- borrowed/lent principal, interest/funding, settlement, recovery, dispute, and correction purposes.

Netting presentation never deletes gross legal obligations or encumbrances. Negative balances are allowed only for account types whose contract defines the obligation and limit. No general house account is a plug for reconciliation.

## 11. Reconciliation system

Reconciliation is layered:

1. **Transaction integrity:** entries balance exactly per asset; idempotency and global sequence/hash chain hold.
2. **Ledger reconstruction:** cached account balances equal complete entry replay; totals net to zero.
3. **Domain control:** orders/holds, positions/collateral, loans, fees, funding, liquidations, insurance, deposits, withdrawals, settlements, and corrections agree with linked ledger transactions.
4. **External position:** authenticated custodian, bank, chain, bridge, venue, issuer, and settlement statements/events agree with boundary accounts after declared timing/finality adjustments.
5. **Client liability/controlled asset:** liabilities reconcile to legally controlled assets plus separately identified enforceable receivables, net of disclosed encumbrances and exclusions.
6. **Finance/entity close:** revenue, rebates, fees, interest, funding, custody/treasury, tax, intercompany, and capital records reproduce by legal entity and period.

Each reconciliation declares scope, source versions/cursors, cutoff/timezone, expected timing items, frequency, tolerance socket, result, and evidence hash. Money equality is exact; any non-zero tolerance must describe the external rounding/settlement reason and never erases a break.

### 11.1 Break lifecycle

```text
DETECTED → VALIDATED → OWNED → CONTAINED → INVESTIGATING
         → CORRECTION_APPROVED → CORRECTED → REVERIFIED → CLOSED
         ↘ EXTERNAL_CLAIM / CUSTOMER_REMEDIATION / DEFAULT_CASE
```

A `ReconciliationBreak` records ID, source layers, legal entities/accounts/assets, expected/observed/difference, direction, materiality policy, first/last seen, age, suspected cause, affected clients/products, containment, owner, evidence, correction links, communications, escalation, and closure proof.

Breaks never auto-disappear when a later snapshot happens to match. They close through identified timing resolution or an authorized immutable correction. Unknown or material breaks freeze the smallest affected risk-increasing/value-moving scope; a ledger-integrity or unexplained solvency break freezes broadly enough to preserve assets. Withdrawals may continue only when their asset/location/ownership proof is unaffected and the plan does not disadvantage clients.

## 12. Corrections, reversals, disputes, and claims

Original ledger entries and external observations are immutable. A correction identifies original transaction/event, discovered error, authority, affected owner/entity, exact compensating entries, domain-state repair, statement impact, notification, and reconciliation proof.

A reversal means the contractual inverse economic event, not deletion. External returns, recalls, reorgs, chargebacks, cancelled payouts, busts, and recoveries retain distinct reason and counterparty. The platform never silently debits a client for an external loss without contractual authority and due process; a disputed entitlement remains a named claim/hold while investigated.

Manual credits require authenticated external evidence, unique business reference, scoped treasury authority, and second approval where material. A human assertion cannot make a live chain or bank balance true. Unrecoverable shortfall enters PX-S06 default/capital waterfall; it is not posted to miscellaneous revenue/fees.

## 13. Client statements, position register, finance close, and proof

The client position register reproduces each legal owner's asset, account/sub-account, custody model/location, available/held/collateral/unsettled/disputed amounts, encumbrances, transactions, external transfers, fees, and claims at a timestamp and ledger sequence. It reconciles to client statements and aggregate ledger liabilities.

Statements expose opening, activity, corrections, and closing balances; external finality; transaction/reference IDs; fees and FX; custody model and material delegates; unresolved holds/claims; generation time, cutoff, and source version. Regeneration identifies the same historical ledger sequence and any later correction rather than overwriting the old statement.

Finance close retains reproducible trial balances and subledger-to-general-ledger mappings by legal entity, asset, currency, product, counterparty, and period. Revenue, rebates, fees, interest, funding, custody/treasury movements, taxes, capital, insurance, and intercompany balances use explicit accounts and correction policy.

### 13.1 Attestation and reserve claims

An attestation package defines scope, legal entities, asset and liability population, cutoff, frequency, inclusion/exclusion, encumbrance, controlled-address/account evidence, receivables, client privacy, auditor/attestor or cryptographic method, sampling, exceptions, subsequent events, publication, and limitations.

A Merkle inclusion proof can show that one liability was included. A wallet signature can show control at one time. Neither proves complete liabilities, legal title, lack of borrowing/encumbrance, ongoing control, or solvency. Marketing and UI state exactly what is and is not proven. No “proof of reserves,” “fully backed,” “segregated,” “insured,” or “guaranteed” claim is enabled until the evidence and legal review satisfy its declared meaning.

## 14. External failure and exit playbooks

For each custodian, bank, PSP, chain, bridge, issuer/stablecoin, venue, and settlement network, a versioned playbook defines detection, exposure/cap, affected assets/services, stop/freeze boundary, open instructions, finality treatment, reconciliation, alternate route, asset/client portability, communications, recovery claim, data export, contract termination, and exercise evidence.

Failure modes include API outage, stale/contradictory statement, insolvency, asset freeze/seizure, key compromise, chain halt/reorg/fork, bridge exploit, stablecoin depeg/redemption stop, bank holiday/return/recall, venue withdrawal halt/default, and loss of legal authorization. Alternate providers are not equivalent unless asset, legal ownership, client consent, and settlement semantics are revalidated.

Counterparty caps are owner-set and enforced before new exposure. Missing cap or exit path refuses new placement/credit for that dependency. Existing assets remain visible and enter containment/recovery; the system does not pretend they vanished or are liquid.

## 15. Orderly wind-down

A `WindDownPlanVersion` names triggering entity/jurisdiction, scenarios, authority, critical services, dependency contracts, client populations/assets/products, funding/capital, staffing, communications, data/records, and executable actions. It is rehearsed and immediately usable, not a narrative contingency.

### 15.1 State and precedence

```text
PREPARED → INVOKED → NEW_RISK_STOPPED → INVENTORY_RECONCILED
         → CLIENT_ACTION_WINDOW → POSITION/LOAN/SETTLEMENT_RESOLUTION
         → ASSET_RETURN/TRANSFER → RESIDUAL_CLAIMS → CLOSED
         ↘ PAUSED_BY_AUTHORITY / RECOVERY_REQUIRED
```

Wind-down control has priority over ordinary growth/configuration changes but cannot bypass ledger, ownership, security, compliance, market-integrity, or rulebook authority. Trigger, scope, effective time, decisions, approvals, notices, and exceptions are immutable.

### 15.2 Required behavior

1. Stop onboarding, marketing, new products, new borrowing/leverage, and other new risk in the affected scope.
2. Preserve authentication/recovery, read access, data export, cancellation, repayment, collateral addition where safe, and customer support.
3. Inventory and reconcile legal owners, accounts, assets/locations, open orders, positions, loans, collateral, deposits/withdrawals, settlements, disputes, and claims.
4. Cancel open orders under PX-S03 and resolve pending fills before releasing holds.
5. Offer ordinary close, repay, withdraw, or transfer routes with deadlines, fees, constraints, and counterparty identity disclosed.
6. Resolve derivatives and collateral under existing rule/product versions; emergency settlement cannot invent a fixing, asset, price, or legal power.
7. Return the same asset to an authorized destination where legally/technically possible. Conversion or alternative asset requires explicit client request/consent and separately authorized execution; silence is not consent, consistent with [ESMA Q&A 2320](https://www.esma.europa.eu/publications-data/questions-answers/2320).
8. Keep pending/failed transfers, unsupported assets, frozen accounts, deceased/unreachable clients, disputes, dust, and external claims in an explicit residual process.
9. Continue AML/sanctions, custody, reconciliation, finance, record retention, privacy, incident, and regulatory/customer communication duties.
10. Close only after liabilities, controlled assets, receivables, encumbrances, unresolved claims, records, and responsible successors are reconciled and evidenced.

Automatic residual treatment, unclaimed-property/escheat handling, deadlines, destination restrictions, and fees require owner/legal authority and advance disclosure. Wind-down does not grant a confiscation or forced-conversion power.

## 16. API, event, terminal, operator, and reporting contract

Customer APIs expose custody model/location at an appropriate abstraction, legal service entity, asset/network, ownership/encumbrance and availability state, transfer lifecycle/finality, exact amounts/fees, source/destination references safe to disclose, timestamps, confirmations where relevant, refusal/degradation codes, corrections, and support/appeal path.

Commands require scoped authority and idempotency. Responses separate receipt, authorization, internal ledger finality, external submission, and external finality. Bulk/batch operations return each item; a batch tx hash never replaces client allocation truth.

Events carry schema/event version, causal/correlation IDs, owner/account, asset/network/location/rail, workflow and ledger IDs, source sequence/cursor, state/finality, observed/effective/published times, evidence provenance, and correction link. Delivery is at least once; consumers deduplicate and recover gaps from snapshots.

The terminal shows deposit/withdrawal capability and health, supported network identity, address/tag warnings, confirmation/finality, holds and unknown outcomes, fees, external references, custody/availability/encumbrance, reconciliation-impacting incidents, and wind-down actions/deadlines. Stale data is visibly stale; “completed” names which finality it proves.

Operator views separate workflow monitoring from privileged action and show ledger/external evidence, reconciliation breaks/age/owner, custody/counterparty exposure, liquidity, transfer queues, signing state, exception cases, approvals, and immutable audit. Operators cannot edit balances or mark an external transfer final by hand.

## 17. Security, compliance, privacy, and market integrity

- Deposit/withdrawal and custody policies incorporate sanctions, AML, fraud, source-of-funds, travel-rule, jurisdiction, asset/network, and beneficiary requirements through versioned decisions. Missing dangerous input refuses rather than supplying list content.
- Address allowlists, cooling periods, step-up/phishing-resistant authentication, device/session risk, out-of-band notice, velocity/amount policy, and dual approval protect withdrawal without hiding delay state.
- Custodian/operator/API/signing access is least-privileged, just-in-time where material, logged, independently reviewed, and removable without losing records.
- Key and destination secrets are minimized, encrypted, access-audited, excluded from general telemetry, and retained/deleted under legal and recovery needs.
- Treasury, house, affiliate, market-maker, and client transfers remain distinguishable for conflicts and surveillance. Internal transfers cannot obscure wash/self-trading or source/destination ownership.
- Record retention covers custody agreements/policies, position registers, instructions, addresses/accounts, observations, ledger postings, statements, reconciliations, breaks, approvals, key ceremonies, communications, claims, attestations, and wind-down evidence.

## 18. Concurrency, idempotency, replay, and degraded truth

1. External business identity—rail reference, chain event, settlement instruction, or provider event—roots idempotency; retries cannot change owner, asset, amount, or destination.
2. Withdrawals reserve ledger value before external dispatch. Deposits claim external evidence before booking. Crash windows are durably resumable.
3. Cursor and event consumption is monotonic within a declared domain; gaps, reorgs, replacement, or provider rewinds enter recovery rather than being skipped.
4. Multiple watchers/adapters may observe one event, but exactly one canonical claim can book it. Conflicting observations open a break.
5. Ledger post plus workflow-finalize failure replays the same key. External success plus missing local finality remains held/pending until lookup and reconciliation.
6. During ledger integrity failure, posting freezes. During one rail/custodian outage, the smallest affected new value movement stops; unrelated proven custody locations need not be mislabeled down.
7. A read or provider timeout is unknown, not zero, absent, failed, or final. UI/API/events carry the degraded dependency and last observation time.

## 19. Operations, SLO categories, capacity, and evidence

Metrics cover ledger sequence/post/reconciliation, boundary exposure, source statement/event age, deposit finality/credit lag, withdrawal hold/submission/finality/unknown age, reorg/return/recall, signing queue, hot/warm/cold liquidity, counterparty caps, break count/age/materiality, correction, statement/finance-close completion, attestation exceptions, and wind-down progress.

Owner-set SLO sockets cover ledger posting/recovery, transfer observation/finality, statement ingestion, reconciliation, break response, withdrawal service, client statement, finance close, and wind-down critical services. Until set and tested, no performance or recovery claim is made.

Load/fault evidence includes deposit/withdrawal bursts, fee spikes, batching, deep reorg, duplicate/conflicting events, provider cursor rewind, ledger/DB/bus outage, signer/key loss, custodian/bank/venue outage/default, stablecoin/bridge event, withdrawal run, mass client export/transfer, and region restoration. Tests prove exact value, no duplicate credit/debit, no premature release, monotonic recovery, bounded queues, and truthful client state.

## 20. Compatibility, rollout, rollback, and decommissioning

New state/finality/custody fields are additive and versioned; absent never means final, unencumbered, or segregated. Breaking semantics require a new API/event version, migration, compatibility period, fixtures, and customer notice.

New custody locations, assets, networks, rails, and adapters roll out through contract/legal review, sandbox/replay, authenticated source validation, shadow reconciliation, deposit-only or withdrawal-only bounded phases as appropriate, exposure caps, incident/exit exercise, and explicit activation. Money movement stays disabled until custody constitution and all critical sockets are effective.

Rollback stops new use, preserves existing workflow truth, reconciles in-flight transfers and boundary accounts, and moves/returns assets only through authorized ledger-backed actions. Removing an adapter never deletes the evidence required to resolve its obligations.

Decommissioning inventories clients/assets/instructions/keys/accounts/contracts/data, stops new exposure, completes or transfers obligations, revokes access and keys safely, retains records, and proves zero unexplained boundary balances. It feeds the orderly wind-down plan when the service/entity exits.

## 21. Definition of Done

PX-S12 is implementation-complete only when evidence proves:

1. every enabled asset/entity/product has an effective custody constitution and client agreement with ownership, segregation, insolvency, delegation, return, and exit truth;
2. omnibus, dedicated, third-party, and off-exchange models pass isolation, allocation, encumbrance, statement, and portability tests where enabled;
3. deposits and withdrawals pass duplicate/conflict, crash, reorg, replacement, memo/tag, wrong-network/asset, screening, fee, batch, cancellation, and unknown-outcome tests;
4. each fiat/chain/bridge/custodian/venue settlement state and finality is explicit and reconciled to its boundary account;
5. treasury inventory, liquidity, counterparty caps, approvals, signing, key ceremonies, compromise, rotation, and rebalance are exercised without application-held balances;
6. ledger replay, hash chain, zero totals, domain controls, external positions, liabilities/assets, and finance-close reconciliations run at approved frequencies and freeze safely on breaks;
7. every break retains owner, age, materiality, cause, impact, correction, communication, re-verification, and closure evidence;
8. statements and position registers reproduce exact historical ledger/custody state and append corrections;
9. attestation/reserve claims are scoped, privacy-preserving, independently reproducible, limitation-labelled, and cannot imply unproven solvency/title;
10. every external dependency has tested outage/default/cap/exit/portability behavior;
11. the wind-down plan is funded, staffed, executable, rehearsed, and proves new-risk stop, full inventory, close/repay/transfer/return, residual claims, records, and communications;
12. security, compliance, privacy, dual-control, and surveillance tests cover all money-moving and key/custody operator paths;
13. capacity/fault evidence proves exact-once economics and deterministic recovery under burst, run, provider loss, and regional restoration;
14. PX-S01/PX-S02/PX-S03/PX-S06 conformance and PX-S11/PX-S13/PX-S14 consumer contracts pass for enabled scope.

A specification, ledger zero-sum result, wallet balance, green tracker row, or unqualified proof-of-reserves artifact is not implementation proof.

### 21.1 Requirement proof map

| Requirement   | Contract closure                                                                                   | Required implementation evidence                                                 |
| ------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PTX-M15-R01` | §§4–5 define ownership, insolvency, omnibus/dedicated/third-party/off-exchange models              | Effective agreements, control proof, register, segregation, and return fixtures  |
| `PTX-M15-R02` | §§5 and 8 define controlled off-exchange collateral, calls, cycles, shortfall/default              | Counterparty contract, intraday reconciliation, margin/default and exit exercise |
| `PTX-M15-R03` | §7 defines deposit/withdrawal identity, finality, recovery, controls, fees and batching            | Chain/rail adversarial and customer lifecycle corpus                             |
| `PTX-M15-R04` | §8 defines bank/PSP cutoff, return/recall, match, safeguarding and reconciliation                  | Live-adapter contract, calendar/failure, statement and safeguarding proof        |
| `PTX-M15-R05` | §§7–8 separate internal, venue, OTC, custody and external finality                                 | Per-path state/finality/replay and boundary reconciliation                       |
| `PTX-M15-R06` | §9 defines inventory, liquidity, fees, rebalance, caps, keys and segregation                       | Ceremony, signing, compromise, run and rebalance exercises                       |
| `PTX-M15-R07` | §§10–11 reconcile each liability to controlled asset/receivable                                    | Scheduled exact external reconciliation and break evidence                       |
| `PTX-M15-R08` | §14 defines eight external failure/default and exit playbooks                                      | Approved caps, portability contracts, and retained exercises                     |
| `PTX-M23-R01` | §11 defines six reconciliation layers over every control account                                   | Cross-domain automated reconciliation and restoration proof                      |
| `PTX-M23-R02` | §11.1 defines durable owned break lifecycle and correction closure                                 | Break aging/escalation/customer-impact/correction fixtures                       |
| `PTX-M23-R03` | §§5 and 10 distinguish liabilities, assets, receivables, encumbrance, funds and corporate accounts | Legal-entity chart-of-accounts and statement reconciliation                      |
| `PTX-M23-R04` | §13.1 bounds attestation scope, privacy, method, exclusions and limitations                        | Independent signed pack and misleading-claim negative tests                      |
| `PTX-M23-R05` | §§9, 13 and 15 bind capital/liquidity to stress, run and wind-down cost                            | Owner policy, legal availability, stress and funding evidence                    |
| `PTX-M23-R06` | §15 defines executable orderly wind-down and residual claims                                       | Full rehearsal with client transfer/return and closure proof                     |
| `PTX-M23-R07` | §13 defines reproducible entity-level finance close                                                | Period-close mappings, source reconciliation, approvals and corrections          |

## 22. Owner and external sockets

| Socket       | Required authority/input                                                                            | Refuse-closed behavior while absent                               |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `PX-S12-O01` | Legal service/custody entities, jurisdictions, ownership, insolvency, segregation, client agreement | No custody/legal claim or affected new asset acceptance           |
| `PX-S12-O02` | Enabled custody model/location, custodian/sub-custodian and control/return contract                 | Location is ineligible for new client value/collateral            |
| `PX-S12-O03` | Supported assets/networks/rails, finality, reorg/fork, fee and recovery policy                      | Deposit/withdrawal/credit on that path refuses                    |
| `PX-S12-O04` | Fiat safeguarding, bank/PSP, cutoffs/calendars, match, returns/recalls                              | Fiat path refuses live value movement                             |
| `PX-S12-O05` | Screening, travel-rule, source-of-funds and jurisdiction decisions/content                          | Affected transfer refuses; no invented list or rule               |
| `PX-S12-O06` | Treasury liquidity, caps, rebalance, fee inventory, approvals and key policy                        | Automated treasury movement and adequacy claim refuse             |
| `PX-S12-O07` | Reconciliation frequency/materiality/timing policy and source authority                             | Unproven scope remains degraded; unexplained break freezes safely |
| `PX-S12-O08` | Entity chart of accounts, accounting/tax policy and finance-close authority                         | No entity financial claim or unsupported netting                  |
| `PX-S12-O09` | Attestation scope/frequency/method/attestor/public wording                                          | No reserve/solvency/segregation claim                             |
| `PX-S12-O10` | Capital/liquidity commitment, stress policy and wind-down budget                                    | No adequacy claim; new affected exposure refuses                  |
| `PX-S12-O11` | Wind-down triggers, authority, deadlines, residual/unclaimed-property and conversion law            | No forced residual action or conversion                           |
| `PX-S12-X01` | Custodian/sub-custodian authenticated balances, statements, instructions and portability            | External asset is unavailable/unproven, not zero                  |
| `PX-S12-X02` | Bank/PSP/chain/bridge/issuer/venue/settlement source and exit contracts                             | Affected path is disabled or outcome unknown                      |
| `PX-S12-X03` | Signing/key infrastructure and independent ceremony/recovery evidence                               | External value movement refuses                                   |
| `PX-S12-X04` | Auditor/attestor and privacy-preserving liability/asset methodology                                 | No attestation publication                                        |

## 23. Cross-spec dependencies and contradiction register

- **PX-S01:** owns asset/market lifecycle, disclosures, emergency states, corrections, and governance. Custody state can restrict a market but cannot rewrite its rule history.
- **PX-S02:** owns legal owner, account/sub-account, actor/session and approval authority. A custody address or omnibus allocation never replaces that identity.
- **PX-S03:** owns order/fill/hold/release finality. A match is not a settled client asset, and wind-down cancellation must reconcile racing fills.
- **PX-S06:** owns collateral eligibility, risk, liquidation, default waterfall, and capital stress. Custody control is necessary but not sufficient for collateral value.
- **PX-S07/PX-S08/PX-S09/PX-S10:** own product/RFQ/fee economics and settlement inputs; PX-S12 owns common custody, transfer and reconciliation semantics.
- **PX-S11:** consumes authoritative ledger/custody/statement evidence; reports cannot become a shadow balance or settlement authority.
- **PX-S13:** consumes dependency/failure, recovery, capacity and wind-down critical-service states; it cannot thaw a broken ledger or invent external finality.
- **PX-S14:** owns venue/on-chain route execution; external venue balances, prefunding and settlement remain custody-classified and reconciled here.

Resolved contradictions:

1. Ledger totals netting to zero proves internal double-entry integrity, not external asset coverage or solvency. PX-S12 requires layered external and liability reconciliation.
2. A boundary account records the internal claim against a rail/venue/bridge; it is not the provider's statement and cannot authorize another withdrawal.
3. Existing operator deposit credit is safe only for explicitly creditable rails. It is not a generic live custody ingestion path.
4. A chain watcher cursor prevents ordinary replay, but a cursor is not finality, reorg recovery, asset identity, custody title, or complete reconciliation.
5. A transfer tx hash or provider “success” is not universal finality. Internal, technical, counterparty, and legal finality remain separate.
6. Off-exchange prefunding may create custody/sub-custody and counterparty exposure. It cannot be modeled merely as routing collateral.
7. Proof of reserves does not prove complete liabilities, unencumbered title, capital, liquidity, or solvency; all such marketing remains disabled absent its own evidence.
8. Wind-down authority does not permit silent asset conversion, forfeiture, or ledger bypass. Residual treatment stays owner/legal-set and refuse-closed.
