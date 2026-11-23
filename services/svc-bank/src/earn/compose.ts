import type { BankRoot } from '../bank-root.js';
import type { AssetPauseService } from '../ops/asset-pause.js';
import { EarnService } from './earn-service.js';

/** Earn pools. An area of svc-bank (`area-chain.ts`). */
export interface EarnServices {
  readonly earn: EarnService;
}

export interface EarnServiceOptions {
  /** Refused by earn pools — svc-token owns native staking (§8.1). */
  nativeAssetId?: string;
  /** Owner-published staking risk wording as JSON (`BANK_EARN_RISK_WORDING_JSON`, BK-earn-04). No default: blank refuses. */
  earnRiskWording?: string | undefined;
}

export function composeEarnArea(
  root: BankRoot,
  made: { readonly assetPauses: AssetPauseService },
  options: EarnServiceOptions,
): EarnServices {
  // The supply pause lives in the deposit path so auto-invest cannot go around it.
  return {
    earn: new EarnService(root.sql, root.ledger, {
      nativeAssetId: options.nativeAssetId ?? 'IFC',
      supplyGate: made.assetPauses,
      accounts: root.recipients,
      riskWording: options.earnRiskWording,
    }),
  };
}
