# 04-CRITIC-B01 — adversarial review of bank shortfall “fix”

**Subject:** B-01 mitigation in `services/svc-bank/src/loans/loan-service.ts`  
**Stance:** assume the fix is wrong until proven.  
**Sources:** `03-BANK-202.md` finding B-01; `outstanding()` ~351–389; `markAndAct` ~1023–1097; `liquidateTranche` / `coverShortfallTranche` / `coverOpenShortfalls` ~1180–1338; `repay` ~816–894; `loanBadDebt` recipe; WAVE claim in `WAVE-AUDIT-RESULT.md`.

---

## VERDICT

**DOWNGRADE**

- Original **HIGH** money-book hole (outstanding can go to zero after settle without insurance) is **closed** by the SQL gate.
- This is **not** a complete fix of B-01 as written. Not atomic. Recovery path incomplete. Required service test absent. WAVE “fixed this fire” / “CONDITIONAL → fixed B-01” is **overclaim**.
- Residual integrity/ops class: **MED** (not clean ACCEPT; not full REJECT of the core patch).

---

## What the patch actually does

| Change                                                                                | Intent                                             |
| ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `outstanding()` CASE: count `shortfall` only when `bad_debt_ledger_tx_id IS NOT NULL` | Stop debt book zeroing on liquidate settle alone   |
| `coverShortfallTranche`                                                               | Post `loanBadDebt` + stamp `bad_debt_ledger_tx_id` |
| `coverOpenShortfalls` at start of `markAndAct`                                        | Re-drive unsettled insurance on later sweeps       |

Finding allowed **(a)** one ledger tx **or** **(b)** don’t settle / don’t apply shortfall until insurance + re-drive + **service failure test**.

Delivered: **partial (b)** only (gate + re-drive). Liquidation still **settles** with shortfall written and `bad_debt_ledger_tx_id` null. **No service failure test.**

---

## Attacks against “fixed”

### 1. Named HIGH path — mitigated (do not re-open as HIGH)

**Before:** settle liquidate → fail insurance → `outstanding` subtracted full shortfall → next sweep `debt.total <= 0` → clear without charging insurance.

**After:** shortfall stays in outstanding until stamp; `coverOpenShortfalls` runs before the zero-debt clear; failed cover throws into sweep `refused` (loud, not silent clear).

Core B-01 money-book failure mode is addressed.

### 2. Still not atomic — residual by design

`loanLiquidate` and `loanBadDebt` remain two posts. Crash / fund gap between them still leaves: collateral sold, reserve short, insurance not moved, loan mid-state.

Finding accepted (b) as alternative to (a). Incomplete (b) is the issue, not “two posts exist.”

### 3. Status machine breaks on the failure path — residual MED

On insurance fail, `coverShortfallTranche` throws **after** liquidate settle and **before** the post-cover status block (`liquidated` / `margin_call` / `closed_at`).

Loan stays **`liquidating`**.

On a later sweep where insurance **succeeds** via `coverOpenShortfalls`:

```text
coverOpenShortfalls → outstanding may hit 0
→ markAndAct only clears margin_called_at
→ does NOT set status = liquidated, does NOT set closed_at
```

Terminal book can be: **zero debt, status forever `liquidating`**. Ops and any status-based filter lie. Re-drive fixed money, not lifecycle.

### 4. `repay` still allowed in `liquidating` — residual MED

`repay` blocks only `repaid` / `liquidated` / `pending`. While shortfall is still in outstanding (insurance open):

- Borrower can repay the “phantom” shortfall amount → status **`repaid`**, leaves sweep set (`active|margin_call|liquidating` only).
- Open shortfall row can remain with `bad_debt_ledger_tx_id IS NULL` forever (orphaned loss record; reserve may be whole via borrower — economic OK, audit trail incomplete).
- Race with `coverOpenShortfalls`: insurance **and** repay both fund the shortfall → reserve **over-funded**, borrower charged for a loss insurance also paid.

Gate closed the silent zero; it opened a dual-cover / orphan-row surface the patch does not address.

### 5. Re-drive is sweep-coupled only

`coverOpenShortfalls` runs only inside `markAndAct` (risk sweep). No repay-path, ops, or standalone job redrive. Loan that leaves the sweep set (e.g. borrower repay → `repaid`) never retries insurance. Acceptable only if product accepts “borrower may voluntarily fund bad debt instead of insurance.”

### 6. Required proof missing — process fail

`03-BANK-202` fix direction: **Add service failure test.**  
`loans.test.ts`: still recipe-only bad debt; **no** service case for empty insurance after settle, stuck `liquidating`, or re-drive success/fail. B-04 still lets the whole service suite skip. Claiming “fixed” without the mandated proof is false-done.

### 7. Adjacent ladder hole (not introduced, still live after re-drive)

Closing sale can leave **interest** unpaid while principal shortfall is what insurance covers. After delayed cover, residual interest + **zero collateral** → `planLiquidation` returns `action: 'none'` (nothing to sell) → `markAndAct` may treat margin-called loan as **cured** (`active`). Pre-existing shape; re-drive makes delayed entry into that state more reachable. Not the original B-01, still not fail-closed for unsecured remainder.

### 8. Crash between `loanBadDebt` post and column stamp

Money is ledger-idempotent (`bank.loan.baddebt:${loanId}`); re-drive can stamp later. OK for money if ledger always returns original id. Not claim/post/`drivenPost`-shaped; weaker than other bank money paths.

---

## What REJECT would require (not met)

Full REJECT would mean the HIGH zero-without-insurance path still works. It does **not** under the new SQL: shortfall is not applied without `bad_debt_ledger_tx_id`.

## What ACCEPT would require (not met)

- Either (a) single ledger tx for liquidate+insurance, **or** full (b) including not treating the shortfall as economically closed while stamp missing **and** correct terminal status on delayed cover
- Block or serialize repay against open uncovered shortfalls
- Service test: settle liquidate → empty insurance → outstanding still > 0 → re-drive posts or stays loud; no silent clear; status ends in a defined terminal
- WAVE wording: mitigated / residual MED, not “fixed”

---

## Residual register (post-critic)

| ID          | Sev         | Title                                                                        |
| ----------- | ----------- | ---------------------------------------------------------------------------- |
| **B-01-R1** | **MED**     | Delayed insurance success leaves `liquidating` + no `closed_at`              |
| **B-01-R2** | **MED**     | `repay` during open shortfall: orphan stamp and/or double cover vs insurance |
| **B-01-R3** | **MED**     | No service failure/re-drive test; suite still skippable (B-04)               |
| **B-01-R4** | **LOW**     | Two-phase posts remain; re-drive sweep-only                                  |
| **B-01-R5** | **LOW/MED** | Zero-collateral residual interest can false-cure after re-drive (adjacent)   |

Original **B-01 HIGH** book-zero hole: **closed**. Severity of the open set: **MED** cluster, not green.

---

## Decision

**DOWNGRADE** — accept the SQL gate + re-drive as a **partial mitigation** of HIGH B-01; **reject** the claim that B-01 is done; carry **B-01-R1..R3** before any unconditional bank loans PASS.

**Do not** treat WAVE-AUDIT-RESULT “fixed B-01” as critic-approved without R1–R3.

**Path:** `/Users/Nitro/projects/Sovereign/.worktrees/audit-denon-wave-deep/docs/audit/2026-07-31-denon-wave-deep/04-CRITIC-B01.md`
