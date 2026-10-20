/**
 * Trading features of one sub-account (W-security-accounts-06): which of the products that exist today a main account has
 * turned on for it. Which features each kind may have is an owner setting; blank refuses. This records the choice and
 * moves no money. Money services that gate on it read it through a contract of their own, not through this service.
 */
import type { Sql } from 'postgres';
import { SUB_ACCOUNT_KINDS, type SubAccountKind } from '../auth/auth-service.js';
import { userCopy } from '../user-copy.js';

/**
 * The trading products svc-trade serves today: spot, convert, futures, algo (TWAP) and copy. Margin is not listed: the
 * margin terms are stored but no borrow door exists. Bots trade through API keys, not a separate product.
 */
export const SUB_ACCOUNT_FEATURES = ['spot', 'convert', 'futures', 'algo', 'copy'] as const;
export type SubAccountFeature = (typeof SUB_ACCOUNT_FEATURES)[number];

export type FeatureEligibility = ReadonlyMap<SubAccountKind, ReadonlySet<SubAccountFeature>>;

/**
 * `standard:spot+convert,spot:spot`: kind, a colon, features joined by plus; kinds separated by commas. Blank, or any part
 * that names an unknown kind or feature, is "not published": a half-read owner setting must not offer anything.
 */
export function parseFeatureEligibility(raw: string | undefined): FeatureEligibility | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const out = new Map<SubAccountKind, Set<SubAccountFeature>>();
  for (const part of raw.split(',')) {
    const [kind, list, ...rest] = part.trim().split(':');
    if (rest.length > 0 || !kind || list === undefined) return undefined;
    if (!(SUB_ACCOUNT_KINDS as readonly string[]).includes(kind)) return undefined;
    const features = new Set<SubAccountFeature>();
    for (const name of list
      .split('+')
      .map((f) => f.trim())
      .filter(Boolean)) {
      if (!(SUB_ACCOUNT_FEATURES as readonly string[]).includes(name)) return undefined;
      features.add(name as SubAccountFeature);
    }
    out.set(kind as SubAccountKind, features);
  }
  return out.size > 0 ? out : undefined;
}

export type SubAccountFeatureCode =
  | 'identity.sub_account_not_found'
  | 'identity.sub_account_revoked'
  | 'identity.sub_account_frozen'
  | 'identity.sub_account_features_delegated'
  | 'identity.sub_account_features_unset'
  | 'identity.sub_account_feature_not_offered'
  | 'identity.sub_account_feature_unavailable';

export class SubAccountFeatureError extends Error {
  constructor(readonly code: SubAccountFeatureCode) {
    super(userCopy(code));
    this.name = 'SubAccountFeatureError';
  }
}

type Actor = { userId: string; apiKey: boolean; subAccount: boolean };
export type FeatureRow = { feature: SubAccountFeature; offered: boolean; enabled: boolean };

export class SubAccountFeatureService {
  constructor(private readonly deps: { sql: Sql; eligibility: FeatureEligibility | undefined }) {}

  async get(
    input: Actor & { subAccountId: string },
  ): Promise<{ kind: SubAccountKind; frozen: boolean; published: boolean; features: FeatureRow[] }> {
    this.assertSession(input);
    const row = await this.owned(input.userId, input.subAccountId);
    const on = await this.deps.sql<Array<{ feature: SubAccountFeature }>>`
      SELECT feature FROM sub_account_features WHERE sub_account_id = ${input.subAccountId}
    `;
    const enabled = new Set(on.map((r) => r.feature));
    return {
      kind: row.kind,
      frozen: row.frozen,
      published: this.deps.eligibility !== undefined,
      features: SUB_ACCOUNT_FEATURES.map((feature) => ({
        feature,
        offered: this.offered(row.kind, feature),
        enabled: enabled.has(feature),
      })),
    };
  }

  async set(
    input: Actor & { subAccountId: string; feature: SubAccountFeature; enabled: boolean },
  ): Promise<{ feature: SubAccountFeature; enabled: boolean; changed: boolean }> {
    this.assertSession(input);
    const row = await this.owned(input.userId, input.subAccountId);
    if (row.frozen) throw new SubAccountFeatureError('identity.sub_account_frozen');
    if (input.enabled) {
      if (!this.deps.eligibility) throw new SubAccountFeatureError('identity.sub_account_features_unset');
      // Derivatives eligibility of the main account cannot be read yet, so futures is refused like the derivatives kind.
      if (input.feature === 'futures') throw new SubAccountFeatureError('identity.sub_account_feature_unavailable');
      if (!this.offered(row.kind, input.feature)) throw new SubAccountFeatureError('identity.sub_account_feature_not_offered');
      const result = await this.deps.sql`
        INSERT INTO sub_account_features (sub_account_id, feature) VALUES (${input.subAccountId}, ${input.feature})
        ON CONFLICT DO NOTHING
      `;
      return { feature: input.feature, enabled: true, changed: result.count > 0 };
    }
    // Turning a feature off is always allowed, including one the owner no longer offers.
    const result = await this.deps.sql`
      DELETE FROM sub_account_features WHERE sub_account_id = ${input.subAccountId} AND feature = ${input.feature}
    `;
    return { feature: input.feature, enabled: false, changed: result.count > 0 };
  }

  private offered(kind: SubAccountKind, feature: SubAccountFeature): boolean {
    return feature !== 'futures' && (this.deps.eligibility?.get(kind)?.has(feature) ?? false);
  }

  private assertSession(input: Actor): void {
    if (input.apiKey || input.subAccount) throw new SubAccountFeatureError('identity.sub_account_features_delegated');
  }

  private async owned(userId: string, subAccountId: string): Promise<{ kind: SubAccountKind; frozen: boolean }> {
    const rows = await this.deps.sql<Array<{ kind: SubAccountKind; frozen: number; revoked: boolean }>>`
      SELECT kind, frozen, revoked FROM sub_accounts WHERE id = ${subAccountId} AND parent_user_id = ${userId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new SubAccountFeatureError('identity.sub_account_not_found');
    if (row.revoked) throw new SubAccountFeatureError('identity.sub_account_revoked');
    return { kind: row.kind, frozen: row.frozen === 1 };
  }
}
