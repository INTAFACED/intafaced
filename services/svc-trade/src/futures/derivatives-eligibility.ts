/**
 * Derivatives eligibility with suitability (D-account-07).
 *
 * A derivatives level that is distinct from the generic trade tier. The questions, the answers that count, the pass
 * mark and the minimum verification tier are the owner's content, published through the operator door as a numbered
 * rule version. Nothing here supplies a question, a threshold or a default:
 *
 *   - no published rule version  → the quiz cannot pass and the level stays unset (`trade.derivatives_eligibility_unset`,
 *     reason `rules_unpublished`);
 *   - an assessment is a user's answers, score and result against ONE rule version. A newer rule version makes older
 *     passes stale (reason `rule_version_stale`), so the user takes the new quiz;
 *   - the verification tier is read from the caller's principal, the same claim the jurisdiction matrix already
 *     reads. Where a rule needs a tier and the caller's tier is not known to this check, the open refuses
 *     `trade.identity_level_unavailable`; a tier that is known and too low refuses `trade.identity_level_insufficient`.
 *     No identity vendor is called from this service.
 *
 * Retry key: the business key (user, submission id) the client supplies. A repeat returns the stored result; the
 * same key with different answers is a conflict.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export const ELIGIBILITY_TIERS = ['none', 'basic', 'full', 'institutional'] as const;
export type EligibilityTier = (typeof ELIGIBILITY_TIERS)[number];
const TIER_RANK: Record<EligibilityTier, number> = { none: 0, basic: 1, full: 2, institutional: 3 };

export const ELIGIBILITY_UNSET = 'trade.derivatives_eligibility_unset' as const;
export const IDENTITY_LEVEL_INSUFFICIENT = 'trade.identity_level_insufficient' as const;
export const IDENTITY_LEVEL_UNAVAILABLE = 'trade.identity_level_unavailable' as const;
export const ELIGIBILITY_ANSWERS_INVALID = 'trade.eligibility_answers_invalid' as const;
export const ELIGIBILITY_SUBMISSION_CONFLICT = 'trade.eligibility_submission_conflict' as const;

export type EligibilityRefusalCode =
  | typeof ELIGIBILITY_UNSET
  | typeof IDENTITY_LEVEL_INSUFFICIENT
  | typeof IDENTITY_LEVEL_UNAVAILABLE
  | typeof ELIGIBILITY_ANSWERS_INVALID
  | typeof ELIGIBILITY_SUBMISSION_CONFLICT;

export type EligibilityUnsetReason = 'rules_unpublished' | 'not_assessed' | 'not_passed' | 'rule_version_stale';

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

export interface EligibilityAssessment {
  readonly userId: string;
  readonly submissionId: string;
  readonly ruleVersion: number;
  readonly answers: Readonly<Record<string, string>>;
  readonly answersFingerprint: string;
  readonly score: number;
  readonly passMark: number;
  readonly passed: boolean;
  readonly assessedAt: Date;
}

export interface EligibilityStore {
  currentRules(): Promise<EligibilityRules | null>;
  bySubmission(userId: string, submissionId: string): Promise<EligibilityAssessment | null>;
  /** The newest assessment of the user under this rule version, passed or not. */
  latest(userId: string, ruleVersion: number): Promise<EligibilityAssessment | null>;
  /** The newest passing assessment of the user under this rule version. */
  latestPassed(userId: string, ruleVersion: number): Promise<EligibilityAssessment | null>;
  /** Insert, or return the row already stored under (user, submission id). */
  record(row: EligibilityAssessment): Promise<{ assessment: EligibilityAssessment; created: boolean }>;
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
    this.status = status ?? (code === ELIGIBILITY_ANSWERS_INVALID ? 400 : code === ELIGIBILITY_SUBMISSION_CONFLICT ? 409 : 403);
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

export function answersFingerprint(answers: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(answers)
    .sort()
    .map((k) => [k, answers[k]]);
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`;
}

/** Customer wire for the questions: ids and wording, never the scoring key. */
export function presentQuestions(rules: EligibilityRules): { id: string; prompt: string; options: { id: string; text: string }[] }[] {
  return rules.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options.map((o) => ({ id: o.id, text: o.text })) }));
}

export interface EligibilityState {
  readonly status: 'eligible' | 'unset';
  /** Present when `status` is `unset`. */
  readonly reason: EligibilityUnsetReason | null;
  readonly ruleVersion: number | null;
  readonly passMark: number | null;
  readonly questionCount: number | null;
  readonly minKycTier: EligibilityTier | null;
  readonly identity: { readonly required: EligibilityTier; readonly current: string | null; readonly met: boolean } | null;
  readonly lastScore: number | null;
  readonly lastPassed: boolean | null;
  readonly assessedAt: string | null;
}

/** Where the user stands under the current rules. Reading it never throws for an unset level. */
export async function readEligibilityState(store: EligibilityStore, userId: string, tier: string | null): Promise<EligibilityState> {
  const rules = await store.currentRules();
  if (!rules) {
    return {
      status: 'unset',
      reason: 'rules_unpublished',
      ruleVersion: null,
      passMark: null,
      questionCount: null,
      minKycTier: null,
      identity: null,
      lastScore: null,
      lastPassed: null,
      assessedAt: null,
    };
  }
  const passed = await store.latestPassed(userId, rules.version);
  const latest = passed ?? (await store.latest(userId, rules.version));
  let reason: EligibilityUnsetReason | null = null;
  if (!passed) {
    if (latest) reason = 'not_passed';
    else reason = (await anyEarlierAssessment(store, userId, rules.version)) ? 'rule_version_stale' : 'not_assessed';
  }
  return {
    status: passed ? 'eligible' : 'unset',
    reason,
    ruleVersion: rules.version,
    passMark: rules.passMark,
    questionCount: rules.questions.length,
    minKycTier: rules.minKycTier,
    identity: { required: rules.minKycTier, current: tier, met: tierMeets(tier, rules.minKycTier) },
    lastScore: latest?.score ?? null,
    lastPassed: latest?.passed ?? null,
    assessedAt: latest ? latest.assessedAt.toISOString() : null,
  };
}

async function anyEarlierAssessment(store: EligibilityStore, userId: string, currentVersion: number): Promise<boolean> {
  for (let v = currentVersion - 1; v >= 1; v -= 1) {
    if (await store.latest(userId, v)) return true;
  }
  return false;
}

function tierMeets(tier: string | null, required: EligibilityTier): boolean {
  if (required === 'none') return true;
  if (tier == null || !(tier in TIER_RANK)) return false;
  return TIER_RANK[tier as EligibilityTier] >= TIER_RANK[required];
}

export interface AssessmentResult {
  readonly ruleVersion: number;
  readonly score: number;
  readonly passMark: number;
  readonly passed: boolean;
  readonly assessedAt: string;
  /** False when the submission id was already stored: the first result stands. */
  readonly created: boolean;
}

/** Score a submission against the current rules and store it. Answers are `{ [questionId]: optionId }`. */
export async function assessEligibility(
  store: EligibilityStore,
  input: { userId: string; submissionId: unknown; answers: unknown; now: Date },
): Promise<AssessmentResult> {
  const rules = await store.currentRules();
  if (!rules) {
    throw new EligibilityError(ELIGIBILITY_UNSET, 'No suitability questions have been published, so eligibility cannot be granted yet.', {
      reason: 'rules_unpublished' satisfies EligibilityUnsetReason,
    });
  }
  const submissionId = typeof input.submissionId === 'string' ? input.submissionId.trim() : '';
  if (submissionId.length < 1 || submissionId.length > 64) {
    throw new EligibilityError(ELIGIBILITY_ANSWERS_INVALID, 'clientSubmissionId is required (1-64 chars)');
  }
  const answers = parseAnswers(input.answers, rules);
  const fingerprint = answersFingerprint(answers);
  const prior = await store.bySubmission(input.userId, submissionId);
  if (prior) return replay(prior, fingerprint);

  let score = 0;
  for (const q of rules.questions) if (answers[q.id] === q.correctOptionId) score += 1;
  const { assessment, created } = await store.record({
    userId: input.userId,
    submissionId,
    ruleVersion: rules.version,
    answers,
    answersFingerprint: fingerprint,
    score,
    passMark: rules.passMark,
    passed: score >= rules.passMark,
    assessedAt: input.now,
  });
  if (!created) return replay(assessment, fingerprint);
  return resultOf(assessment, true);
}

function replay(prior: EligibilityAssessment, fingerprint: string): AssessmentResult {
  if (prior.answersFingerprint !== fingerprint) {
    throw new EligibilityError(ELIGIBILITY_SUBMISSION_CONFLICT, 'clientSubmissionId was already used with different answers.');
  }
  return resultOf(prior, false);
}

function resultOf(a: EligibilityAssessment, created: boolean): AssessmentResult {
  return {
    ruleVersion: a.ruleVersion,
    score: a.score,
    passMark: a.passMark,
    passed: a.passed,
    assessedAt: a.assessedAt.toISOString(),
    created,
  };
}

function parseAnswers(raw: unknown, rules: EligibilityRules): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EligibilityError(ELIGIBILITY_ANSWERS_INVALID, 'answers must be an object of questionId to optionId');
  }
  const given = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const q of rules.questions) {
    const value = given[q.id];
    if (typeof value !== 'string' || !q.options.some((o) => o.id === value)) {
      throw new EligibilityError(ELIGIBILITY_ANSWERS_INVALID, `question ${q.id} needs one of its offered options`, { questionId: q.id });
    }
    out[q.id] = value;
  }
  for (const key of Object.keys(given)) {
    if (!rules.questions.some((q) => q.id === key)) {
      throw new EligibilityError(ELIGIBILITY_ANSWERS_INVALID, `unknown question ${key}`, { questionId: key });
    }
  }
  return out;
}

/**
 * Gate for a futures open. `tier` is the caller's verification tier from the principal, or null where the caller
 * did not hand one in. Order: rules published, level granted under the CURRENT rule version, then the tier.
 */
export async function assertEligible(store: EligibilityStore, input: { userId: string; tier: string | null }): Promise<void> {
  const state = await readEligibilityState(store, input.userId, input.tier);
  if (state.status !== 'eligible') {
    throw new EligibilityError(
      ELIGIBILITY_UNSET,
      state.reason === 'rules_unpublished'
        ? 'Derivatives eligibility is not set up yet, so positions cannot be opened.'
        : 'Complete the derivatives suitability questions before opening a position.',
      { reason: state.reason, ruleVersion: state.ruleVersion },
    );
  }
  const required = state.minKycTier!;
  if (required === 'none') return;
  if (input.tier == null) {
    throw new EligibilityError(IDENTITY_LEVEL_UNAVAILABLE, 'Your verification level could not be read, so positions cannot be opened.', {
      requiredTier: required,
    });
  }
  if (!state.identity!.met) {
    throw new EligibilityError(IDENTITY_LEVEL_INSUFFICIENT, 'Your verification level is below what derivatives need.', {
      requiredTier: required,
      currentTier: input.tier,
    });
  }
}

/** In-memory store for hermetic tests. `publish` is a test seam; production publishes through the operator door. */
export function memoryEligibilityStore(): EligibilityStore & { publish(rules: EligibilityRules): void } {
  const rulesList: EligibilityRules[] = [];
  const rows = new Map<string, EligibilityAssessment>();
  const mine = (userId: string, ruleVersion: number) =>
    [...rows.values()]
      .filter((r) => r.userId === userId && r.ruleVersion === ruleVersion)
      .sort((a, b) => b.assessedAt.getTime() - a.assessedAt.getTime());
  return {
    publish: (rules) => void rulesList.push(rules),
    async currentRules() {
      return rulesList.reduce<EligibilityRules | null>((best, r) => (best === null || r.version > best.version ? r : best), null);
    },
    async bySubmission(userId, submissionId) {
      return rows.get(`${userId}|${submissionId}`) ?? null;
    },
    async latest(userId, ruleVersion) {
      return mine(userId, ruleVersion)[0] ?? null;
    },
    async latestPassed(userId, ruleVersion) {
      return mine(userId, ruleVersion).find((r) => r.passed) ?? null;
    },
    async record(row) {
      const key = `${row.userId}|${row.submissionId}`;
      const existing = rows.get(key);
      if (existing) return { assessment: existing, created: false };
      rows.set(key, row);
      return { assessment: row, created: true };
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

interface AssessmentRow {
  user_id: string;
  submission_id: string;
  rule_version: number;
  answers: Record<string, string>;
  answers_fingerprint: string;
  score: number;
  pass_mark: number;
  passed: boolean;
  assessed_at: Date;
}

function assessmentOf(r: AssessmentRow): EligibilityAssessment {
  return {
    userId: r.user_id,
    submissionId: r.submission_id,
    ruleVersion: r.rule_version,
    answers: r.answers,
    answersFingerprint: r.answers_fingerprint,
    score: r.score,
    passMark: r.pass_mark,
    passed: r.passed,
    assessedAt: r.assessed_at,
  };
}

const ASSESSMENT_COLUMNS = `user_id::text, submission_id, rule_version::int AS rule_version, answers, answers_fingerprint,
  score, pass_mark, passed, assessed_at`;

/** Durable store over `trade.derivatives_eligibility_*` (migration 0082). */
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
    async bySubmission(userId, submissionId) {
      const [row] = await sql<AssessmentRow[]>`
        SELECT ${sql.unsafe(ASSESSMENT_COLUMNS)} FROM trade.derivatives_eligibility_assessments
         WHERE user_id = ${userId} AND submission_id = ${submissionId}`;
      return row ? assessmentOf(row) : null;
    },
    async latest(userId, ruleVersion) {
      const [row] = await sql<AssessmentRow[]>`
        SELECT ${sql.unsafe(ASSESSMENT_COLUMNS)} FROM trade.derivatives_eligibility_assessments
         WHERE user_id = ${userId} AND rule_version = ${ruleVersion}
         ORDER BY assessed_at DESC, submission_id DESC LIMIT 1`;
      return row ? assessmentOf(row) : null;
    },
    async latestPassed(userId, ruleVersion) {
      const [row] = await sql<AssessmentRow[]>`
        SELECT ${sql.unsafe(ASSESSMENT_COLUMNS)} FROM trade.derivatives_eligibility_assessments
         WHERE user_id = ${userId} AND rule_version = ${ruleVersion} AND passed
         ORDER BY assessed_at DESC, submission_id DESC LIMIT 1`;
      return row ? assessmentOf(row) : null;
    },
    async record(row) {
      const inserted = await sql<AssessmentRow[]>`
        INSERT INTO trade.derivatives_eligibility_assessments (
          user_id, submission_id, rule_version, answers, answers_fingerprint, score, pass_mark, passed, assessed_at
        ) VALUES (
          ${row.userId}, ${row.submissionId}, ${row.ruleVersion}, ${sql.json(row.answers as never)}, ${row.answersFingerprint},
          ${row.score}, ${row.passMark}, ${row.passed}, ${row.assessedAt}
        )
        ON CONFLICT (user_id, submission_id) DO NOTHING
        RETURNING ${sql.unsafe(ASSESSMENT_COLUMNS)}`;
      if (inserted[0]) return { assessment: assessmentOf(inserted[0]), created: true };
      const [existing] = await sql<AssessmentRow[]>`
        SELECT ${sql.unsafe(ASSESSMENT_COLUMNS)} FROM trade.derivatives_eligibility_assessments
         WHERE user_id = ${row.userId} AND submission_id = ${row.submissionId}`;
      return { assessment: assessmentOf(existing!), created: false };
    },
  };
}
