import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { PersonalPayService } from '../transfers/personal-pay.js';
import { PortfolioService, type PortfolioServiceOptions } from './portfolio-service.js';

/** The person's portfolio. An area of svc-bank (`area-chain.ts`). */
export interface PortfolioServices {
  readonly portfolio: PortfolioService;
}

export interface PortfolioAreaOptions {
  /**
   * Portfolio valuation: where prices come from (svc-trade's public tickers).
   * Not defaulted. Without a source, `portfolio.summary` answers users who hold
   * only USDT/USDC/USD and refuses `bank.prices_unavailable` for anyone else.
   */
  portfolio?: PortfolioServiceOptions;
}

export function composePortfolioArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService; readonly personalPay: PersonalPayService },
  options: PortfolioAreaOptions,
): PortfolioServices {
  return {
    portfolio: new PortfolioService(root.ledger, made.spaces, {
      ...options.portfolio,
      transferFees: { feesFor: (userId, txIds) => made.personalPay.feesFor(userId, txIds) },
      assets: options.portfolio?.assets ?? root.assetRegistry,
    }),
  };
}
