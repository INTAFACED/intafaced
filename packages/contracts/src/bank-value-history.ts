/**
 * BANK VALUE OVER TIME — what the customer's holdings were worth at each moment of a range, and the change-in-value
 * bridge between its two ends (J-portfolio-05 #6-#7). Browser-safe: zod only.
 *
 * `bank.portfolio.valueOverTime` replays the customer's holdings (main account and every named Space they have owned,
 * archived ones too, so a move from a closed Space cancels like any move between their own accounts) backwards from now with the ledger's movements, and values each moment at the close of the last candle that
 * had ended by then (USDT and USDC count as 1 USD, as the Money total does). A moment where a coin held then has no price
 * is missing: `valueUsd` null with the coin named, never zero.
 *
 * The bridge names where the change came from: `opening` + `deposits` − `withdrawals` − `fees` + `otherFlows` +
 * `marketMove` = `closing`, exactly. Deposits and withdrawals are what crossed the platform's edge; fees are trading
 * fees and fees charged; other flows are every other movement in or out of the customer's balances (transfers with other
 * people, payments, rewards, earn and staking), each valued when it happened. Trades are not a flow: what a trade gained
 * or lost against the market is in `marketMove`, the remainder. Moves between the customer's own accounts cancel out.
 */

import { z } from 'zod';

/** The range cannot be read: it must start before it ends, and before now. */
export const BANK_VALUE_RANGE_INVALID = 'bank.value_range_invalid' as const;
/** The range starts too long ago to be priced in one read: pick a later start. */
export const BANK_VALUE_RANGE_TOO_LONG = 'bank.value_range_too_long' as const;
/** More ledger movements from the range's start to now than one answer carries (the holdings are replayed back from now,
 * so the start is what counts): pick a later start. */
export const BANK_VALUE_HISTORY_TOO_LARGE = 'bank.value_history_too_large' as const;
/** The ledger's history cannot be read right now (not wired, or the read failed): nothing is drawn from part of it. */
export const BANK_VALUE_HISTORY_UNAVAILABLE = 'bank.value_history_unavailable' as const;

export const VALUE_SERIES_INTERVALS = ['5m', '1h', '4h', '1d', '1w'] as const;
export type ValueSeriesInterval = (typeof VALUE_SERIES_INTERVALS)[number];

const isoTime = z.string().datetime({ offset: true });
const signedDecimal = /^-?\d+(\.\d{1,18})?$/;
const usd = z.string().regex(signedDecimal);

export const bankValueOverTimeInputSchema = z
  .object({
    from: isoTime,
    /** Absent: now. */
    to: isoTime.optional(),
  })
  .strict();
export type BankValueOverTimeInput = z.infer<typeof bankValueOverTimeInputSchema>;

export const bankValueMissingSchema = z.object({
  assetId: z.string().min(1),
  /** `no_price`: no candle had ended by then on the coin's USDT or USDC market. */
  reason: z.literal('no_price'),
});

export const bankValuePointSchema = z.object({
  at: isoTime,
  /** Null when a coin held then has no price: missing, never zero. */
  valueUsd: usd.nullable(),
  missing: z.array(bankValueMissingSchema),
});
export type BankValuePoint = z.infer<typeof bankValuePointSchema>;

export const bankValueBridgeSchema = z.object({
  /** Every leg is null when any part of it (or the opening or closing value) has no price. */
  openingUsd: usd.nullable(),
  depositsUsd: usd.nullable(),
  withdrawalsUsd: usd.nullable(),
  feesUsd: usd.nullable(),
  otherFlowsUsd: usd.nullable(),
  /** The remainder: closing − opening − deposits + withdrawals + fees − other flows. */
  marketMoveUsd: usd.nullable(),
  closingUsd: usd.nullable(),
  /** The coins whose missing price leaves the bridge unknown. */
  missing: z.array(bankValueMissingSchema),
});
export type BankValueBridge = z.infer<typeof bankValueBridgeSchema>;

export const bankValueOverTimeSchema = z.object({
  /** The first and last points: `from` and `to` set on the ledger's time grid for the interval. */
  from: isoTime,
  to: isoTime,
  interval: z.enum(VALUE_SERIES_INTERVALS),
  points: z.array(bankValuePointSchema),
  bridge: bankValueBridgeSchema,
});
export type BankValueOverTime = z.infer<typeof bankValueOverTimeSchema>;

/**
 * HOLDINGS CHANGE (J-portfolio-06 #3, PF-balances-02): what rose and fell in amount over a range, per coin, from the same
 * replay as the value over time (main account and every named Space). `startAmount` is what was held at `from` ("0" when
 * nothing was held yet), `endAmount` at `to`; `change` = end − start exactly. Each end is priced at the close of the last
 * candle that had ended by then (USDT, USDC and USD at 1); a coin with no price there has a null price and value, never zero.
 */
export const bankHoldingsChangeRowSchema = z.object({
  assetId: z.string().min(1),
  startAmount: z.string().regex(signedDecimal),
  endAmount: z.string().regex(signedDecimal),
  change: z.string().regex(signedDecimal),
  startPriceUsd: usd.nullable(),
  endPriceUsd: usd.nullable(),
  startValueUsd: usd.nullable(),
  endValueUsd: usd.nullable(),
});
export type BankHoldingsChangeRow = z.infer<typeof bankHoldingsChangeRowSchema>;

export const bankHoldingsChangeSchema = z.object({
  from: isoTime,
  to: isoTime,
  /** Every coin held at either end, by coin. */
  rows: z.array(bankHoldingsChangeRowSchema),
});
export type BankHoldingsChange = z.infer<typeof bankHoldingsChangeSchema>;
