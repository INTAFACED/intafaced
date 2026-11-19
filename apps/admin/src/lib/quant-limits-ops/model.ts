import type { QuantEscapeCorpus, QuantQuotaProfile } from '@intafaced/contracts';
import type { Part } from '@/lib/desk/part';

/**
 * Plan quotas and sandbox limits on the quant desk (J-algo-dev-12, AL-limits-01 and AL-limits-02). Pure, so the route,
 * the server and the browser share one list of what the desk may do.
 *
 * The proxy names its actions one by one: any other `op` is refused before anything reaches svc-quant.
 */
export const LIMITS_DESK_OPS = ['set', 'sandbox', 'assign', 'corpus'] as const;
export type LimitsDeskOp = (typeof LIMITS_DESK_OPS)[number];
export const isLimitsDeskOp = (op: unknown): op is LimitsDeskOp => (LIMITS_DESK_OPS as readonly unknown[]).includes(op);

export interface LimitsDeskView {
  readonly asOf: string;
  readonly profile: Part<QuantQuotaProfile>;
}

export type LimitsDeskReply =
  | { readonly ok: true; readonly what: string; readonly corpus: QuantEscapeCorpus | null }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

/** The refusal the proxy gives an action it does not list. svc-quant is never called. */
export const NOT_LISTED = {
  ok: false,
  title: 'That action is not on this desk',
  body: 'The plan limits desk lists set a quota limit, set a sandbox limit, assign an account to a plan and run the escape corpus. Nothing else is passed on.',
  next: 'Nothing was changed.',
  code: 'admin.action_not_listed',
  changed: 'no',
} as const satisfies LimitsDeskReply;

/** What each quota resource counts, as the desk names it. */
export const RESOURCE_WORDS = {
  strategies: 'Saved strategies (source files)',
  versions: 'Versions per strategy',
  concurrent_runs: 'Concurrent runs',
  paper_runs: 'Paper runs',
  runs: 'Stored runs',
  log_lines: 'Stored log lines',
  storage: 'Source and result storage (bytes)',
  collaborators: 'Collaborators per strategy',
  notifications: 'Notifications per day',
} as const;

/** What each sandbox limit bounds, as the desk names it. */
export const SANDBOX_WORDS = {
  wall_clock_ms: 'Wall-clock time per run (ms)',
  memory_bytes: 'Memory per run (bytes)',
  output_bytes: 'Log output per run (bytes)',
} as const;
