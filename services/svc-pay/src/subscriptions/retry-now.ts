import type { Sql } from 'postgres';
import type { SubscriptionRetryNowResult } from '@intafaced/contracts';
import { PayError } from '../payment-service.js';
import type { SubscriptionRetryPolicyService } from './retry-policy.js';
import type { SubscriptionService } from './subscription-service.js';

/**
 * M-bill-04 retryNow and final action.
 *
 * retryNow(executionId, attempt) runs the SAME charge path as the due runner (attemptCycle with isRetry): it reuses
 * the cycle's invoice when one exists, re-issues the link and records the pre-charge notify. It never opens a second
 * invoice for a cycle (attemptCycle's per-occurrence idempotency key).
 * - `attempt` is the attempt being asked for (count seen + 1). A repeat of an attempt already made returns
 *   `already_attempted` with that attempt; nothing runs twice.
 * - settled (paid) -> `already_paid`, nothing done. invoiced (link out, unpaid) -> `already_attempted`.
 * - pending (result unknown) -> `checking`; this call waits and does nothing.
 * - When the merchant policy's attempts are spent, the final action is applied once per (subscription, occurrence):
 *   the primary key on pay.subscription_retry_final_actions is the once. cancel cancels the subscription;
 *   mark_unpaid and leave_past_due record the decision and stop further retries of that cycle (exhausted_at).
 * - Unset policy refuses `pay.subscription_retry_policy_unset`: there is no default attempt count.
 */
type ExecRow = {
  id: string;
  subscription_id: string;
  merchant_id: string;
  occurrence: number;
  status: 'pending' | 'invoiced' | 'settled' | 'rejected' | 'skipped';
  attempt_count: number;
  payment_id: string | null;
};

export class SubscriptionRetryNow {
  constructor(
    private readonly sql: Sql,
    private readonly subscriptions: SubscriptionService,
    private readonly policy: SubscriptionRetryPolicyService,
  ) {}

  /** The merchant that owns an execution, for the router's area check. Unknown ids refuse as not found. */
  async merchantOf(executionId: string): Promise<string> {
    return (await this.load(executionId)).merchant_id;
  }

  async retryNow(input: { executionId: string; attempt: number }, actorId: string): Promise<SubscriptionRetryNowResult> {
    const exec = await this.load(input.executionId);
    const result = (
      outcome: SubscriptionRetryNowResult['outcome'],
      e: ExecRow = exec,
      finalAction: SubscriptionRetryNowResult['finalAction'] = null,
    ) => ({
      executionId: e.id,
      outcome,
      attempt: Math.max(1, Number(e.attempt_count)),
      paymentId: e.payment_id,
      finalAction,
    });
    if (exec.status === 'settled') return result('already_paid');
    if (exec.status === 'pending') return result('checking');
    const applied = await this.finalActionOf(exec);
    if (applied) return result('final_action_applied', exec, applied);
    if (input.attempt <= Number(exec.attempt_count) || exec.status === 'invoiced') return result('already_attempted');
    if (input.attempt !== Number(exec.attempt_count) + 1 || exec.status !== 'rejected') {
      throw new PayError('Retry attempt does not follow the last attempt', 'pay.subscription_retry_attempt_not_found');
    }
    const policy = await this.policy.get(exec.merchant_id);
    const { attempts, finalAction } = policy.values;
    if (policy.status !== 'set' || attempts === null || finalAction === null) {
      throw new PayError('Retry policy is unset', 'pay.subscription_retry_policy_unset');
    }
    if (Number(exec.attempt_count) >= attempts) {
      return result('final_action_applied', exec, await this.applyFinalAction(exec, finalAction, policy.version, actorId));
    }
    const sub = await this.subscriptions.getSubscription(exec.subscription_id);
    const mandate = await this.subscriptions.getMandate(sub.mandateId);
    const out = await this.subscriptions.attemptCycle({
      sub,
      mandate,
      frame: this.subscriptions.frameOf(sub, mandate),
      occurrence: Number(exec.occurrence),
      isRetry: true,
      now: new Date(),
    });
    const after = await this.load(exec.id);
    if (out.outcome === 'invoiced') return result('reissued', after);
    if (out.outcome === 'rejected') return result('rejected', after);
    if (after.status === 'settled') return result('already_paid', after);
    return result('already_attempted', after);
  }

  /** Apply the policy's final action for this cycle, once. A second call returns the action already recorded. */
  async applyFinalAction(
    exec: ExecRow,
    finalAction: 'cancel' | 'mark_unpaid' | 'leave_past_due',
    policyVersion: number,
    actorId: string,
  ): Promise<'cancel' | 'mark_unpaid' | 'leave_past_due'> {
    const inserted = await this.sql<Array<{ final_action: typeof finalAction }>>`
      INSERT INTO pay.subscription_retry_final_actions (subscription_id, occurrence, execution_id, final_action, policy_version, actor_id)
      VALUES (${exec.subscription_id}, ${exec.occurrence}, ${exec.id}, ${finalAction}, ${policyVersion}, ${actorId})
      ON CONFLICT (subscription_id, occurrence) DO NOTHING
      RETURNING final_action`;
    if (!inserted[0]) return (await this.finalActionOf(exec))!;
    await this.sql`UPDATE pay.subscription_executions SET exhausted_at = COALESCE(exhausted_at, now()) WHERE id = ${exec.id}`;
    if (finalAction === 'cancel') await this.subscriptions.cancelSubscription(exec.subscription_id);
    return finalAction;
  }

  private async finalActionOf(exec: ExecRow) {
    const rows = await this.sql<Array<{ final_action: 'cancel' | 'mark_unpaid' | 'leave_past_due' }>>`
      SELECT final_action FROM pay.subscription_retry_final_actions
       WHERE subscription_id = ${exec.subscription_id} AND occurrence = ${exec.occurrence}`;
    return rows[0]?.final_action ?? null;
  }

  private async load(executionId: string): Promise<ExecRow> {
    const rows = await this.sql<ExecRow[]>`
      SELECT e.id, e.subscription_id, s.merchant_id, e.occurrence, e.status, e.attempt_count, e.payment_id
        FROM pay.subscription_executions e JOIN pay.subscriptions s ON s.id = e.subscription_id
       WHERE e.id = ${executionId}::uuid`;
    if (!rows[0]) throw new PayError('Execution not found', 'pay.subscription_retry_attempt_not_found');
    return rows[0];
  }
}
