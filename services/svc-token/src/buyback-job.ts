/**
 * §4.3 buyback job — size spend from revenue, IOC market-buy on the internal
 * book, then the existing burn split.
 *
 * `runBuybackWindow` takes `{ runId, revenueWindow }` only. Amounts are
 * `ledger.balance(houseFees(module, quoteAssetId))` × `buybackBudget`, then
 * the fill from `placeIocMarketBuy` (internal HMAC place — never USER REST
 * `/api/v1/orders`). Caller-typed `tokensBought` / `revenueTotal` are refused:
 * inventing a fill is how recordBuyback used to settle a DB-only buy
 * (`token.buyback_tokens_unmoved`).
 *
 * Unset / off (`BUYBACK_JOB_ENABLED=false`) is `token.buyback_job_unset`.
 * Empty book / zero fill is `token.buyback_book_empty` — a real empty
 * reading, not an invented mid.
 */
import { formatAmount, houseFees, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { buybackBudget, type BuybackParams } from './economics/buyback.js';
import { TokenError } from './token-service.js';
import { YIELD_SOURCE_MODULES } from './yield-job.js';

export interface BuybackPlaceFill {
  /** Base qty the book actually filled. 0 = empty book / no take. */
  readonly filledQty: Amount;
}

export interface BuybackSettleInput {
  readonly runId: string;
  readonly revenueWindow: { from: Date; to: Date };
  readonly revenueTotal: Record<string, string>;
  readonly tokensBought: Amount;
}

export interface BuybackRunResult {
  readonly runId: string;
  readonly tokensBought: Amount;
  readonly burned: Amount;
  readonly toRewards: Amount;
}

export interface BuybackJobDeps {
  readonly buybackJobEnabled: boolean;
  readonly assetId: string;
  /** Quote asset whose houseFees size the spend. Blank when enabled → unset. */
  readonly quoteAssetId: string;
  readonly ledger: LedgerClient;
  readonly buybackParams: () => Promise<BuybackParams>;
  /**
   * IOC market-buy on the internal book. Fill qty is the only tokensBought
   * the job may settle. Must be called — a job that skips this and types a
   * fill is the operator-input hole.
   */
  readonly placeIocMarketBuy: (input: { quoteBudget: Amount; clientOrderId: string }) => Promise<BuybackPlaceFill>;
  readonly settleBuyback: (input: BuybackSettleInput) => Promise<{ runId: string; burned: Amount; toRewards: Amount }>;
}

export interface BuybackWindowInput {
  readonly runId: string;
  readonly revenueWindow: { from: Date; to: Date };
}

/**
 * True only when every setting the job refuses on is present: enabled, a
 * quote asset, a listing symbol and the internal place secret. Says whether
 * the job could run — not that it ran or that the book has asks.
 */
export function buybackJobSet(settings: {
  readonly enabled: boolean;
  readonly quoteAssetId: string | undefined;
  readonly symbol: string | undefined;
  readonly internalSecret: string | undefined;
}): boolean {
  const present = (value: string | undefined) => value != null && value.trim() !== '';
  return settings.enabled && present(settings.quoteAssetId) && present(settings.symbol) && present(settings.internalSecret);
}

export async function runBuybackWindow(deps: BuybackJobDeps, input: BuybackWindowInput): Promise<BuybackRunResult> {
  if (input !== null && typeof input === 'object' && ('tokensBought' in input || 'revenueTotal' in input)) {
    throw new TokenError(
      'Buyback job does not accept caller-typed tokensBought — fill comes from placeIocMarketBuy',
      'token.buyback_job_unset',
    );
  }
  if (!deps.buybackJobEnabled) {
    throw new TokenError('Buyback market-buy job is unset (BUYBACK_JOB_ENABLED=false)', 'token.buyback_job_unset');
  }
  const quoteAssetId = deps.quoteAssetId.trim();
  if (!quoteAssetId) {
    throw new TokenError('BUYBACK_QUOTE_ASSET is unset — refusing to invent a quote', 'token.buyback_job_unset');
  }

  let revenue: Amount = 0n;
  for (const module of YIELD_SOURCE_MODULES) {
    const held = (await deps.ledger.balance(houseFees(module, quoteAssetId))).amount;
    if (held > 0n) revenue += held;
  }
  const params = await deps.buybackParams();
  const quoteBudget = buybackBudget(revenue, params);
  if (quoteBudget <= 0n) {
    throw new TokenError('No revenue to spend on a buyback for this window', 'token.buyback_revenue_invalid');
  }

  const placed = await deps.placeIocMarketBuy({ quoteBudget, clientOrderId: input.runId });
  if (placed.filledQty <= 0n) {
    throw new TokenError('Internal book has no depth for this IOC market-buy', 'token.buyback_book_empty');
  }

  const settled = await deps.settleBuyback({
    runId: input.runId,
    revenueWindow: input.revenueWindow,
    revenueTotal: { [quoteAssetId]: formatAmount(revenue) },
    tokensBought: placed.filledQty,
  });

  return {
    runId: settled.runId,
    tokensBought: placed.filledQty,
    burned: settled.burned,
    toRewards: settled.toRewards,
  };
}
