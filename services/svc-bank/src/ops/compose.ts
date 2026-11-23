import type { BankRoot } from '../bank-root.js';
import { AssetPauseService } from './asset-pause.js';

/** The desk's own switches. An area of svc-bank (`area-chain.ts`). */
export interface OpsServices {
  /** Desk pause of new borrow and new supply per asset (BK-loan-07). */
  readonly assetPauses: AssetPauseService;
}

export function composeOpsArea(root: BankRoot): OpsServices {
  return { assetPauses: new AssetPauseService(root.sql) };
}
