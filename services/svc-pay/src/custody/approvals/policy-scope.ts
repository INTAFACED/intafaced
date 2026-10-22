import { CustodyTaskExecutionError } from './errors.js';
import type { TaskExecutor } from './service.js';

/**
 * The `policy` config scope carries more than one kind of policy. Each task names its kind in `payload.kind`, and this
 * routes it to that kind's applier. An unknown or missing kind fails the task (not retryable): nothing is guessed.
 * Kept in svc-pay so no contracts scope change is needed (the admin app parses scopes from the contracts enum).
 */
export function policyScopeApplier(appliers: Readonly<Record<string, TaskExecutor>>): TaskExecutor {
  return async (task) => {
    const kind = task.payload.kind;
    const run = typeof kind === 'string' ? appliers[kind] : undefined;
    if (!run) throw new CustodyTaskExecutionError('custody_policy.kind_unknown', `no applier for policy kind ${JSON.stringify(kind)}`);
    await run(task);
  };
}
