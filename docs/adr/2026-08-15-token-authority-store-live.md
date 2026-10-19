# ADR: token authority store live — seeds fail-closed; claim-before-burn (D26-P0-04)

**Status:** **Accepted — 2026-08-15 (D26-P0-04 sealed as a dedicated authority ADR).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` (removed) **D26-P0-04**.  
**Cites (does not replace):** [`2026-08-04-token-economics-outcomes.md`](2026-08-04-token-economics-outcomes.md) — whose the numbers are, and the irreversible-burn defect.  
**Does not invent:** emission, buyback, burn, or staking **magnitudes** — those stay **PKT-C9 / Nitro**.  
**Does not edit:** `services/svc-token` (promise-falsify / remaining implement = **D26-P2-01g**). No Vue. No Shehzad chain.

---

## The decision

> **Once `token.token_params` is populated, it is the only live source for emission and buyback parameters. A TypeScript constant is a seed, never a commitment. A burn that would run on seed-only params is refused. Claim the revenue window first, then post the burn — never burn-then-guard.**

This is settled. Agents implement it; they do not pick a cap, an epoch reward, a buyback bps, or a burn split.

Parent ADR already decided **whose** the numbers are and **that** claim-before-burn is the fix that needs no economic number. This ADR answers the leftover P0-04 questions: **when** the store is the only source, **what fails closed** if seeds ≠ DB, and **which drift guards are named**.

---

## When the store is the only live source

| Store state                                                                           | Live source                        | Burn / mint that sizes from params                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| Singleton `token_params` row present and readable                                     | **That row only**                  | Allowed only after claim-before-burn (and other refuse cases below) |
| Row missing, unreadable, or invalid (`token.params_missing` / `token.params_invalid`) | **None**                           | **Fail-closed.** Never fall back to `economics/*.ts`                |
| Tests with `loadParamsFromDb: false`                                                  | Explicit test overrides, not seeds | Test fixture only — not a production path                           |

**Populated** means the singleton row exists. The migration INSERT that first fills it is how the store gets a row; it is **not** licence to treat source constants as live. Boot stays `loadParamsFromDb: true`.

**Seed-only burn refused:** production `recordBuyback` (and any path that posts `recipes.burn`) must size from `buybackParams()` / the store. Using `DEFAULT_*` from `economics/*.ts` as the live split is a doctrine fail, even if those constants happen to match a later owner click.

---

## Named drift guards

These are the named guards. They decide **no** magnitude. Inventing a fifth “nice default” to make two copies agree is the silent-resolution hole the parent ADR forbids.

| Guard                                 | What it watches                                                                        | Fail closed                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Runtime store read**                | `token_params` singleton on boot/read (`token.params_missing`, `token.params_invalid`) | Missing/invalid row — never seed fallback                                                            |
| **Fee-ladder agreement**              | `economics/staking.ts` ↔ migration fee-discount schedule                               | Any new disagreement fails the test                                                                  |
| **Pinned emission/buyback inventory** | Hand-pinned set: `initialEpochReward`, `maxSupply`, `buybackBps`, `burnSplitBps`       | Changing either copy, adding a fifth drifted param, or “fixing” a pinned row by copying values fails |
| **New-drift / silent-resolution**     | Parent ADR correction 2026-08-04                                                       | New disagreement or a change to an existing one fails the build; the four known rows stay pinned     |
| **Claim-before-burn + overlap**       | Revenue window `[from, to)` claimed **before** `recipes.burn`                          | Overlap / spent window → `token.buyback_window_overlap` (or run conflict) **with no burn posted**    |
| **Mint-funded “buyback”**             | Parent ADR: a burn funded by mint is not a buyback                                     | Refuse to describe or surface it as buyback until funding is provably fee revenue                    |

User-facing supply, burn total, APY, or fee-% stays **unset** until Nitro writes magnitudes into the store (PKT-C9). Never a zero, never a dash, never a plausible figure from a seed file.

---

## Claim-before-burn (the irreversible-leg rule)

Parent ADR reproduced the defect: burn posted first, window unique-index fired after, tokens in the burn account with no run row.

**Rule:**

1. Validate the window (half-open `[from, to)`, non-empty) and a positive `tokensBought`.
2. **Claim** the window (`token.buyback_runs` pending insert + exclusion on overlapping ranges).
3. **Then** post the ledger burn (idempotent on `runId`).
4. **Then** settle the run.

A crash between claim and settle leaves a recoverable `pending` row. A crash after burn-before-claim left irreversible value and a 500. Exact retries of a settled `runId` return the book row and **never re-post**.

Overlap policy is **not** an economic number: no two windows overlap; bounds are half-open `[from, to)`. Window **length, cadence, and gaplessness** remain PKT-C9 / Nitro.

Tip already follows this order (`recordBuybackInner` → `claimBuybackWindow` → post → settle). This ADR forbids reverting it. Further promise-falsify of crash windows stays **D26-P2-01g** and must not dual-edit this docs PR.

---

## What this seal does not do

- Publish or choose `initialEpochReward`, `maxSupply`, `buybackBps`, `burnSplitBps`, ACCESS_TIERS, lock multipliers, or the mining-vs-governance split.
- Close `token.emissions` / `token.buyback` tracker rows as product-complete.
- Touch `services/svc-token`, Vue, or Shehzad protocol/INTACHAIN.

---

## What agents may do after this seal (without asking again)

- Keep claim-before-burn; refuse seed fallback; keep the named guards green.
- Wire disclosures that figures are unset.
- D26-P2-01g crash-window falsify **in its own PR**, path `services/svc-token` only.

Stop and ask (Nitro / PKT-C9) for any economic number.
