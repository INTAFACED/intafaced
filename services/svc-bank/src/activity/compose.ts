import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { PersonalPayService } from '../transfers/personal-pay.js';
import { ActivityRecordService } from './activity-records.js';
import { ActivityService, type ActivityServiceOptions } from './activity-service.js';
import type { TaxEffectMap } from './tax-effects.js';

/** The person's merged money history. An area of svc-bank (`area-chain.ts`). */
export interface ActivityServices {
  readonly activity: ActivityService;
  readonly activityRecords: ActivityRecordService;
  /** What each kind of activity line means for tax: the owner's map, the TEST one on a test stack, or null (refused). */
  readonly taxEffects: TaxEffectMap | null;
}

export interface ActivityAreaOptions {
  /** Merged money history: the ledger page port and the cursor secret. Unset = `bank.activity.list` refuses, never answers empty. */
  activity?: ActivityServiceOptions;
  /** The tax-effect map (`activity/tax-effects.ts`). Unset: `activity.taxEffects` refuses by name. */
  taxEffects?: TaxEffectMap | null;
}

export function composeActivityArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService; readonly personalPay: PersonalPayService },
  options: ActivityAreaOptions,
): ActivityServices {
  const activityRecords = new ActivityRecordService(root.sql);
  const activity = new ActivityService(made.spaces, {
    ...options.activity,
    custody: root.custody,
    records: activityRecords,
    transferFacts: { forTransfers: (userId, txIds) => made.personalPay.factsFor(userId, txIds) },
  });
  return { activity, activityRecords, taxEffects: options.taxEffects ?? null };
}
