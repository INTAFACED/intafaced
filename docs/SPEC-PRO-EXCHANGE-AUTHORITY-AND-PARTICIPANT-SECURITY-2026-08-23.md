# Spec — Pro Exchange Authority and Participant Security (`PX-S02`)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; legal-role and policy magnitudes remain owner-set  
**Authority:** `PX-S02`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)
**Requirements:** `PTX-M01-R01–R08`, `PTX-M17-R01–R08`  
**Reuses without restatement:** [`SPEC-SUBACCOUNTS-2026-08-02.md`](SPEC-SUBACCOUNTS-2026-08-02.md)

This contract answers one question for every professional action: **which authenticated human or machine had authority over which legal owner, account, product, instrument, amount, and time—and how can that authority be revoked before more harm occurs?** Authentication alone is never authority, and aggregate visibility is never write permission.

---

## 1. Promise and non-goals

Organizations can separate books, strategies, clients, and duties; delegate bounded work; rotate shifts and credentials; and recover from compromise without leaking money, data, or authority across boundaries.

This spec does not define KYC vendor choice, jurisdiction eligibility, numeric risk/withdrawal thresholds, portfolio margin, broker licensing, custody architecture, or a generic employee IAM system. It defines the exchange participant and operator authority contract those products must obey.

### 1.1 Current primary-source research register

**Research date:** 24 August 2026. These sources provide control patterns only; they neither authorize a live role nor supply an owner value.

| Official primary source                                                                                                                           | Durable pattern                                                                                                                                                                             | INTAFACED implication and existing coverage                                                                                                                                                               | Applicability limit                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Coinbase Prime consensus and transfer security settings](https://help.coinbase.com/en/prime/securing-your-account/security-settings)             | Institutional authority separates entity, portfolio, and transfer policies and supports transaction-type, destination, asset, amount, consensus, and additional verification controls.      | §§3–10 already require leaf account scope, distinct initiate/approve/commit roles, four-eyes, step-up, transfer-only authority, immutable approval evidence, and no inheritance from trading credentials. | Coinbase roles, approval counts, amount bands, video process, and custody terms are not defaults for INTAFACED.                                 |
| [CME Risk Management Tools](https://www.cmegroup.com/tools-information/webhelp/globex-credit-controls/Content/Home.html)                          | Clearing and execution administrators receive distinct, positively permissioned account/product controls, pre-execution limits, block/unblock functions, scoped kill, and retained reports. | §§3–8 and §§13–15 already require role/attribute intersection, broker/DMA boundaries, account/product limits, scoped kill/revocation, reportable outcomes, and recovery from stale authority.             | CME clearing roles and product mechanics are not assumed to match INTAFACED's entity or counterparty model.                                     |
| [SEC Rule 15c3-5 market-access controls](https://www.sec.gov/rules-regulations/2011/06/risk-management-controls-brokers-or-dealers-market-access) | Direct or sponsored access remains under the broker's documented financial/regulatory controls, supervisory procedures, regular review, and accountable certification.                      | §§4, 8, and 15 already keep DMA/client mandates narrower than account/risk/compliance authority and require evidence, review, revocation, and fault testing.                                              | Securities-market legal applicability and certification roles remain counsel/owner sockets.                                                     |
| [NIST SP 800-63B-4](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-63b-4.pdf)                                                  | Phishing resistance requires a cryptographic protocol bound to the legitimate verifier/session; manually entered OTP output is not phishing-resistant.                                      | §7 already requires phishing-resistant credentials for privileged/high-risk paths, replay binding, rotation/revocation, device/session evidence, and safe refusal when proof is stale.                    | NIST assurance levels and authenticator selection are security-owner decisions; the citation does not make every current credential conformant. |

The research pass found no new authority requirement beyond M01/M17. It strengthened the evidence that portfolio/transfer approval, broker/DMA supervision, positive permission, and phishing resistance must remain separately testable rather than collapsing into a generic administrator role or MFA claim.

## 2. Immutable inheritance and money boundaries

- A legal person or organization owns accounts. An account owns sub-accounts. Orders, positions, holds, fills, reports, credentials, and mandates resolve to one explicit leaf boundary.
- Sub-account zero-cross-leak law remains exactly as the existing spec defines it. This spec may add narrower permissions; it may not add ambient sibling funding or writes.
- Every value-moving command resolves the legal owner, account, sub-account, actor, credential/session, mandate, and approval state before a hold or posting.
- Money moves only through balanced `ledger-client` recipes. Permissions never confer a balance and no authority service stores spendable value.
- Aggregate reads are separately entitled and cannot be reused as an aggregate write selector.

## 3. Canonical actors and roles

The model distinguishes, rather than aliases:

- legal entity, beneficial owner, authorized signatory, and individual trader;
- organization admin, security admin, risk manager, compliance reviewer, treasury/withdrawal approver, auditor/read-only user, and support contact;
- trading desk, originator, execution trader, caretaker, shift supervisor, broker/DMA operator, and client principal;
- API service account, strategy runtime, copy delegate, agent runtime, and external integration;
- platform operator, privileged support, incident commander, and independently reviewing approver.

Roles are templates, not the final decision. Effective authority is the intersection of legal ownership, organization membership, role grants, attribute policy, mandate, credential scope, account/product state, jurisdiction/compliance eligibility, risk controls, and current approval.

```text
effective authority = ownership
                    ∩ active membership
                    ∩ role grants
                    ∩ attribute constraints
                    ∩ mandate
                    ∩ credential/session scope
                    ∩ product/compliance eligibility
                    ∩ risk and market state
                    ∩ required approvals
```

An empty or indeterminate operand refuses. No union, fallback role, administrator override, or “same organization” shortcut is permitted on a money path.

## 4. Authority grant object

Every grant is versioned and records:

- `grantId`, legal owner, organization, grantee human/service identity, grantor, and approval evidence;
- allowed accounts/sub-accounts, products, instruments/groups, actions, sides, order types, environments, and data classes;
- exact owner-set size/notional/leverage/position/loss/transfer/withdrawal/message constraints by reference, never JS `number`;
- IP/network/device, time window/schedule, session duration, credential class, and step-up requirement;
- ability to view, draft, preview, submit, amend, cancel, reduce, flatten, transfer, withdraw, approve, administer, export, or delegate;
- effective/expiry times, revocation semantics, version, reason, and originating mandate.

Absence means deny. Wildcards are explicit, visible, separately approvable, and prohibited for withdrawal or further delegation unless owner policy specifically permits them. A child grant must be a strict subset of its parent and cannot outlive it.

## 5. Account and desk routing profiles

Profiles may default account, sub-account, broker/client tag, product, strategy, order attributes, and permitted venue by market or workflow. Before commitment, UI and API preview expose the fully resolved target and grant. A profile is convenience only:

- it cannot widen authority or bypass ownership/risk/compliance;
- missing/ambiguous targets refuse rather than falling back to primary;
- profile version is recorded on the instruction;
- profile changes do not retarget already accepted orders;
- shared profiles require organization permission and immutable version history.

## 6. Four-eyes and approvals

Policy classifies actions as single-actor, step-up, or dual-control. At minimum the policy must explicitly decide organization/security administration, credential scope expansion, withdrawal destination/security changes, high-risk transfers/withdrawals, live strategy/agent autonomy, manual fill/correction, emergency settlement, and privileged operator action.

An approval binds the canonical command hash, actor, target, exact amounts/limits, rule/config version, expiry, and consequence preview. The proposer cannot satisfy an independent-approver requirement. Editing any bound field invalidates approval. Approval is consumed idempotently and cannot authorize a second command.

## 7. Session, device, and credential security

### 7.1 Human sessions

Human access supports phishing-resistant MFA/WebAuthn, authenticator lifecycle, recovery codes, device/session inventory, risk-based step-up, concurrent-session policy, reauthentication for sensitive actions, remote termination, and prompt notification of material changes.

Recovery cannot silently disable withdrawal cooling, address allowlists, or independent approvals. A compromised support channel cannot alone reset money controls. Recovery evidence and every override are immutable and reviewable.

### 7.2 API and machine credentials

Credentials are displayed once, then hashed or held in an approved secret system. They have explicit environment, owner, sub-account, product/action/data scopes, IP/network restrictions, expiry, rotation lineage, last use, anomaly state, and kill switch. Query-string secrets and secrets in logs/events are forbidden.

Rotation permits a bounded overlap only when policy allows it and records which credential produced every request. Revocation blocks new intent immediately. Open orders or strategies follow a preselected revoke policy—leave, cancel, drain, or flatten within authority—never an implicit destructive default.

Withdrawal authority is absent from trading credentials. A future exception requires its own product contract, step-up/approval policy, and explicit customer consent.

### 7.3 Attribution

Every order, strategy decision, fill, transfer, configuration change, approval, export, and report preserves legal owner, resolved account/sub-account, human/service actor, session or key ID, client/broker tag, grant/mandate version, request ID, origin channel, and relevant device/network evidence. Secrets and unrelated private data are excluded.

## 8. Broker, DMA, client, and shift boundaries

A broker hierarchy separately identifies broker organization, client legal owner, executing trader, client account/sub-account, commission/markup schedule, mandate, order origin, and settlement/reporting responsibility. Client tags never substitute for ownership.

Claim, assign, pass, accept, reject, unclaim, and shift handoff change operational caretaking only within the underlying mandate. They do not transfer account risk, beneficial ownership, original instruction identity, or hidden discretion. At every moment a live order has a visible responsible desk or is explicitly flagged unattended; there is no unowned interval.

Revocation prevents new instructions immediately and prevents amendments that increase exposure. Treatment of existing orders is explicit per grant/mandate and visible before revocation. Emergency cancel/reduce paths remain constrained to the affected owner and cannot reach sibling accounts.

## 9. Withdrawal and transfer protection

The contract must support address/beneficiary allowlists, addition/change cooling state, trusted-device policy, velocity and risk controls, source/destination screening, step-up, independent approval, out-of-band notification, cancellation where still reversible, and honest pending/held/refused states.

No policy magnitude is invented. A blank required threshold or approval rule refuses the affected transfer. Operational urgency, VIP status, or support escalation does not permit bypass; an approved break-glass route is separately scoped, dual-controlled where material, time-limited, customer-visible where appropriate, and reconciled.

## 10. Privileged platform access

Production privileges are just-in-time, least-privileged, time-bound, ticket/reason-bound, and session-recorded. Material actions require independent approval according to policy. Operators cannot:

- impersonate a participant to place risk-increasing intent;
- read or export unrelated customer/strategy data;
- edit canonical order, fill, ledger, or audit history;
- mint a participant grant outside the organization approval model;
- bypass a sanctions, jurisdiction, market, risk, or owner-decision refusal.

Break-glass use raises an incident/audit event, expires automatically, and triggers independent review.

## 11. Security and privacy control plane

The venue maintains accountable programs for secure development, dependency/supply-chain integrity, secret scanning/rotation, vulnerability intake and remediation, penetration testing, bounty, DDoS/bot/credential-stuffing resistance, insider threat, social engineering/SIM-swap exercises, and incident response.

Participant and organization data has classified purpose, residency, access, minimization, retention, export, legal-hold, deletion constraint, and breach response. Strategy, order, portfolio, identity, device, case, and credential data are separate classes. Support, agents, vendors, and analytics receive only purpose-bound fields through adapters.

Claims about insurance, guarantees, segregation, recoverability, or reimbursement require the claims approval/evidence rule in M00. The product must state exclusions and legal entity scope; security controls do not become an implied financial guarantee.

## 12. State machines

### 12.1 Membership and grant

```text
INVITED → VERIFIED → ACTIVE → SUSPENDED → REVOKED → EXPIRED/ARCHIVED
                         ↘ REVOCATION_PENDING (only for explicit external propagation)
```

`SUSPENDED`, `REVOKED`, or expired grants accept no new intent. External propagation lag is visible and bounded; internal enforcement is immediate.

### 12.2 Credential

```text
PENDING → ACTIVE → ROTATING → REVOKED → DESTROYED_METADATA_RETAINED
                    ↘ COMPROMISED → REVOKED
```

Only one declared overlap may exist during rotation. Destruction removes secret material but retains non-secret attribution and audit metadata.

### 12.3 Sensitive command

```text
DRAFT → PREVIEWED → APPROVAL_PENDING → APPROVED → COMMITTED
          ↘ REFUSED       ↘ EXPIRED/REJECTED      ↘ PARTIAL/FAILED → RECONCILED
```

Preview and approval bind immutable intent. Retries use the original idempotency key and terminal-state lookup.

## 13. Failure and attack cases

Proof must cover compromised password/MFA/device/API key, support-channel takeover, stale organization membership, concurrent revoke/place, grant expiry during an algo, forged client/sub-account ID, profile retarget, approval replay, proposer self-approval, key rotation race, duplicated command, session theft, insider export, malicious broker tag, aggregate-read-to-write confusion, and region/dependency loss.

When identity, ownership, grant, approval, security-policy, compliance, risk, or ledger authority is stale or unavailable, new or risk-increasing actions refuse. Cached authority may support read-only views only within declared freshness/entitlement limits. It may never support withdrawals or privilege expansion.

## 14. Interfaces, events, and evidence

Downstream specs must provide typed contracts for organization/membership, roles/grants, routing profiles, credential lifecycle, sessions/devices, approvals, revocations, alerts, audit search/export, and effective-authority preview. Responses state resolved target, allowed/denied actions, reason codes, policy/grant versions, freshness, and remediation category without leaking security-sensitive policy internals.

Events are versioned, append-only, idempotent, and attributable. Revocation, freeze, credential compromise, approval, organization change, and sensitive command outcomes are high-priority events with measurable propagation and consumer acknowledgement. Gaps or stale policy place affected writes into refusal, not optimistic continuation.

## 15. Definition of Done

1. Every linked PTX requirement maps to an invariant, state transition, test, or named owner socket.
2. A specific ownership check precedes every money/order/configuration write; missing account/sub-account never defaults.
3. Effective authority is intersection-only, default-deny, versioned, previewable, and causally attributed.
4. Sub-account zero-cross-leak and freeze cascade remain structurally and behaviorally proven.
5. Four-eyes approvals bind immutable exact intent and cannot be self-approved or replayed.
6. Human, API, strategy, copy, and agent credentials are distinct, least-privileged, revocable, and never silently gain withdrawal.
7. Revocation races, restart, cache staleness, partial external propagation, and existing-order policy are fault-tested.
8. Broker/client/desk/shift actions preserve beneficial owner, mandate, originator, caretaker, and immutable history.
9. Privileged access, recovery, withdrawal protection, privacy, incident, and customer-claim controls have retained operational evidence.
10. No amount, threshold, legal role, jurisdiction, or live privilege is inferred from an example or tracker label.

### 15.1 Requirement proof map

| Requirement   | Contract closure and required proof                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `PTX-M01-R01` | §§3–4; distinct legal, beneficial-owner, desk, broker, operator, and machine identities                |
| `PTX-M01-R02` | §2 and reused sub-account contract; leaf isolation and negative cross-leak proof                       |
| `PTX-M01-R03` | §§3–5; intersection-only RBAC/ABAC, exact constraints, resolved-target preview, and deny               |
| `PTX-M01-R04` | §6; immutable four-eyes approval, self-approval/replay refusal, and exact command binding              |
| `PTX-M01-R05` | §§7.3 and 14; causal session/key/grant attribution through orders, money, changes, reports             |
| `PTX-M01-R06` | §8; broker/DMA ownership, client tags, commissions, segregation, allocation, and revocation boundaries |
| `PTX-M01-R07` | §§3 and 8; desk/originator/caretaker/shift/risk visibility and action boundaries                       |
| `PTX-M01-R08` | §5; versioned routing profiles, resolved-account preview, and ownership non-bypass                     |
| `PTX-M17-R01` | §§7.1, 9, and 13; phishing-resistant access, recovery, device/session, and money controls              |
| `PTX-M17-R02` | §7.2; secret lifecycle, least privilege, network scope, rotation, revocation, and kill                 |
| `PTX-M17-R03` | §9; allowlist, cooling, velocity/risk, approval, notification, and honest delay states                 |
| `PTX-M17-R04` | §§6 and 10; JIT privilege, dual control, session recording, expiry, and independent review             |
| `PTX-M17-R05` | §11; secure-SDLC, supply-chain, vulnerability, penetration, bounty, and incident ownership             |
| `PTX-M17-R06` | §§11 and 13; DDoS, bot, credential, insider, social, SIM-swap, and support-takeover proof              |
| `PTX-M17-R07` | §11; purpose, minimization, residency, access, retention, export, deletion, and breach law             |
| `PTX-M17-R08` | §11; evidence-gated insurance/guarantee/segregation/recovery claims and exclusions                     |

## 16. Open owner and external sockets

- Legal organization/persona model, broker/DMA products, mandates, and eligible jurisdictions.
- Role templates, independent-approval classes, withdrawal/transfer security policy, and every numeric magnitude.
- Session, device, credential expiry/rotation, trusted-device, cooling, and anomaly policies.
- Treatment of existing orders/strategies when a grant, key, leader, agent, or desk assignment is revoked.
- Institutional support/privileged-access operating model, data residency/retention, and breach/claim policy.
- Vendor adapters for identity proofing, device/risk signals, notifications, screening, and secrets; each requires failure and exit behavior.

Unset sockets refuse only the affected capability with a typed reason. They never create a broad administrator bypass or fallback to a primary account.

## 17. Cross-spec dependencies, contradictions, and implementation gaps

- **PX-S01** owns product eligibility, rule versions, market state, correction, discipline, and integrity authority; membership or authentication cannot override it.
- **PX-S03** consumes resolved leaf authority and attribution for every order/control; aggregate visibility and broker/client tags never become money authority.
- **PX-S05/PX-S15/PX-S16** may define desk, strategy, copy, and agent workflows only inside the grants, approvals, revocation, credential, and withdrawal boundaries here.
- **PX-S12** owns custody and transfer finality; this contract authorizes commands but never stores or moves value.

Sub-account and authentication foundations are substantive, but the audit found no complete institutional legal-role model, broker/DMA mandate product, desk/shift ownership system, full ABAC/four-eyes policy, or venue-wide participant-protection evidence pack. This specification closes their authority semantics without claiming those products are built.
