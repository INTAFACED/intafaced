import type { BankRoot } from '../bank-root.js';
import type { EarnService } from '../earn/earn-service.js';
import type { SpaceService } from '../spaces/space-service.js';
import { AutoInvestService, type AutoInvestServiceOptions } from './auto-invest-service.js';

/** Auto-invest and round-ups. An area of svc-bank (`area-chain.ts`). */
export interface AutoInvestServices {
  readonly autoInvest: AutoInvestService;
}

export interface AutoInvestAreaOptions {
  /**
   * Auto-invest wiring: optional convert port for DCA.
   *
   * Not defaulted. Absent convert = every DCA create/run refuses
   * `bank.auto_invest_rate_unset` rather than inventing a §8 rate. Threshold
   * sweeps need no convert (same-asset earn deposit).
   */
  autoInvest?: AutoInvestServiceOptions;
}

export function composeAutoInvestArea(
  root: BankRoot,
  made: { readonly earn: EarnService; readonly spaces: SpaceService },
  options: AutoInvestAreaOptions,
): AutoInvestServices {
  // No convert port = DCA refuses rates-unset; threshold sweeps still work. Made before the cards area, so the capture
  // hook can call applyRoundUp without a setter or a circular constructor.
  return { autoInvest: new AutoInvestService(root.sql, root.ledger, made.earn, made.spaces, options.autoInvest ?? {}) };
}
