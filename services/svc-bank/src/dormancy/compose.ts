import type { BankRoot } from '../bank-root.js';
import { DormancyService, parseDormancyRules } from './dormancy.js';

/** Dormant accounts. An area of svc-bank (`area-chain.ts`). */
export interface DormancyServices {
  /** RC-bank-01: the dormancy notice and fee. */
  readonly dormancy: DormancyService;
}

export interface DormancyServiceOptions {
  /** RC-bank-01: the owner's dormancy fee rules (raw JSON; blank refuses). */
  dormancyRules?: string | undefined;
}

export function composeDormancyArea(root: BankRoot, _made: object, options: DormancyServiceOptions): DormancyServices {
  return { dormancy: new DormancyService(root.sql, root.custody, parseDormancyRules(options.dormancyRules)) };
}
