import type { Sql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import type { MerchantCaller } from './roles.js';

/**
 * The team-wide sign-in rule (M-plat-org-06, org-access-019), svc-pay half.
 *
 * The owner chooses `requireMfa`; there is no default. Until they choose, a
 * read refuses `pay.merchant_mfa_rule_unset` and the set call takes
 * `expectedRevision: 0`. Every change bumps the revision; a change sent with
 * an older revision is refused `pay.merchant_mfa_rule_stale`. Only the owner,
 * from an interactive MFA session, may change it. svc-pay never gates a call
 * on the rule: svc-identity reads it (`mfaRuleForUser`) and enforces it at
 * sign-in.
 */
export interface MerchantSecurityView {
  readonly requireMfa: boolean;
  readonly revision: number;
  /** Only the owner may change the rule; members see it read-only. */
  readonly canChange: boolean;
  readonly changedAt: string;
}

interface RuleRow {
  require_mfa: boolean | null;
  require_mfa_revision: number;
  require_mfa_changed_at: Date | null;
}

export class MerchantSecurity {
  constructor(private readonly sql: Sql) {}

  async get(caller: MerchantCaller): Promise<MerchantSecurityView> {
    const rows = await this.sql<RuleRow[]>`
      SELECT require_mfa, require_mfa_revision, require_mfa_changed_at FROM pay.merchants WHERE id = ${caller.merchantId} LIMIT 1`;
    return view(caller, rows[0]);
  }

  async setRequireMfa(caller: MerchantCaller, input: { requireMfa: boolean; expectedRevision: number }): Promise<MerchantSecurityView> {
    if (caller.role !== 'owner') throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
    if (!caller.interactive) throw new MerchantOpsError('pay.team_interactive_only', 'forbidden');
    const rows = await this.sql<RuleRow[]>`
      UPDATE pay.merchants
         SET require_mfa = ${input.requireMfa},
             require_mfa_revision = require_mfa_revision + 1,
             require_mfa_changed_by = ${caller.userId},
             require_mfa_changed_at = now(),
             updated_at = now()
       WHERE id = ${caller.merchantId} AND require_mfa_revision = ${input.expectedRevision}
       RETURNING require_mfa, require_mfa_revision, require_mfa_changed_at`;
    if (!rows[0]) throw new MerchantOpsError('pay.merchant_mfa_rule_stale', 'conflict');
    return view(caller, rows[0]);
  }
}

function view(caller: MerchantCaller, row: RuleRow | undefined): MerchantSecurityView {
  if (!row || row.require_mfa === null || row.require_mfa_changed_at === null) {
    throw new MerchantOpsError('pay.merchant_mfa_rule_unset', 'precondition');
  }
  return {
    requireMfa: row.require_mfa,
    revision: row.require_mfa_revision,
    canChange: caller.role === 'owner',
    changedAt: row.require_mfa_changed_at.toISOString(),
  };
}

/**
 * What svc-identity asks at sign-in: across every merchant this user owns or is
 * an ACTIVE member of, `required` if any requires MFA, else `unset` if any has
 * not chosen, else `not_required`. `none` when the user is on no merchant.
 * svc-identity decides what `unset` means at sign-in (follow-up).
 */
export type MfaRuleForUser = 'required' | 'not_required' | 'unset' | 'none';

export async function mfaRuleForUser(sql: Sql, userId: string): Promise<MfaRuleForUser> {
  const rows = await sql<Array<{ require_mfa: boolean | null }>>`
    SELECT mc.require_mfa FROM pay.merchants mc WHERE mc.user_id = ${userId}
    UNION ALL
    SELECT mc.require_mfa
      FROM pay.merchant_team_members m
      JOIN pay.merchants mc ON mc.id = m.merchant_id
     WHERE m.user_id = ${userId} AND m.status = 'active'`;
  if (rows.length === 0) return 'none';
  if (rows.some((r) => r.require_mfa === true)) return 'required';
  if (rows.some((r) => r.require_mfa === null)) return 'unset';
  return 'not_required';
}
