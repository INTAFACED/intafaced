/**
 * Liquidity maths (D-liquidity-02, -04, J-dex-protocol-12), in scaled bigint only. Each function mirrors one in
 * `contracts/liquidity/LiquidityRouter.sol` or `LiquidityPool.sol`, so a quote here is the figure the contract computes.
 * Nothing here reads a chain or moves anything.
 */

const FEE_DENOM = 10_000n;
const MINIMUM_LIQUIDITY = 1_000n;
/** Fixed-point scale for ratios (growth per share, price ratios). */
const ONE = 10n ** 18n;

/** Integer square root (floor), as the contracts' `_sqrt`. */
export function sqrt(y: bigint): bigint {
  if (y < 0n) throw new RangeError('sqrt of a negative');
  if (y < 4n) return y === 0n ? 0n : 1n;
  let z = y;
  let x = y / 2n + 1n;
  while (x < z) {
    z = x;
    x = (y / x + x) / 2n;
  }
  return z;
}

/** The pool's ratio of what was offered: all of one side and the matching part of the other (AMM-4, router `_optimal`). */
export function optimalPair(r0: bigint, r1: bigint, d0: bigint, d1: bigint): { amount0: bigint; amount1: bigint } {
  if (d0 <= 0n || d1 <= 0n) throw new RangeError('both amounts must be above zero');
  if (r0 === 0n && r1 === 0n) return { amount0: d0, amount1: d1 };
  const b = (d0 * r1) / r0;
  if (b <= d1) return { amount0: d0, amount1: b };
  return { amount0: (d1 * r0) / r1, amount1: d1 };
}

/** The shares a deposit of (a0, a1) mints at reserves (r0, r1) and supply `supply` (pool `mint`, router `_sharesAfter`). */
export function sharesFor(supply: bigint, r0: bigint, r1: bigint, a0: bigint, a1: bigint): bigint {
  if (supply === 0n) {
    const root = sqrt(a0 * a1);
    return root > MINIMUM_LIQUIDITY ? root - MINIMUM_LIQUIDITY : 0n;
  }
  const s0 = (a0 * supply) / r0;
  const s1 = (a1 * supply) / r1;
  return s0 < s1 ? s0 : s1;
}

/** The pool's swap output with the fee on the input (pool `_getAmountOut`). */
export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  const withFee = amountIn * (FEE_DENOM - BigInt(feeBps));
  return (withFee * reserveOut) / (reserveIn * FEE_DENOM + withFee);
}

/**
 * The part of `amountIn` swap-and-add swaps first (router `swapPart`):
 * s = (sqrt(r² (D+g)² + 4 g D a r) − r (D+g)) / (2 g), g = D − fee.
 */
export function swapPart(reserveIn: bigint, amountIn: bigint, feeBps: number): bigint {
  const g = FEE_DENOM - BigInt(feeBps);
  const dg = FEE_DENOM + g;
  const root = sqrt(reserveIn * reserveIn * dg * dg + 4n * g * FEE_DENOM * amountIn * reserveIn);
  return (root - reserveIn * dg) / (2n * g);
}

/** `amount` less `bps` of it, rounded down: the least a call accepts when the owner's slippage ceiling is `bps`. */
export function floorBy(amount: bigint, bps: number): bigint {
  return (amount * (FEE_DENOM - BigInt(bps))) / FEE_DENOM;
}

/** `part` as basis points of `whole`, rounded down; 0 when the whole is 0. */
export function bpsOf(part: bigint, whole: bigint): number {
  return whole === 0n ? 0 : Number((part * FEE_DENOM) / whole);
}

/**
 * The owner's fee tiers, `PROTOCOL_AMM_FEE_TIERS_BPS` ("5,30,100"): distinct whole bps from 0 to the 1000 cap, lowest
 * first. Blank is null (the list refuses `amm.fee_tiers_unset`). Anything else is not a list and refuses to start.
 */
export function parseFeeTiers(raw: string | undefined): number[] | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  const tiers = text.split(',').map((part) => part.trim());
  if (!tiers.every((part) => /^(0|[1-9][0-9]{0,3})$/.test(part) && Number(part) <= 1000))
    throw new Error('PROTOCOL_AMM_FEE_TIERS_BPS must be whole bps from 0 to 1000, comma-separated (blank offers only a custom fee)');
  return [...new Set(tiers.map(Number))].sort((a, b) => a - b);
}

/** One deposit the account made: the shares minted to it and the two amounts that went in. */
export interface EntryDeposit {
  shares: bigint;
  amount0: bigint;
  amount1: bigint;
}

/**
 * What an account put in, from its share history (oldest first). Known only when every share that ever came to it was
 * minted to it by a deposit; one share received from another address makes the entry unknown (null), since what that
 * sender paid is not this account's. Shares it sent or burned only lower what it still holds.
 */
export function entryOf(
  incoming: readonly { from: string; value: bigint; deposit: { amount0: bigint; amount1: bigint } | null }[],
): { shares: bigint; amount0: bigint; amount1: bigint; rootK: bigint } | null {
  let shares = 0n;
  let amount0 = 0n;
  let amount1 = 0n;
  let rootK = 0n;
  for (const transfer of incoming) {
    if (!/^0x0{40}$/i.test(transfer.from) || !transfer.deposit) return null;
    shares += transfer.value;
    amount0 += transfer.deposit.amount0;
    amount1 += transfer.deposit.amount1;
    rootK += sqrt(transfer.deposit.amount0 * transfer.deposit.amount1);
  }
  return shares === 0n ? null : { shares, amount0, amount1, rootK };
}

export interface PositionFigures {
  amount0: bigint;
  amount1: bigint;
  shareOfPoolBps: number;
  feesEarned: { amount0: bigint; amount1: bigint } | null;
  impermanentLoss: {
    held0: bigint;
    held1: bigint;
    now0: bigint;
    now1: bigint;
    diff0: bigint;
    diff1: bigint;
    valueHeld1: bigint;
    valueNow1: bigint;
    diffBps: number;
    closedFormBps: number;
  } | null;
}

/**
 * A position's figures at reserves (r0, r1) and supply `supply`: what its `shares` are worth now; with an entry, the
 * amounts holding would have now (the entry scaled to the shares still held), the difference, both valued in token1 at
 * the pool's price now, and the constant-product loss for the price move alone. Fees compound into the reserves, so
 * "fees earned" is the growth in √k per share since the deposits, applied to what the shares are worth now: an estimate.
 */
export function positionFigures(
  shares: bigint,
  supply: bigint,
  r0: bigint,
  r1: bigint,
  entry: { shares: bigint; amount0: bigint; amount1: bigint; rootK: bigint } | null,
): PositionFigures {
  const amount0 = supply === 0n ? 0n : (shares * r0) / supply;
  const amount1 = supply === 0n ? 0n : (shares * r1) / supply;
  const base = { amount0, amount1, shareOfPoolBps: bpsOf(shares, supply) };
  if (!entry || supply === 0n || r0 === 0n || entry.amount0 === 0n || entry.amount1 === 0n)
    return { ...base, feesEarned: null, impermanentLoss: null };

  // Growth of √k per share: now against the deposits'. Below 1 (rounding at the first deposit's locked shares) is none.
  const perShareNow = (sqrt(r0 * r1) * ONE) / supply;
  const perShareEntry = (entry.rootK * ONE) / entry.shares;
  const growth = perShareNow > perShareEntry ? perShareNow - perShareEntry : 0n;
  const feesEarned = { amount0: (amount0 * growth) / perShareNow, amount1: (amount1 * growth) / perShareNow };

  const held0 = (entry.amount0 * shares) / entry.shares;
  const held1 = (entry.amount1 * shares) / entry.shares;
  const valueHeld1 = (held0 * r1) / r0 + held1;
  const valueNow1 = (amount0 * r1) / r0 + amount1;
  const diffBps = valueHeld1 === 0n ? 0 : Number(((valueNow1 - valueHeld1) * FEE_DENOM) / valueHeld1);
  // r = price now / price at entry, token0 in token1; the loss 2√r / (1 + r) − 1.
  const ratio = (r1 * entry.amount0 * ONE) / (r0 * entry.amount1);
  const closed = (2n * sqrt(ratio * ONE) * ONE) / (ONE + ratio) - ONE;
  return {
    ...base,
    feesEarned,
    impermanentLoss: {
      held0,
      held1,
      now0: amount0,
      now1: amount1,
      diff0: amount0 - held0,
      diff1: amount1 - held1,
      valueHeld1,
      valueNow1,
      diffBps,
      closedFormBps: Number((closed * FEE_DENOM) / ONE),
    },
  };
}
