import { add, compare, mul, sub as minus, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * The loss in `asset` the venue's fills come to: their realised results less every fee, as a positive amount; zero when
 * they come to a gain. A fee in another asset (a spot buy's fee in the base asset) is valued at the fill's price.
 * Unrealised results on open positions are not counted. Shared by an agent account's daily-loss cap (agent-orders.ts #18)
 * and the person's own daily loss limit (daily-loss-limit.ts).
 */
export function dailyLossOf(
  fills: readonly {
    readonly price: Amount;
    readonly venueFee: Amount;
    readonly builderFee: Amount;
    readonly feeAsset: string;
    readonly realisedPnl: Amount | null;
  }[],
  asset: string,
): Amount {
  let result = ZERO;
  for (const f of fills) {
    if (f.realisedPnl !== null) result = add(result, f.realisedPnl);
    const fees = add(f.venueFee, f.builderFee);
    result = minus(result, f.feeAsset === asset ? fees : mul(fees, f.price, 'ceil'));
  }
  return compare(result, ZERO) < 0 ? minus(ZERO, result) : ZERO;
}

/** 00:00 UTC of `now`'s day: where "today's" loss starts. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** 00:00 UTC of the day after `startOfDay`: when today's loss starts again from zero. */
export function nextUtcDay(startOfDay: Date): Date {
  return new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
}
