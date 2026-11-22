import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import { IncomeSorterService } from './income-sorter.js';

/** The income sorter. An area of svc-bank (`area-chain.ts`). */
export interface SorterServices {
  /** BK-pots-03: payments from other people split across the person's own spaces. */
  readonly sorter: IncomeSorterService;
}

export interface SorterServiceOptions {
  /** Owner-set smallest payment the income sorter splits (`BANK_INCOME_SORTER_MIN_CREDIT`). No default: blank refuses a sorter. */
  incomeSorterMinCredit?: string | undefined;
}

export function composeSorterArea(root: BankRoot, made: { readonly spaces: SpaceService }, options: SorterServiceOptions): SorterServices {
  return { sorter: new IncomeSorterService(root.sql, root.ledger, made.spaces, { minCredit: () => options.incomeSorterMinCredit }) };
}
