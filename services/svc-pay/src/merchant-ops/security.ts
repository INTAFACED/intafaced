import type { Sql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import type { MerchantCaller } from './roles.js';

/**
 * The team-wide sign-in rule (M-plat-org-06, org-access-019).
 *
 * The owner switches `requireMfa` on or off; every member may read it, and the
 * portal shows it read-only to anyone but the owner. Enforcement lives in
 * `resolveMerchantCaller`: while it is on, a member whose session has not
 * passed a second step is refused `pay.merchant_mfa_required`.
 */
export interface MerchantSecurityView {
  readonly requireMfa: boolean;
  /** Only the owner may change the rule. */
  readonly canChange: boolean;
  readonly changedAt: string | null;
}

export class MerchantSecurity {
  constructor(private readonly sql: Sql) {}

  async get(caller: MerchantCaller): Promise<MerchantSecurityView> {
    const rows = await this.sql<Array<{ require_mfa: boolean; require_mfa_changed_at: Date | null }>>`
      SELECT require_mfa, require_mfa_changed_at FROM pay.merchants WHERE id = ${caller.merchantId} LIMIT 1`;
    const row = rows[0];
    if (!row) throw new MerchantOpsError('pay.merchant_ops_not_merchant', 'forbidden');
    return {
      requireMfa: row.require_mfa,
      canChange: caller.role === 'owner',
      changedAt: row.require_mfa_changed_at ? row.require_mfa_changed_at.toISOString() : null,
    };
  }

  /** Owner only, from an interactive MFA session (the same bar as team changes). Setting the current value changes nothing. */
  async setRequireMfa(caller: MerchantCaller, requireMfa: boolean): Promise<MerchantSecurityView> {
    if (caller.role !== 'owner') throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
    if (!caller.interactive) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
    await this.sql`
      UPDATE pay.merchants
         SET require_mfa = ${requireMfa},
             require_mfa_changed_by = ${caller.userId},
             require_mfa_changed_at = now(),
             updated_at = now()
       WHERE id = ${caller.merchantId} AND require_mfa IS DISTINCT FROM ${requireMfa}`;
    return this.get(caller);
  }
}
