import type { BankRoot } from '../bank-root.js';
import type { ActivityService, ActivityServiceOptions } from '../activity/activity-service.js';
import type { SpaceService } from '../spaces/space-service.js';
import { StatementJobService, type StatementJobsConfig } from './statement-jobs.js';
import { StatementService } from './statement-service.js';

/** Statements and background exports. An area of svc-bank (`area-chain.ts`). */
export interface StatementsServices {
  readonly statements: StatementService;
  /** PF-statements-02: background exports, made by a worker and listed in the document centre. */
  readonly statementJobs: StatementJobService;
}

export interface StatementsServiceOptions {
  /** PF-statements-02: the export worker's claim lease. Left out, background exports are off. */
  statementJobs?: StatementJobsConfig;
  /** The activity area's cursor secret, which a statement's links are signed with. */
  activity?: Pick<ActivityServiceOptions, 'cursorSecret'>;
}

export function composeStatementsArea(
  root: BankRoot,
  made: { readonly activity: ActivityService; readonly spaces: SpaceService },
  options: StatementsServiceOptions,
): StatementsServices {
  const statements = new StatementService(made.activity, options.activity?.cursorSecret, made.spaces);
  return { statements, statementJobs: new StatementJobService(root.sql, statements, options.statementJobs ?? { leaseMs: null }) };
}
