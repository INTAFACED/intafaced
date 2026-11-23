import { parseFeeTable, parsePlans, type FeeLine, type PlanTable } from './plans.js';

/** The owner's plan and account fee tables. An area of svc-bank (`area-chain.ts`). */
export interface PlansServices {
  /** BK-acct-04: the owner's plan table (null is blank) and account fee table (null is none published). */
  readonly accountTables: { readonly plans: PlanTable | null; readonly fees: FeeLine[] | null };
}

export interface PlansServiceOptions {
  /** BK-acct-04: the owner's plan table and account fee table (raw JSON; blank refuses or says not set). */
  plans?: string | undefined;
  feeTable?: string | undefined;
}

export function composePlansArea(_root: unknown, _made: object, options: PlansServiceOptions): PlansServices {
  return { accountTables: { plans: parsePlans(options.plans), fees: parseFeeTable(options.feeTable) } };
}
