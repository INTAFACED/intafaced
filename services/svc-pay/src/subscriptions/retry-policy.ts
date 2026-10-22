import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  subscriptionRetryValuesComplete,
  type SubscriptionRetryPolicySetInput,
  type SubscriptionRetryPolicyView,
  type SubscriptionRetryValues,
} from '@intafaced/contracts';
import { PayError } from '../payment-service.js';
import { MAX_ATTEMPTS_PER_CYCLE } from './charge-cycle.js';

/**
 * M-bill-04: per-merchant subscription retry policy.
 *
 * The three values (attempts, spacing, final action) are OWNER DECISIONS with no default. A merchant with no row, or
 * with any value NULL, reads `status: 'unset'`, and turning auto-retry on refuses `pay.subscription_retry_policy_unset`.
 * Attempts may not exceed MAX_ATTEMPTS_PER_CYCLE, the charge cycle's operational bound.
 *
 * Every write names the version it read (`expectedVersion`); a stale version refuses
 * `pay.subscription_retry_policy_conflict` and writes nothing. Each accepted write is kept in the events table.
 */

type PolicyRow = {
  merchant_id: string;
  attempts: number | null;
  spacing_hours: number | null;
  final_action: SubscriptionRetryValues['finalAction'];
  auto_retry: boolean;
  version: number;
  updated_at: Date;
};

function viewOf(merchantId: string, row: PolicyRow | undefined): SubscriptionRetryPolicyView {
  const values: SubscriptionRetryValues = {
    attempts: row?.attempts ?? null,
    spacingHours: row?.spacing_hours ?? null,
    finalAction: row?.final_action ?? null,
  };
  return {
    merchantId,
    status: subscriptionRetryValuesComplete(values) ? 'set' : 'unset',
    values,
    autoRetry: row?.auto_retry ?? false,
    version: row?.version ?? 0,
    updatedAt: row ? row.updated_at.toISOString() : null,
  };
}

export class SubscriptionRetryPolicyService {
  constructor(private readonly sql: Sql) {}

  async get(merchantId: string): Promise<SubscriptionRetryPolicyView> {
    const rows = await this.sql<PolicyRow[]>`
      SELECT merchant_id, attempts, spacing_hours, final_action, auto_retry, version, updated_at
        FROM pay.subscription_retry_policies WHERE merchant_id = ${merchantId}
    `;
    return viewOf(merchantId, rows[0]);
  }

  async set(input: SubscriptionRetryPolicySetInput, actorId: string): Promise<SubscriptionRetryPolicyView> {
    const { attempts } = input.values;
    if (attempts !== null && (attempts < 1 || attempts > MAX_ATTEMPTS_PER_CYCLE)) {
      throw new PayError(`attempts must be 1..${MAX_ATTEMPTS_PER_CYCLE}`, 'pay.subscription_retry_policy_invalid', {
        max: MAX_ATTEMPTS_PER_CYCLE,
      });
    }
    if (input.autoRetry && !subscriptionRetryValuesComplete(input.values)) {
      throw new PayError(
        'Auto-retry needs attempts, spacing and a final action; they are owner decisions and have no default',
        'pay.subscription_retry_policy_unset',
      );
    }
    return transaction(this.sql, async (tx) => {
      const current = await tx<PolicyRow[]>`
        SELECT merchant_id, attempts, spacing_hours, final_action, auto_retry, version, updated_at
          FROM pay.subscription_retry_policies WHERE merchant_id = ${input.merchantId} FOR UPDATE
      `;
      const version = current[0]?.version ?? 0;
      if (version !== input.expectedVersion) {
        throw new PayError(
          `Retry policy is at version ${version}, not ${input.expectedVersion}`,
          'pay.subscription_retry_policy_conflict',
          {
            version,
          },
        );
      }
      const next = version + 1;
      const v = input.values;
      const rows = await tx<PolicyRow[]>`
        INSERT INTO pay.subscription_retry_policies
          (merchant_id, attempts, spacing_hours, final_action, auto_retry, version, updated_by, updated_at)
        VALUES (${input.merchantId}, ${v.attempts}, ${v.spacingHours}, ${v.finalAction}, ${input.autoRetry}, ${next}, ${actorId}, now())
        ON CONFLICT (merchant_id) DO UPDATE SET
          attempts = EXCLUDED.attempts, spacing_hours = EXCLUDED.spacing_hours, final_action = EXCLUDED.final_action,
          auto_retry = EXCLUDED.auto_retry, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING merchant_id, attempts, spacing_hours, final_action, auto_retry, version, updated_at
      `;
      await tx`
        INSERT INTO pay.subscription_retry_policy_events
          (merchant_id, version, attempts, spacing_hours, final_action, auto_retry, actor_id)
        VALUES (${input.merchantId}, ${next}, ${v.attempts}, ${v.spacingHours}, ${v.finalAction}, ${input.autoRetry}, ${actorId})
      `;
      return viewOf(input.merchantId, rows[0]);
    });
  }
}
