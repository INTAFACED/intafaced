/**
 * The identity level a futures open needs (D-account-07).
 *
 * The operator's published eligibility rule version names the minimum verification tier for derivatives. That tier
 * is the whole gate: the suitability quiz no longer gates an open (owner decision 2026-10-27, until launch prep), so
 * its questions and pass mark are kept only as the operator's published content.
 *
 *   - no published rule version → every open refuses `trade.identity_level_unset` (a blank setting stays blank);
 *   - a published version whose tier is `none` → no derivatives-specific tier; the jurisdiction matrix still reads the
 *     caller's tier on every order;
 *   - the verification tier is read from the caller's principal, the same claim the jurisdiction matrix already
 *     reads. Where a rule needs a tier and the caller's tier is not known to this check, the open refuses
 *     `trade.identity_level_unavailable`; a tier that is known and too low refuses `trade.identity_level_insufficient`.
 *     No identity vendor is called from this service.
 *
 * A rules read that fails throws, so the open refuses rather than skip the tier.
 */
import type { Sql } from 'postgres';

export const ELIGIBILITY_TIERS = ['none', 'basic', 'full', 'institutional'] as const;
export type EligibilityTier = (typeof ELIGIBILITY_TIERS)[number];
const TIER_RANK: Record<EligibilityTier, number> = { none: 0, basic: 1, full: 2, institutional: 3 };

export const IDENTITY_LEVEL_INSUFFICIENT = 'trade.identity_level_insufficient' as const;
export const IDENTITY_LEVEL_UNAVAILABLE = 'trade.identity_level_unavailable' as const;
/** No derivatives verification level is published: a blank setting refuses, it never means "no requirement". */
export const IDENTITY_LEVEL_UNSET = 'trade.identity_level_unset' as const;

export type EligibilityRefusalCode = typeof IDENTITY_LEVEL_INSUFFICIENT | typeof IDENTITY_LEVEL_UNAVAILABLE | typeof IDENTITY_LEVEL_UNSET;

export interface EligibilityQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  /** The option that scores. Never sent to the customer. */
  readonly correctOptionId: string;
}

export interface EligibilityRules {
  readonly version: number;
  readonly questions: readonly EligibilityQuestion[];
  /** Whole number of correct answers needed, 1..questions.length. */
  readonly passMark: number;
  readonly minKycTier: EligibilityTier;
  readonly createdAt: Date;
}

export interface EligibilityStore {
  /** The newest published rule version, or null when none is published. */
  currentRules(): Promise<EligibilityRules | null>;
}

export class EligibilityError extends Error {
  readonly status: number;

  constructor(
    readonly code: EligibilityRefusalCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
    status?: number,
  ) {
    super(message);
    this.name = 'EligibilityError';
    this.status = status ?? 403;
  }
}

/** Why rules cannot be published: every part of the content must be the owner's, so a blank part is refused. */
export function validateEligibilityRules(input: {
  questions: readonly EligibilityQuestion[];
  passMark: number;
  minKycTier: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(input.questions) || input.questions.length < 1) return { ok: false, reason: 'at least one question is required' };
  const questionIds = new Set<string>();
  for (const q of input.questions) {
    if (!q.id.trim() || !q.prompt.trim()) return { ok: false, reason: 'every question needs an id and a prompt' };
    if (questionIds.has(q.id)) return { ok: false, reason: `duplicate question id ${q.id}` };
    questionIds.add(q.id);
    if (q.options.length < 2) return { ok: false, reason: `question ${q.id} needs at least two options` };
    const optionIds = new Set<string>();
    for (const o of q.options) {
      if (!o.id.trim() || !o.text.trim()) return { ok: false, reason: `question ${q.id} has a blank option` };
      if (optionIds.has(o.id)) return { ok: false, reason: `question ${q.id} repeats option id ${o.id}` };
      optionIds.add(o.id);
    }
    if (!optionIds.has(q.correctOptionId)) return { ok: false, reason: `question ${q.id} names a correct option it does not offer` };
  }
  if (!Number.isInteger(input.passMark) || input.passMark < 1 || input.passMark > input.questions.length) {
    return { ok: false, reason: 'passMark must be a whole number from 1 to the number of questions' };
  }
  if (!(ELIGIBILITY_TIERS as readonly string[]).includes(input.minKycTier)) {
    return { ok: false, reason: `minKycTier must be one of ${ELIGIBILITY_TIERS.join(', ')}` };
  }
  return { ok: true };
}

function tierMeets(tier: string, required: EligibilityTier): boolean {
  if (required === 'none') return true;
  if (!(tier in TIER_RANK)) return false;
  return TIER_RANK[tier as EligibilityTier] >= TIER_RANK[required];
}

/**
 * Gate for a futures open. `tier` is the caller's verification tier from the principal, or null where the caller
 * did not hand one in. The required tier is the published rules' `minKycTier`; with none published every open refuses
 * `trade.identity_level_unset` (a blank setting stays blank).
 */
export async function assertIdentityLevel(store: EligibilityStore, input: { userId: string; tier: string | null }): Promise<void> {
  const rules = await store.currentRules();
  if (!rules) {
    throw new EligibilityError(
      IDENTITY_LEVEL_UNSET,
      'The verification level for derivatives is not published, so positions cannot be opened.',
      {
        requiredTier: null,
      },
    );
  }
  const required = rules.minKycTier;
  if (required === 'none') return;
  if (input.tier == null) {
    throw new EligibilityError(IDENTITY_LEVEL_UNAVAILABLE, 'Your verification level could not be read, so positions cannot be opened.', {
      requiredTier: required,
    });
  }
  if (!tierMeets(input.tier, required)) {
    throw new EligibilityError(IDENTITY_LEVEL_INSUFFICIENT, 'Your verification level is below what derivatives need.', {
      requiredTier: required,
      currentTier: input.tier,
    });
  }
}

/** In-memory store for hermetic tests. `publish` is a test seam; production publishes through the operator door. */
export function memoryEligibilityStore(): EligibilityStore & { publish(rules: EligibilityRules): void } {
  const rulesList: EligibilityRules[] = [];
  return {
    publish: (rules) => void rulesList.push(rules),
    async currentRules() {
      return rulesList.reduce<EligibilityRules | null>((best, r) => (best === null || r.version > best.version ? r : best), null);
    },
  };
}

interface RulesRow {
  version: number;
  questions: EligibilityQuestion[];
  pass_mark: number;
  min_kyc_tier: EligibilityTier;
  created_at: Date;
}

/** Durable read of `trade.derivatives_eligibility_rules` (migration 0082). */
export function sqlEligibilityStore(sql: Sql): EligibilityStore {
  return {
    async currentRules() {
      const [row] = await sql<RulesRow[]>`
        SELECT version::int AS version, questions, pass_mark, min_kyc_tier, created_at
          FROM trade.derivatives_eligibility_rules
         ORDER BY version DESC
         LIMIT 1`;
      return row
        ? {
            version: row.version,
            questions: row.questions,
            passMark: row.pass_mark,
            minKycTier: row.min_kyc_tier,
            createdAt: row.created_at,
          }
        : null;
    },
  };
}
