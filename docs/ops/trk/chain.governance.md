# TRK-chain.governance — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `chain.governance`  
**Title:** Governance parameter handover  
**Module / phase:** `chain` · phase **5P** · plane **P**  
**Status on tip:** `ready` · **owner:** none · progressive decentralisation §17.2 P3  
**Depends on:** `chain.validators` · `token.governance` (**socket** — ballot only)  
**Tip freeze:** `origin/main` @ `c7af0849` (re-derive before implement)  
**Pack type:** research only. Agents **must not invent** quorum / threshold / grant execution. Babysit implement.

---

## 1 · What “done” means (plain language)

1. Chain **parameters** that matter on INTACHAIN (fees, listing rules, module flags) move from house multi-sig / admin to **IFC-weighted governance** with real outcomes.
2. Proposals can **pass / fail** by published quorum and thresholds — not endless `open` ballots.
3. **Execution** actually changes chain or module config (or posts a ledger recipe for `grant`) — a UI that only records votes is not handover.
4. Parameter list is public: which plane executes each kind (`listing` → trade, `fee_param` → config, `curriculum` → academy, `grant` → ledger).

---

## 2 · Current code state (tip)

### 2.1 Ballot exists (Fiat Plane) — outcomes do not

Tracker `token.governance` was **corrected 2026-08-03** from false `done` to **`socket`**. Evidence on tip:

| Capability                                                 | Tip truth                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| createProposal / castVote / list / get                     | **Mounted** in `services/svc-token`                                 |
| Vote weight                                                | `stakeOf` snapshot inside vote tx (race-safe vs concurrent unstake) |
| Zero weight                                                | Refused                                                             |
| One ballot per user                                        | Unique index on `(proposal_id, user_id)`                            |
| `proposal_status` enum                                     | includes `passed` / `rejected` / `executed` / `cancelled` in schema |
| Code that **writes** those four statuses                   | **None** — only draft/open at insert                                |
| Quorum / pass threshold / tally job / close job / executor | **None**                                                            |
| getProposal tally                                          | Read-time compute only — acted on by nothing                        |
| Future `opensAt` draft → open                              | **Nothing flips draft to open**                                     |

Schema: `services/svc-token/drizzle/0000_token_init.sql` — `proposals`, `governance_votes`, kinds `listing` \| `fee_param` \| `curriculum` \| `grant`.  
Service: `services/svc-token/src/token-service.ts` (proposal/vote surface).

### 2.2 Chain parameter target — absent

| Area                     | Tip                            |
| ------------------------ | ------------------------------ |
| INTACHAIN params store   | No chain                       |
| House multi-sig on chain | N/A                            |
| Cross-service executors  | Not designed as shippable jobs |
| `chain.validators`       | Blocked on mainnet             |

### 2.3 Why socket (not “almost done”)

Quorum and thresholds are **product law**. Three of four proposal kinds execute across service boundaries. `grant` **moves value** (Class M + owner carve-out). A job that only flips a status column would look like action and be none — worse than honesty.

---

## 3 · Doctrine constraints

| Law            | Implication                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| §4.3           | IFC-weighted governance; fee_param / listing / curriculum / grant kinds     |
| §17.2 P3       | Progressive decentralisation: schedule + governance takes parameter control |
| §21 5P         | Governance handover schedule published                                      |
| §0.6           | `grant` = ledger recipe only; no balances in token service                  |
| Class M        | Money-moving outcomes need recipes + failure tests + second-pass            |
| Class X        | Prod governance keys; who may open system proposals                         |
| Agent protocol | Do not invent quorum numbers                                                |

---

## 4 · Dependency graph

```
token.staking (done)
       │
       ▼
token.governance (SOCKET — ballot only)
       │
chain.mainnet ──► chain.validators ──► chain.governance (handover)
       │
       └── chain params exist only after mainnet
```

Both legs required: **ballot outcome engine** (token plane) **and** **chain to hand over** (protocol plane). Completing one without the other is not this row’s title.

---

## 5 · Parameter catalog (research sketch — not product law)

Kinds already in schema — **execution homes are design targets**, not implemented:

| Kind                      | Intended effect plane                 | Notes                                                                 |
| ------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `fee_param`               | `svc-token` params / trade fee config | Token service already treats params as governable surface in comments |
| `listing`                 | `svc-trade` market enable             | Cross-service; contracts/events only                                  |
| `curriculum`              | `svc-academy`                         | Cross-service                                                         |
| `grant`                   | Ledger recipe                         | Class M; owner carve-out                                              |
| **Chain-native** (future) | INTACHAIN module params               | Needs chain.mainnet; may need new kinds or bridge from ballot         |

This catalog is for research alignment. **Numbers and which params are in scope** are Denon/Shehzad — agents document, do not invent.

---

## 6 · DoD sketch (checkable — staged)

### Stage A — outcome engine (token.governance leave socket)

- [ ] Owner-set quorum + pass threshold published.
- [ ] Close/tally job: open → passed \| rejected; draft → open when `opensAt` hits.
- [ ] No false “executed” without executor success.
- [ ] Tests: unstake race, zero weight, double vote, window edges.

### Stage B — executors (per kind, separate PRs)

- [ ] `fee_param` writer that only applies allow-listed keys.
- [ ] `listing` via contracts/events to trade — never SQL into trade tables from token.
- [ ] `curriculum` to academy.
- [ ] `grant` ledger recipe + failure tests.

### Stage C — chain handover (this row’s name)

- [ ] Documented list of chain parameters under governance.
- [ ] Path from passed proposal → chain config change (governance module / multi-sig retirement schedule).
- [ ] Validators open path consistent with `chain.validators` schedule.

**Tracker `done` for `chain.governance`:** Stage C with real chain + working outcome path. Stage A alone is `token.governance` residual, not this mountain.

---

## 7 · Gaps

1. No outcome writer anywhere in repo.
2. No chain to hand over.
3. No cross-service executor design approved.
4. No published quorum numbers.
5. `chain.validators` / `chain.mainnet` unfinished.

---

## 8 · Risks

| Risk                               | Why                                            |
| ---------------------------------- | ---------------------------------------------- |
| Invent quorum in a “helpful” PR    | Product law violation; false decentralisation  |
| Status flip without execute        | Users vote believing it decides money/listings |
| grant without Class M              | Doctrine §0.6 break                            |
| Agents dual-building token + chain | Wrong ownership; babysit Shehzad on chain half |
| Class X keys in agent hands        | Forbidden                                      |

---

## 9 · Estimated size

| Slice                                   | Size           | Notes                        |
| --------------------------------------- | -------------- | ---------------------------- |
| Parameter list doc (this pack accuracy) | **XS** Class N | Agents OK                    |
| token.governance outcome engine         | **M**          | Owner numbers required first |
| Per-kind executors                      | **M each**     | One service per PR           |
| Chain param module + handover           | **L–XL**       | After validators             |
| Full progressive decentralisation       | **Program**    | Phase 5P                     |

**First honest slice after law:** document parameter list + executing plane per kind; keep socket until Denon/Shehzad set numbers. Optional Class N: keep `token.governance` tracker note accurate (already corrected).

---

## 10 · Related docs / code

- Tracker note on `token.governance` in `tooling/tracker/features.mjs` (long honesty note)
- `services/svc-token/src/token-service.ts` — ballot
- `services/svc-token/drizzle/0000_token_init.sql` — schema
- `INTAFACED_DEFINITIVE_BUILD.md` §4.3, §17.2 P3, §21 5P
- `docs/ops/trk/chain.validators.md`, `chain.mainnet.md`

---

## 11 · Explicit non-goals

- No inventing quorum, thresholds, or grant amounts.
- No implement of outcome engine under chain.governance id alone without token mountain event.
- No marking chain.governance done while chain.mainnet vapor.
- No R07/R01 stamp content.
- No futures/OTC law.
