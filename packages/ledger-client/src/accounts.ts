import type { AccountRef } from './types.js';

/**
 * Well-known account constructors.
 *
 * Recipes never spell out an `AccountRef` inline. Every account in the OS is
 * named here, once, so "where does the fee go" has exactly one answer and
 * `grep` finds every module that touches a given pot.
 */

export function userAvailable(userId: string, assetId: string): AccountRef {
  return { ownerType: 'user', ownerId: userId, assetId, kind: 'available' };
}

/**
 * A user's held balance FOR ONE PURPOSE (P0-3).
 *
 * The purpose is required, and that is the whole point. There was previously
 * one `hold` account per (user, asset), so a withdrawal settle and an open
 * order's reservation drew on the same balance — and neither could tell that it
 * had lost to the other, because the books recorded no distinction to lose.
 *
 * Prefer the named constructors below. Reaching for this directly means
 * inventing a purpose string, which is worth having to justify.
 */
export function userHold(userId: string, assetId: string, purpose: string): AccountRef {
  if (!purpose?.trim()) throw new Error('userHold requires a purpose (P0-3) — e.g. `order:<id>` or `withdraw:<id>`');
  return { ownerType: 'user', ownerId: userId, assetId, kind: 'hold', purpose: purpose.trim() };
}

/** Value reserved for one open order. Drawn down on fill, returned on cancel or expiry. */
export function orderHoldAccount(userId: string, assetId: string, orderId: string): AccountRef {
  return userHold(userId, assetId, `order:${orderId}`);
}

/** Value held while one withdrawal is in flight at a rail. */
export function withdrawalHoldAccount(userId: string, assetId: string, withdrawalId: string): AccountRef {
  return userHold(userId, assetId, `withdraw:${withdrawalId}`);
}

/**
 * Seller escrow FOR ONE TRADE (L3-4). Same failure class as unpurposed holds:
 * one pot per (user, asset) lets trade B fund trade A's release.
 */
export function userEscrow(userId: string, assetId: string, purpose: string): AccountRef {
  if (!purpose?.trim()) throw new Error('userEscrow requires a purpose (L3-4) — e.g. `trade:<id>`');
  return { ownerType: 'user', ownerId: userId, assetId, kind: 'escrow', purpose: purpose.trim() };
}

/** Escrow pot for one P2P trade. */
export function tradeEscrowAccount(sellerId: string, assetId: string, tradeId: string): AccountRef {
  return userEscrow(sellerId, assetId, `trade:${tradeId}`);
}

/**
 * User stake FOR ONE CLAIM (L1 dual-book / L3-5). Token stakes and bank earn
 * positions must not share a pot or each other's principal.
 */
export function userStake(userId: string, assetId: string, purpose: string): AccountRef {
  if (!purpose?.trim()) throw new Error('userStake requires a purpose (L1/L3-5) — e.g. `token:stake:<id>` or `bank:earn:<id>`');
  return { ownerType: 'user', ownerId: userId, assetId, kind: 'stake', purpose: purpose.trim() };
}

/** Token staking pot for one stake row. */
export function tokenStakeAccount(userId: string, assetId: string, stakeId: string): AccountRef {
  return userStake(userId, assetId, `token:stake:${stakeId}`);
}

/** Bank earn pot for one position row. */
export function earnStakeAccount(userId: string, assetId: string, positionId: string): AccountRef {
  return userStake(userId, assetId, `bank:earn:${positionId}`);
}

/**
 * User collateral FOR ONE CLAIM (P0-3, extended to `collateral`).
 *
 * `client.ts` used to say "`collateral` remains open until a futures claim key
 * is designed". §8.1's loans ARE that claim, and the key is `loan:<id>`.
 *
 * Until this argument existed there was one collateral pot per (user, asset) —
 * the same failure the codebase has already fixed three times, for `hold`
 * (P0-3), `escrow` (L3-4) and `stake` (L1/L3-5). It is at its worst here.
 * Releasing loan A's collateral could hand back value that was securing loan B:
 * both postings balance, the journal reconciles, and loan B is quietly unsecured
 * with nothing in the books recording which lock was whose. The borrower then
 * owes on a position whose collateral has already walked out of the door.
 *
 * A borrower with a BTC-backed loan and an ETH-backed loan is not the
 * interesting case. A borrower with two BTC-backed loans is, and it is also the
 * common one.
 */
export function userCollateral(userId: string, assetId: string, purpose: string): AccountRef {
  if (!purpose?.trim()) throw new Error('userCollateral requires a purpose (P0-3) — e.g. `loan:<id>` or `position:<id>`');
  return { ownerType: 'user', ownerId: userId, assetId, kind: 'collateral', purpose: purpose.trim() };
}

/** Collateral securing ONE loan (§8.1). Released only when that loan is settled. */
export function loanCollateralAccount(userId: string, assetId: string, loanId: string): AccountRef {
  return userCollateral(userId, assetId, `loan:${loanId}`);
}

/**
 * Margin collateral securing ONE futures position (§5.2 / trade.futures).
 *
 * Purpose key is `position:<id>` — never share a pot across positions, or a
 * release on A quietly unsecures B (same failure mode as multi-loan collateral).
 */
export function positionCollateralAccount(userId: string, assetId: string, positionId: string): AccountRef {
  return userCollateral(userId, assetId, `position:${positionId}`);
}

/**
 * THE LENDING RESERVE (§8.1) — the pot loan principal is drawn FROM.
 *
 * The same discipline as `earnPoolReserve`, for the same reason: a loan must
 * lend value that exists. This is a `module` account, and §4.2's database CHECK
 * makes every non-treasury account hard non-negative — so an under-funded
 * reserve makes `loanDraw` fail with insufficient funds rather than conjuring
 * principal from nothing.
 *
 * The reconciliation identity this buys, checkable in one query each side:
 *
 *   balance(loanReserve) + Σ(outstanding principal) == Σ(reserve funding)
 *
 * A platform that instead credited the borrower against a `treasury` boundary
 * would be indistinguishable, in the book, from one that had printed the money.
 */
export function loanReserve(assetId: string): AccountRef {
  return moduleAccount('bank', 'loan-reserve', assetId);
}

/**
 * A sub-account's spendable balance — svc-bank's "spaces" read this.
 */
export function subAccountAvailable(subAccountId: string, assetId: string): AccountRef {
  return { ownerType: 'subaccount', ownerId: subAccountId, assetId, kind: 'available' };
}

/**
 * A sub-account hold FOR ONE PURPOSE (P0-3).
 *
 * Added when bank.business dual-control needed a real ledger hold on a named
 * space: over-threshold maker/checker must reserve value from the debit space,
 * which may be a named pot (`ownerType: 'subaccount'`), not only primary
 * `userAvailable`. Purpose is required — an unpurposed sub-account hold was
 * correctly refused forever; this constructor only exists so a named purpose
 * (e.g. `business-approval:<id>`) can pair with the same space's available pot.
 */
export function subAccountHold(subAccountId: string, assetId: string, purpose: string): AccountRef {
  if (!purpose?.trim()) {
    throw new Error('subAccountHold requires a purpose (P0-3) — e.g. `business-approval:<id>`');
  }
  return {
    ownerType: 'subaccount',
    ownerId: subAccountId,
    assetId,
    kind: 'hold',
    purpose: purpose.trim(),
  };
}

/** Sub-account collateral FOR ONE CLAIM. Same pairing rule as `userCollateral`. */
export function subAccountCollateral(subAccountId: string, assetId: string, purpose: string): AccountRef {
  if (!purpose?.trim()) {
    throw new Error('subAccountCollateral requires a purpose (P0-3) — e.g. `position:<id>`');
  }
  return {
    ownerType: 'subaccount',
    ownerId: subAccountId,
    assetId,
    kind: 'collateral',
    purpose: purpose.trim(),
  };
}

/** Margin collateral securing ONE futures position on a named sub-account. */
export function subAccountPositionCollateral(subAccountId: string, assetId: string, positionId: string): AccountRef {
  return subAccountCollateral(subAccountId, assetId, `position:${positionId}`);
}

/** Where a module's fee revenue lands. Staking yield is distributed from here (§4.3). */
export function houseFees(module: string, assetId: string): AccountRef {
  return { ownerType: 'house', ownerId: `fees:${module}`, assetId, kind: 'available' };
}

/** Futures insurance fund backstop (§5.2). */
export function insuranceFund(assetId: string): AccountRef {
  return { ownerType: 'house', ownerId: 'insurance-fund', assetId, kind: 'available' };
}

/**
 * The futures clearing pot. Every realised loss pays in and every realised
 * profit is paid out (docs/adr/2026-10-20-futures-matched-traders.md). Not
 * `houseFees('trade')` — a fee total is only fees. It is hard non-negative,
 * same as every other house pot. The account id keeps its old name.
 */
export function futuresLossSink(assetId: string): AccountRef {
  return { ownerType: 'house', ownerId: 'futures-loss', assetId, kind: 'available' };
}

/** Rewards engine — the pot real-yield and cashback are paid from. */
export function rewardsEngine(assetId: string): AccountRef {
  return { ownerType: 'house', ownerId: 'rewards-engine', assetId, kind: 'available' };
}

/** Burn address. Tokens debited here leave circulating supply, permanently. */
export function burnAccount(assetId: string): AccountRef {
  return { ownerType: 'house', ownerId: 'burn', assetId, kind: 'available' };
}

/** Internal market-maker account that seeds books at launch (§5.2). */
export function marketMaker(assetId: string): AccountRef {
  return { ownerType: 'house', ownerId: 'market-maker', assetId, kind: 'available' };
}

/** House hold FOR ONE PURPOSE (mm-bot order reservations). */
export function houseHold(ownerId: string, assetId: string, purpose: string): AccountRef {
  if (!purpose?.trim()) throw new Error('houseHold requires a purpose — e.g. `order:<id>`');
  return { ownerType: 'house', ownerId, assetId, kind: 'hold', purpose: purpose.trim() };
}

/** Market-maker reservation for one seed/open order. */
export function marketMakerOrderHoldAccount(assetId: string, orderId: string): AccountRef {
  return houseHold('market-maker', assetId, `order:${orderId}`);
}

/** A module's own working account (e.g. p2p dispute pool). */
export function moduleAccount(module: string, purpose: string, assetId: string): AccountRef {
  return { ownerType: 'module', ownerId: `${module}:${purpose}`, assetId, kind: 'available' };
}

/**
 * MERCHANT CLEARING (§6.1) — value captured from a payment rail that has not
 * yet been settled to the merchant.
 *
 * This account is the answer to "a payment was captured but not settled — whose
 * funds are those?". They are the merchant's, minus a fee not yet taken, and
 * they are sitting here: `sum(merchantClearing(m))` is exactly what svc-pay owes
 * merchant `m` right now, queryable without reading a single svc-pay table.
 *
 * It is per-merchant rather than one pooled clearing account precisely so that
 * question has a per-merchant answer. It is `module`-owned, not `user`-owned,
 * because the merchant cannot spend it until settlement runs — and `module`
 * accounts are hard non-negative, so a refund can never overdraw one merchant's
 * clearing into another's.
 */
export function merchantClearing(merchantId: string, assetId: string): AccountRef {
  return { ownerType: 'module', ownerId: `pay:clearing:${merchantId}`, assetId, kind: 'available' };
}

/**
 * MERCHANT PROCEEDS — settled net this merchant can pay out.
 *
 * Not the owner's trading balance. Card spend, bank transfer, and trade spend
 * `userAvailable`. This pot is named only by pay settlement, a settled refund,
 * the chargeback settled leg, and the payout trio. `merchantId` is the pay
 * merchant id, so two merchants of one person do not share it.
 *
 * `module` accounts are hard non-negative, so a payout cannot overdraw one
 * merchant into another's pot or into the owner's trading balance. The owner
 * id follows the clearing slug (`pay:proceeds:<uuid>`): a lowercase letter,
 * then colon-separated segments. A bare merchant UUID is not an owner id.
 */
export function merchantProceeds(merchantId: string, assetId: string): AccountRef {
  return { ownerType: 'module', ownerId: `pay:proceeds:${merchantId}`, assetId, kind: 'available' };
}

/**
 * One in-flight payout, funded from that merchant's proceeds.
 *
 * The hold sits on the proceeds owner. `assertPairedLocks` funds a hold only
 * from the same owner's available balance, so proceeds cannot be parked in
 * the user's withdrawal hold (where a personal `withdrawSettle` would send
 * them out).
 */
export function merchantProceedsPayoutHold(merchantId: string, assetId: string, withdrawalId: string): AccountRef {
  if (!withdrawalId?.trim()) throw new Error('merchantProceedsPayoutHold requires a withdrawalId — e.g. `<settlementId>:<attempt>`');
  return {
    ownerType: 'module',
    ownerId: `pay:proceeds:${merchantId}`,
    assetId,
    kind: 'hold',
    purpose: `payout:${withdrawalId.trim()}`,
  };
}

/**
 * Clearing reserved for one conversion attempt.
 *
 * Same owner as `merchantClearing`, so the hold is funded by that merchant's
 * own pot and no other conversion can spend it. Purpose is the conversion id.
 */
export function merchantClearingHold(merchantId: string, assetId: string, conversionId: string): AccountRef {
  if (!conversionId?.trim()) throw new Error('merchantClearingHold requires a conversion id');
  return {
    ownerType: 'module',
    ownerId: `pay:clearing:${merchantId}`,
    assetId,
    kind: 'hold',
    purpose: `conversion:${conversionId.trim()}`,
  };
}

/**
 * House inventory for a conversion fill the merchant does not keep.
 *
 * Treasury, not a house available pot: a below-minimum fill leaves USD at the
 * venue and restores the merchant from this account, so the USD side runs
 * negative by exactly the uncovered short. A house pot would refuse that post
 * and the only way to make the merchant whole would be to wipe the venue leg.
 * A negative balance here is that short, visible next to the venue boundary.
 */
export function conversionInventory(assetId: string): AccountRef {
  return { ownerType: 'treasury', ownerId: 'pay:fx-inventory', assetId, kind: 'available' };
}

/**
 * The yield reserve behind one svc-bank earn pool (§8.1).
 *
 * Interest is paid OUT of this account, which means a pool can only ever pay
 * what has actually been funded into it. The alternative — accruing interest as
 * a number in svc-bank and settling later — is a promise with no asset behind
 * it, and the ledger has no way to tell you it has been over-promised.
 *
 * A pool's outstanding yield capacity is therefore `balance(earnPoolReserve(…))`
 * and nothing else. It is a query, not an investigation.
 */
export function earnPoolReserve(poolId: string, assetId: string): AccountRef {
  return moduleAccount('bank', `earn:${poolId}`, assetId);
}

/**
 * THE BOUNDARY.
 *
 * `treasury` accounts are the seam between the book and the outside world: an
 * external rail, a chain, or the token mint. They are the only accounts allowed
 * to run negative, and a negative balance here is exactly the platform's
 * obligation to the outside — the number reconciliation checks against custody.
 */
export function railBoundary(rail: string, assetId: string): AccountRef {
  return { ownerType: 'treasury', ownerId: `rail:${rail}`, assetId, kind: 'available' };
}

/** Token mint boundary — svc-token is the only minter (§4.3). */
export function mintBoundary(assetId: string): AccountRef {
  return { ownerType: 'treasury', ownerId: 'mint', assetId, kind: 'available' };
}

/** Bridge boundary — Fiat Plane ↔ Protocol Plane (§17.5 svc-bridge). */
export function bridgeBoundary(chain: string, assetId: string): AccountRef {
  return { ownerType: 'treasury', ownerId: `bridge:${chain}`, assetId, kind: 'available' };
}

/**
 * External venue boundary — assets held at a third-party venue after a routed
 * fill (docs/TERMINAL.md §4).
 *
 * A negative balance here is exactly our custodial exposure at that venue.
 * Keeping it as its own boundary account means "how much of our users' value is
 * sitting somewhere we do not control" is a query, not an investigation.
 */
export function venueBoundary(venue: string, assetId: string): AccountRef {
  return { ownerType: 'treasury', ownerId: `venue:${venue}`, assetId, kind: 'available' };
}
