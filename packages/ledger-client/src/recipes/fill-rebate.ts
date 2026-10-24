import { mulBps, type Amount } from '../money.js';
import type { EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { houseFees, userAvailable } from '../accounts.js';
import type { TradeFillInput } from './index.js';

/**
 * A maker rebate (SP-fees-vip-01). It is never a negative fee inside `trade.fill`: it is its own post under
 * `trade.fill.rebate:<fillId>`, from `houseFees('trade', <asset>)` to the maker, so every reader that knows a fill by
 * its `trade.fill` legs (history fee, holdings, tax lots) reads the fill itself exactly as before.
 *
 * It takes the same input as the fill it rebates, so the asset and amount cannot drift from that fill: it is paid in
 * the asset the maker paid, which is the asset the taker's fee was taken in on that same fill, and it must be below
 * that fee. The maker fee must be 0. It rounds down (the taker fee rounds up), so the house never pays out more than
 * the fill brought in. svc-ledger's door checks the same against the posted `trade.fill:<fillId>` before it books
 * one (`maker-rebate-binding.ts`). The caller posts it right after the fill, with the rate stored on the fill, and
 * re-posts both on a retry; each key posts once.
 *
 * Readers that list fill reasons do not know `trade.fill.rebate` yet: it is its own line with no order id on the
 * ledger history, and svc-tax counts it as an inflow from outside the lot book until it learns the reason.
 */
export interface TradeFillMakerRebateInput extends TradeFillInput {
  makerRebateBps: number;
}

export interface MakerRebate {
  /** The asset the maker paid on the fill. */
  readonly assetId: string;
  /** Rounded down; `0n` means the rate rounds to nothing on this fill and nothing is posted. */
  readonly amount: Amount;
}

type RebateAccount = ReturnType<typeof houseFees> | ReturnType<typeof userAvailable>;
const debit = (account: RebateAccount, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: RebateAccount, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requireBps(label: string, bps: number): void {
  if (!Number.isInteger(bps) || bps < 0) throw new InvalidEntryError(`${label} must be a whole number of bps, got ${bps}`);
}

/** The rebate a fill earns, refusing a rate the fill's own taker fee cannot pay. Posts nothing. */
export function makerRebateFor(input: TradeFillMakerRebateInput): MakerRebate {
  requireBps('makerRebateBps', input.makerRebateBps);
  requireBps('takerFeeBps', input.takerFeeBps);
  requireBps('makerFeeBps', input.makerFeeBps);
  if (input.makerRebateBps === 0) throw new InvalidEntryError('A maker rebate of 0 bps is no rebate');
  if (input.makerFeeBps !== 0) throw new InvalidEntryError('A maker rebate needs a maker fee of 0 bps');
  // floor(a·r) < ceil(a·t) whenever r < t and a > 0, so the rate check alone keeps the rebate below the taker fee.
  if (input.makerRebateBps >= input.takerFeeBps) {
    throw new InvalidEntryError('A maker rebate must be below the taker fee on the same fill');
  }
  if (input.qty <= 0n || input.quoteAmount <= 0n) throw new InvalidEntryError('fill qty and quote amount must be positive');
  const takerBuys = input.takerSide === 'buy';
  return {
    assetId: takerBuys ? input.baseAsset : input.quoteAsset,
    amount: mulBps(takerBuys ? input.qty : input.quoteAmount, input.makerRebateBps, 'floor'),
  };
}

export function tradeFillMakerRebate(input: TradeFillMakerRebateInput): PostRequest {
  // The fill's own id, as `tradeFill` keys it: a padded id would name another fill.
  const fillId = input.fillId ?? '';
  if (!fillId.trim() || fillId.trim() !== fillId) throw new InvalidEntryError('fillId is required, with no surrounding spaces');
  if (!input.makerId?.trim()) throw new InvalidEntryError('makerId is required');
  const rebate = makerRebateFor(input);
  if (rebate.amount <= 0n) throw new InvalidEntryError('This maker rebate rounds to nothing on this fill; post none');

  return {
    idempotencyKey: `trade.fill.rebate:${fillId}`,
    module: 'trade',
    reason: 'trade.fill.rebate',
    meta: {
      fillId,
      makerOrderId: input.makerOrderId,
      makerRebateBps: input.makerRebateBps,
      takerFeeBps: input.takerFeeBps,
      makerRebate: rebate.amount.toString(),
    },
    entries: [
      credit(houseFees('trade', rebate.assetId), rebate.amount),
      debit(userAvailable(input.makerId, rebate.assetId), rebate.amount),
    ],
  };
}
