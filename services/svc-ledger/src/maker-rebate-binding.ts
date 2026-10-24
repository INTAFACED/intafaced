/**
 * A maker rebate is paid only against the fill it rebates (SP-fees-vip-01).
 *
 * The recipe gate knows a post by its shape, and house trade fees pool every fill's fees, so the shape alone would let
 * a caller pay any amount to any user out of other fills' fees. Here the door reads the posted `trade.fill:<fillId>`
 * and lets the rebate through only when it is that fill's maker, in the asset that maker paid from that order's hold,
 * at `floor(paid × makerRebateBps)` exactly, on a fill whose maker fee was 0 and whose taker rate was higher, and below
 * the fee that fill put in house trade fees in that asset. Anything else refuses before anything posts.
 */
import {
  LedgerError,
  houseFees,
  mulBps,
  orderHoldAccount,
  parseAmount,
  type AccountRef,
  type Balance,
  type LedgerTx,
} from '@intafaced/ledger-client';

export const MAKER_REBATE_UNBOUND_CODE = 'ledger.rebate_unbound';
export const MAKER_REBATE_REASON = 'trade.fill.rebate';

interface WireRebatePost {
  readonly idempotencyKey: string;
  readonly module: string;
  readonly reason: string;
  readonly entries: readonly {
    readonly account: { ownerType: string; ownerId?: string; assetId: string; kind: string; purpose?: string };
    readonly direction: string;
    readonly amount: string;
  }[];
  readonly meta?: Record<string, unknown>;
}

export interface RebateFillReader {
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
  balance(ref: AccountRef): Promise<Balance>;
}

function refuse(why: string): never {
  throw new LedgerError(`A maker rebate must match its posted trade fill: ${why}`, MAKER_REBATE_UNBOUND_CODE);
}

const wholeBps = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

export async function assertMakerRebateBound(ledger: RebateFillReader, input: WireRebatePost): Promise<void> {
  if (input.reason !== MAKER_REBATE_REASON) return;
  const meta = input.meta ?? {};
  const fillId = typeof meta.fillId === 'string' ? meta.fillId : '';
  const makerOrderId = typeof meta.makerOrderId === 'string' ? meta.makerOrderId : '';
  const rebateBps = meta.makerRebateBps;
  if (!fillId || input.idempotencyKey !== `${MAKER_REBATE_REASON}:${fillId}`) refuse('the key does not name its fill');
  if (!makerOrderId) refuse('no maker order');
  if (!wholeBps(rebateBps) || rebateBps === 0) refuse('no rebate rate');

  const house = input.entries.find((e) => e.account.ownerType === 'house');
  const maker = input.entries.find((e) => e.account.ownerType === 'user');
  if (input.entries.length !== 2 || !house || !maker) refuse('not the rebate shape');
  const assetId = house.account.assetId;
  const makerId = maker.account.ownerId ?? '';
  if (maker.account.assetId !== assetId || !makerId) refuse('the maker leg is in another asset');
  const amount = parseAmount(house.amount);

  const fill = await ledger.getTxByKey(`trade.fill:${fillId}`);
  if (!fill || fill.module !== 'trade' || fill.reason !== 'trade.fill') refuse('no posted fill');
  if (fill.meta.makerOrderId !== makerOrderId) refuse('another maker order');
  if (fill.meta.makerFeeBps !== 0) refuse('the maker paid a fee on this fill');
  const takerFeeBps = fill.meta.takerFeeBps;
  if (!wholeBps(takerFeeBps) || rebateBps >= takerFeeBps) refuse('the rate is not below the fill taker rate');

  const holdId = (await ledger.balance(orderHoldAccount(makerId, assetId, makerOrderId))).accountId;
  const paid = holdId ? fill.entries.find((e) => e.accountId === holdId && e.direction === 'credit') : undefined;
  if (!paid) refuse('this maker did not pay that asset from that order on the fill');
  const houseId = (await ledger.balance(houseFees('trade', assetId))).accountId;
  const fee = houseId ? fill.entries.find((e) => e.accountId === houseId && e.direction === 'debit') : undefined;
  if (!fee) refuse('the fill took no taker fee in that asset');

  if (amount !== mulBps(paid.amount, rebateBps, 'floor')) refuse('the amount is not the rate on what the maker paid');
  if (amount >= fee.amount) refuse('the rebate is not below the fill fee');
}
