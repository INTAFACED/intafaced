# 03-TOKEN-BANK-EARN — svc-token economics + svc-bank earn

**Scope:** backend money only — yield, buyback/burn, emission, stake; bank earn pools, deposit/withdraw, daily interest.  
**Worktree:** `.worktrees/audit-denon-wave-deep` (tip may lag; code read as-is).  
**Out of scope:** bank loans (#202 separate), spaces/transfers except shared patterns, frontend.

---

## Answers (required)

### 1. Money only via ledger-client recipes?

**YES for every value movement on both surfaces.**

#### svc-token

| Path                | Recipe                       | Evidence                   |
| ------------------- | ---------------------------- | -------------------------- |
| Stake               | `recipes.stake`              | `token-service.ts:183-191` |
| Unstake             | `recipes.unstake`            | `token-service.ts:358-366` |
| Fee → rewards sweep | `recipes.sweepFeesToRewards` | `token-service.ts:552-559` |
| Real-yield payout   | `recipes.rewardPay`          | `token-service.ts:618-626` |
| Burn leg of buyback | `recipes.burn`               | `token-service.ts:661-663` |
| Emission mint       | `recipes.mintEmission`       | `token-service.ts:753`     |

Pure maths (`buyback.ts`, `staking.ts`, `emission.ts`) never post. Service tables hold terms / claims / audit rows, not balances (`schema.ts:12-13`, `token-service.ts:23-28`).

#### svc-bank earn

| Path           | Recipe                 | Evidence                  |
| -------------- | ---------------------- | ------------------------- |
| Deposit        | `recipes.earnDeposit`  | `earn-service.ts:272-279` |
| Withdraw       | `recipes.earnWithdraw` | `earn-service.ts:369-376` |
| Fund reserve   | `recipes.earnPoolFund` | `earn-service.ts:192-199` |
| Daily interest | `recipes.earnInterest` | `earn-service.ts:480`     |

Reserve balance is a ledger read only (`earn-service.ts:206-208`). Interest is **not** minted (`interest.ts:21-25`, `earn-service.ts:31-34`).

**Not a balance (doctrine-consistent):** `earn_positions.principal` and `token.stakes.amount` are write-once open amounts (terms / audit), mirrored by purposed stake pots; both services test table-vs-ledger equality (`bank-service.test.ts` “earn principal … equals the ledger stake account”).

### 2. Money as `number` anywhere?

**NO for money amounts. Policy uses integer bps / counts.**

| Kind                           | Representation                                       | Evidence                                                                |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Stake/yield/burn/mint amounts  | `Amount` (bigint) via `parseAmount` / `formatAmount` | economics + services throughout                                         |
| Wire / SQL money               | decimal strings / `numeric`                          | routers `amountString`; `formatAmount(...)::numeric`                    |
| APR / multiplier / buyback bps | `number` integers                                    | `Number(row.apr_bps)`, `Number(s.multiplier_bps)` — rates, not balances |
| Fee schedule thresholds        | string → bigint; JSON numbers **rejected**           | `staking.ts:218-243`                                                    |
| Emission reward                | bigint right-shift                                   | `emission.ts:10-12`, `:83`                                              |

No `parseFloat` on production money paths. Test-only `parseFloat` in one yield comparison (`token-service.test.ts:391-394`) is assertion sugar, not runtime.

### 3. Auth on private paths?

**YES for user mutates and operator money jobs; S2S on internal jobs.**

#### svc-token

| Surface                                             | Guard                                              | Evidence                                     |
| --------------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `stake` / `unstake` / `listStakes`                  | `token:stake` / `token:read`; unstake `assertSelf` | `router.ts:190-246`                          |
| `stakeOf` / `accessOf`                              | self-only (`ctx.principal.userId`)                 | `router.ts:155-185`                          |
| Cross-user stake (S2S)                              | HMAC `GET /internal/stake/:userId`                 | `index.ts:66-72`                             |
| `distributeRevenue` / `recordBuyback` / `mintEpoch` | `admin:treasury` (+ MFA on interactive)            | `router.ts:250-355`; mount tests MFA refusal |
| Internal mint cron                                  | `verifyServiceHeaders`                             | `index.ts:81-84`                             |
| Edge                                                | `createEdgeContext` on `/trpc`                     | `index.ts:55`, `:126-132`                    |
| Outbound ledger                                     | **v2 body-bound** `serviceAuthHeadersForBody`      | `ledger-client.ts:39-53`                     |

#### svc-bank earn

| Surface                                   | Guard                                      | Evidence                 |
| ----------------------------------------- | ------------------------------------------ | ------------------------ |
| `earn.deposit`                            | `bank:write`; `userId` from principal only | `router.ts:367-379`      |
| `earn.withdraw`                           | `bank:write` + `assertSelf`                | `router.ts:382-391`      |
| `earn.pools` / `positions`                | `bank:read`                                | `router.ts:336-417`      |
| `ops.accrueInterest` / `fundPool`         | `admin:treasury`                           | `router.ts:710-742`      |
| Job `POST /internal/jobs/accrue-interest` | `verifyServiceHeaders`                     | `index.ts:112-122`       |
| Outbound ledger                           | **v1** `serviceAuthHeaders` (no body bind) | `ledger-client.ts:36-57` |

**Gap:** bank→ledger is still v1 while token→ledger is v2. Under ledger `accept-both` (default), bank signatures are replayable against any body for the skew window (`packages/contracts` service-auth L2-6; `svc-ledger/s2s-http.ts:146-158`).

### 4. False-done tests?

**PARTIAL — pure maths always run and are strong; service Postgres suites can skip green.**

| Area                                                     | Always runs?                                 | Quality                                                                | Gap                                                                |
| -------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Emission / buyback split / yield pro-rata / fee schedule | Yes (`economics.test.ts`)                    | Property-style, seed vs migration lock                                 | Live path does not read `token_params` buyback/emission (see T-02) |
| Interest pure (`dailyInterest` / `planAccrual`)          | Yes (inside bank suite file; pure describe)  | Flooring, dust, sort stability                                         | —                                                                  |
| Token service money (stake, yield, burn, mint)           | **Only if Postgres reachable**               | Strong: multi-stake yield bug, snapshot multiplier, dust, resume       | `describe.skip` when DB down (`token-service.test.ts:57-60`)       |
| Bank earn service                                        | Same pattern                                 | Deposit crash, underfunded pool, accrual idempotency, principal↔ledger | `describe.skip` (`bank-service.test.ts:74-77`)                     |
| Token router yield/buyback auth                          | Yes (stub service)                           | MFA + scope                                                            | Stub returns fixed burn split — does not prove ledger              |
| Bank earn router assertSelf on withdraw                  | **Not covered** in earn-specific mount cases | Transfer/space assertSelf tested                                       | Earn withdraw IDOR relies on pattern, not case                     |

---

## Path review summary

| Money path           | Ledger recipes only?      | Crash / retry model                                               | Fail-closed notes                                          |
| -------------------- | ------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| **Token stake**      | Yes                       | claim `pending` → post → `active`; delete pending on fail         | Idempotent key `token.stake:${id}`                         |
| **Token unstake**    | Yes                       | claim `unstaking` → post → `closed` (no FOR UPDATE across remote) | Lock check; concurrent close conflict                      |
| **Yield distribute** | Yes                       | per-(window,user) reward keys; sweep per (window,module,asset)    | Zero revenue refused; dust skipped; **no DB window claim** |
| **Buyback record**   | Burn only                 | burn key `token.burn:${runId}`; row `ON CONFLICT DO NOTHING`      | **Not a market buy**; operator supplies `tokensBought`     |
| **Emission mint**    | Yes                       | epoch closed + key `token.emission:${epoch}`                      | Cap check; `EMISSIONS_ENABLED`                             |
| **Earn deposit**     | Yes                       | `pending` → post → `active`; delete pending on fail               | Native asset refused                                       |
| **Earn withdraw**    | Yes                       | row lock in short txn + ledger post                               | Fixed-term lock; double-close refused                      |
| **Earn fund**        | Yes                       | `bank.earn.fund:${pool}:${fundingId}`                             | Operator only                                              |
| **Earn accrue**      | Yes (one tx for pool-day) | unique `(pool, date)` claim + ledger key                          | Underfunded → claim rolls back, re-runnable                |

---

## Findings table

| ID       | Sev      | Title                                                                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                      | Impact                                                                                                                                                                         | Fix direction                                                                                                                                                                                                                    |
| -------- | -------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-01** | **HIGH** | “Buyback” is operator burn-from-rewards, not structural buy-and-split of revenue       | `recordBuyback` takes caller `tokensBought`, burns `toBurn` from `rewardsEngine` only (`token-service.ts:648-664`). No trade/market recipe. `toRewards` is arithmetic only — **no ledger credit** of remainder (comment assumes funds already sit in rewards). `buybackBudget` never called on live path (only `economics.test.ts`). Schema claims tokens_to_rewards “sent to” rewards (`schema.ts:167-168`) — code does not. | Operator can invent bought size up to rewards balance; flywheel does not buy IFC or allocate revenue share per `token_params.buyback_bps`; double-spend of narrative vs books. | Phase-2: auto market-buy then single balanced post (buy + burn + rewards). Until then: load budget from params, require funding path into rewards, claim window row **before** burn, document operator trust as explicit socket. |
| **T-02** | **HIGH** | Governed `token_params` buyback/emission not driving live TokenService                 | Constructor injects `DEFAULT_BUYBACK_PARAMS` / `DEFAULT_EMISSION_PARAMS` (`index.ts:46-49`). Fee schedule **is** loaded from DB (`token-service.ts:498-511`). `buybackBps` / `burnSplitBps` / emission curve columns exist (`schema.ts:52-70`) but unused for mint/split.                                                                                                                                                     | Governance fee_param on buyback/emission is a no-op; redeploy is the real control; docs/tests about seed vs live diverge.                                                      | Read params (or cache like fee schedule) for mint + split; refuse missing/incoherent row; tests that flip DB row and assert live behaviour.                                                                                      |
| **T-03** | **MED**  | Yield window has no service-side claim; amounts are operator-supplied                  | `distributeRevenueInner` posts sweeps then shares with no `INSERT` claiming `windowId` (`token-service.ts:546-632`). Idempotency is ledger-only.                                                                                                                                                                                                                                                                              | Malicious/compromised treasury principal can under-sweep, invent window ids, or strand fees; no single “window closed” row for ops reconciliation.                             | Claim window row (sources + total) before posts; optionally read house fee balance rather than trusting input amount; status machine for partial resume.                                                                         |
| **T-04** | **MED**  | svc-bank ledger client still v1 (body unbound)                                         | `createLedgerClient` uses `serviceAuthHeaders` (`svc-bank/ledger-client.ts:36`); token uses `serviceAuthHeadersForBody` (`svc-token/ledger-client.ts:39`). Ledger defaults `accept-both` (`s2s-http.ts:112-120`).                                                                                                                                                                                                             | Captured bank S2S signature replayable as any earn deposit/interest post body for ~300s until fleet is on `require`.                                                           | Port token’s body-bind client; flip ledger to `require` when logs quiet.                                                                                                                                                         |
| **T-05** | **MED**  | Service Postgres suites skip entirely if DB down                                       | `token-service.test.ts:57-60`, `bank-service.test.ts:74-77` → `describe.skip` + dummy pass. Pure economics still run.                                                                                                                                                                                                                                                                                                         | CI green without stake/yield/earn crash-window proofs.                                                                                                                         | Fail CI when dedicated `TEST_DATABASE_URL_*` missing in pipeline; keep local skip optional.                                                                                                                                      |
| **T-06** | **MED**  | Fee discount basis: doctrine says balance, code says staked                            | Documented divergence (`staking.ts:156-161`, `:229-233`); only `staked` loads.                                                                                                                                                                                                                                                                                                                                                | Wrong economic surface if product expected liquid IFC discounts.                                                                                                               | Governance decision + implement or amend doctrine; do not silently switch.                                                                                                                                                       |
| **T-07** | **LOW**  | `mintEpoch` holds DB transaction across remote `ledger.post`                           | `mintEpochInner` `transaction` wraps SELECT FOR UPDATE + post + INSERT (`token-service.ts:735-764`).                                                                                                                                                                                                                                                                                                                          | Pool saturation / stuck epoch row under ledger latency; retry relies on epoch closed + idempotent mint.                                                                        | Claim-then-post pattern used for stake/unstake (short txn, then remote).                                                                                                                                                         |
| **T-08** | **LOW**  | No tRPC/create path for earn pools                                                     | `createPool` is service-only; router exposes list/deposit/withdraw only (`router.ts:336-417`).                                                                                                                                                                                                                                                                                                                                | Pools only via SQL/admin tooling; accidental open pools harder to audit through API.                                                                                           | Operator `admin:treasury` createPool with validation, or migration-seeded products.                                                                                                                                              |
| **T-09** | **LOW**  | Earn router ownership not case-tested                                                  | Transfer/space assertSelf tested (`bank-service.test.ts:1419+`); earn withdraw relies on `router.ts:387-388` only.                                                                                                                                                                                                                                                                                                            | Regression possible without failing suite.                                                                                                                                     | One IDOR case: B cannot withdraw A’s position.                                                                                                                                                                                   |
| **T-10** | **INFO** | Real yield pays **all** swept revenue to stakers; buyback is a separate burn pot story | After full distribute with stakers, rewards engine can be empty; buyback tests use distribute with **zero** stakes so funds remain (`token-service.test.ts:501-503`).                                                                                                                                                                                                                                                         | Ordering product risk: buyback after full yield starves burn; opposite order burns before stakers.                                                                             | Product rule: window split (buybackBudget then yield) as one job, not two independent operator calls.                                                                                                                            |
| **T-11** | **INFO** | IFC refused in bank earn; purpose keys separate stake pots                             | `assertEarnable` (`earn-service.ts:540-547`); L1 keys `bank:earn:` vs `token:stake:` in header comments.                                                                                                                                                                                                                                                                                                                      | Correct separation; schema comment still says shared `userStake` (`schema.ts:227-229`) — stale.                                                                                | Fix comment only.                                                                                                                                                                                                                |
| **T-12** | **INFO** | Accrual empty/dust day records paid=0, ledgerTxId=null                                 | `earn-service.ts:471-475`                                                                                                                                                                                                                                                                                                                                                                                                     | Intentional; day not reopened.                                                                                                                                                 | Ops must distinguish from underfunded (which rolls back claim).                                                                                                                                                                  |

---

## Pure maths notes (no ledger)

- **Emission:** era-sum clamp to maxSupply; halving is `>>`; exhausted when cap or zero reward (`emission.ts`).
- **Yield:** `proRata` so shares sum exactly to pool; multi-stake shares **summed per user** before `rewardPay` (partner-audit fix, `token-service.ts:588-599`).
- **Buyback split:** burn floors; residual to rewards side (`buyback.ts:77-88`) — conservation in pure function only.
- **Interest:** floor daily; aggregate per user; deterministic user sort (`interest.ts:64-83`).

---

## VERDICT

**CONDITIONAL PASS — ledger-only architecture and amount typing are solid on both earn and token money paths; two HIGH product/integrity holes on the IFC flywheel (operator buyback + unused governed params), plus bank S2S body-bind lag and skippable service tests.**

| Gate                                            | Result                                                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| Value moves only via recipes                    | **PASS**                                                 |
| Money never as JS `number`                      | **PASS**                                                 |
| User cannot move others’ positions / stakes     | **PASS** (earn withdraw assertSelf untested but present) |
| Operator jobs scoped                            | **PASS** (`admin:treasury` / service HMAC)               |
| Buyback/yield match §4.3 structural flywheel    | **FAIL** (T-01, T-02, T-10)                              |
| Earn interest real-revenue (funded reserve)     | **PASS**                                                 |
| Tests cannot false-green on money service paths | **FAIL** if CI lacks dedicated DBs (T-05)                |

**Ship bar for money-critical:** fix or explicitly socket T-01/T-02 before treating buyback/governance as live economics; upgrade bank ledger client to v2 (T-04); make token/bank service tests required in CI (T-05).

**Not a block for earn deposit/withdraw/accrual** as implemented: claim-before-post, underfunded fail-closed, dual idempotency, principal≠compounding balance.
)
