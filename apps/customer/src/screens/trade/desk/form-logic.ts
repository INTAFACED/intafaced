/**
 * The order form's decisions, apart from React so they can be tested: when the Buy or Sell button may be pressed and
 * why not, whether the service's hold is more than the person has, what a percent chip or Max asks for, and the
 * fee rate the form shows. The service stays the authority; this only stops what it would refuse, in plain words,
 * before anything is sent.
 */
import { SCALE } from '@intafaced/ledger-client/money';
import type { Preview } from '../../../features/trade/trade-api';
import { formatAmount } from '../../../shared/money';
import { exitSideOff, maxAmount, portionOf, scaled, type OrderType, type Side } from './order-math';

/** A basis-point count as the ratio string the percent formatter reads: 10 bps is "0.001". */
export const bpsToRatio = (bps: number): string => formatAmount((BigInt(bps) * SCALE) / 10_000n);

/**
 * Market sells are off: the service's preview gives no fee for them, and a market sell has no price
 * floor, which is a risk decision for the owner. Limit sells are unaffected.
 */
export const marketSellOff = (side: Side, type: OrderType): boolean => side === 'sell' && type === 'market';

/** True when the service's hold, in the asset this side spends, is more than the free balance. Unknown is not short. */
export function holdShort(preview: Pick<Preview, 'holdAsset' | 'holdAmount'>, spendAsset: string, available: string | null): boolean {
  if (preview.holdAsset !== spendAsset) return false;
  const hold = scaled(preview.holdAmount);
  const free = scaled(available);
  return hold !== null && free !== null && hold > free;
}

export type LiveState = 'idle' | 'checking' | 'ok' | 'blocked' | 'error';
export type GateReason =
  'signedOut' | 'closed' | 'pending' | 'marketSell' | 'exitSide' | 'invalid' | 'checking' | 'refused' | 'error' | 'short' | null;

/**
 * May the person press Buy or Sell now? Only when signed in, the market is open, no earlier order is unconfirmed, the
 * form passes the market's rules, and the service's own preview came back orderable and within the balance.
 * `reason` says which condition stopped it (null when it can go).
 */
export function gateSubmit(args: {
  signedIn: boolean;
  marketOpen: boolean;
  pending: boolean;
  side: Side;
  type: OrderType;
  checkedOk: boolean;
  live: LiveState;
  short: boolean;
  busy: boolean;
}): { canSend: boolean; reason: GateReason } {
  const reason: GateReason = !args.signedIn
    ? 'signedOut'
    : !args.marketOpen
      ? 'closed'
      : marketSellOff(args.side, args.type)
        ? 'marketSell'
        : exitSideOff(args.side, args.type)
          ? 'exitSide'
          : args.pending
            ? 'pending'
            : !args.checkedOk
              ? 'invalid'
              : args.live === 'checking' || args.live === 'idle'
                ? 'checking'
                : args.live === 'blocked'
                  ? 'refused'
                  : args.live === 'error'
                    ? 'error'
                    : args.short
                      ? 'short'
                      : null;
  return { canSend: reason === null && !args.busy, reason };
}

/** The fee line: the rate from the service's preview ("up to": the service labels every non-resting order a taker), or null. */
export function feeRate(preview: Pick<Preview, 'feeBps'> | null): string | null {
  return preview && preview.feeBps !== null ? bpsToRatio(preview.feeBps) : null;
}

/** The fee line of each exit leg the service priced (take-profit as maker, stop-loss as taker); empty for a plain order. */
export function exitFeeLines(
  preview: Pick<Preview, 'exitFees'>,
): Array<{ leg: 'takeProfit' | 'stopLoss'; fee: string; asset: string; ratio: string }> {
  const exit = preview.exitFees;
  if (!exit) return [];
  return (['takeProfit', 'stopLoss'] as const).map((leg) => ({
    leg,
    fee: exit[leg].estimatedFee,
    asset: exit[leg].feeAsset,
    ratio: bpsToRatio(exit[leg].feeBps),
  }));
}

/**
 * What a percent chip or Max puts in the Amount field. Null when the balance or (for a buy) the price is unknown,
 * or when the portion would be under one lot. `needsPrice` tells the form to ask for a price first.
 */
export function sizeFor(args: {
  side: Side;
  type: OrderType;
  price: string;
  available: string | null;
  lotSize: string;
  protectionPrice: string | null;
  stopLimit?: string;
  percent: 25 | 50 | 75 | 100;
}): { amount: string | null; needsPrice: boolean } {
  const max = maxAmount({
    side: args.side,
    type: args.type,
    price: args.price,
    available: args.available,
    market: { lotSize: args.lotSize },
    protectionPrice: args.protectionPrice,
    stopLimit: args.stopLimit,
  });
  if (max === null) return { amount: null, needsPrice: args.available !== null };
  return { amount: portionOf(max, args.percent, args.lotSize), needsPrice: false };
}
