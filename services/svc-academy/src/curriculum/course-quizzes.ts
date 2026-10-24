/**
 * AC-quizzes-01 — quizzes on the items of a course staff made, and their attempt rules.
 *
 * Staff save a quiz item's questions and rules as a draft over the revision they read, then publish it. Publish refuses
 * what would leave learners with a quiz nobody can be marked on: no questions (`academy.quiz_no_questions`), a blank pass
 * mark (`academy.pass_mark_unset`), and more than one attempt with no scoring policy across them
 * (`academy.scoring_policy_unset`). Once a learner has an attempt the quiz keeps its questions and stays published
 * (`academy.item_has_attempts`); its rules still change. A null attempt or time limit is the author's choice of none.
 *
 * Learners take a published quiz through the existing attempt engine, with the item id as the slug: the attempt keeps its
 * own copy of the quiz, so a later edit never rescores it. Each start checks enrolment, then the access code (kept only
 * as a salted scrypt hash, never read back) and then the IP filter: a caller address the service cannot read refuses
 * `academy.ip_unreadable`, one outside the list `academy.ip_not_allowed`. Every save, publish and take-down is an event
 * row with who and why. No money moves here.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BlockList, isIP } from 'node:net';
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyAdminCourseQuiz,
  AcademyCourseQuizBlocker,
  AcademyCourseQuizQuestion,
  AcademyCourseQuizState,
  AcademyLearnerCourseQuiz,
  AcademyQuizAttempt,
  AcademyQuizReviewMode,
  AcademyQuizScoringPolicy,
  AcademySaveCourseQuizInput,
  AcademySetCourseQuizStateInput,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import type { AssessmentDefinition } from '../assessment/catalog.js';

type Db = Sql | TransactionSql;

type QuizRow = {
  item_id: string;
  course_id: string;
  title: string;
  kind: string;
  revision: number | null;
  state: AcademyCourseQuizState | null;
  questions: AcademyCourseQuizQuestion[] | null;
  pass_mark: number | null;
  attempt_limit: number | null;
  scoring_policy: AcademyQuizScoringPolicy | null;
  time_limit_seconds: number | null;
  review_mode: AcademyQuizReviewMode | null;
  access_code_hash: string | null;
  ip_allow: string[] | null;
  saved_by: string | null;
  saved_at: Date | null;
  published_at: Date | null;
};

type LearnerRow = QuizRow & { course_slug: string; course_title: string; course_state: string; enrolled: boolean };

const columns = (sql: Db) => sql`
  i.id AS item_id, i.course_id, i.title, i.kind, q.revision, q.state, q.questions, q.pass_mark, q.attempt_limit, q.scoring_policy,
  q.time_limit_seconds, q.review_mode, q.access_code_hash, q.ip_allow, q.saved_by, q.saved_at, q.published_at
`;

/** What stops a draft from being published, in the order the editor lists them. Pure. */
export function publishBlockers(quiz: {
  questions: readonly unknown[];
  passMark: number | null;
  attemptLimit: number | null;
  scoringPolicy: AcademyQuizScoringPolicy | null;
}): AcademyCourseQuizBlocker[] {
  return [
    ...(quiz.questions.length === 0 ? (['academy.quiz_no_questions'] as const) : []),
    ...(quiz.passMark === null ? (['academy.pass_mark_unset'] as const) : []),
    ...(quiz.attemptLimit !== 1 && quiz.scoringPolicy === null ? (['academy.scoring_policy_unset'] as const) : []),
  ];
}

const scryptAsync = promisify(scrypt) as (code: string, salt: Buffer, length: number) => Promise<Buffer>;

/** The salted hash an access code is kept as: `scrypt$<salt>$<hash>`, hex. Off the event loop. */
export async function hashAccessCode(code: string, salt: Buffer = randomBytes(16)): Promise<string> {
  return `scrypt$${salt.toString('hex')}$${(await scryptAsync(code, salt, 32)).toString('hex')}`;
}

/** Whether a typed code matches the stored hash, compared in constant time. A malformed hash matches nothing. */
export async function accessCodeMatches(code: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== 32) return false;
  return timingSafeEqual(expected, await scryptAsync(code, Buffer.from(salt, 'hex'), 32));
}

/** An IPv4 address written IPv4-mapped (`::ffff:203.0.113.7`) as plain IPv4, so it meets IPv4 rules; any other as given. */
export const unmapped = (address: string) => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address) ? address.slice(7) : address);

/** One rule as a block-list entry, or null when it is not an address or range. Pure. */
function ruleOf(rule: string): { address: string; prefix: number | null; family: 'ipv4' | 'ipv6' } | null {
  const slash = rule.lastIndexOf('/');
  const address = slash === -1 ? rule : rule.slice(0, slash);
  const family = isIP(address);
  if (!family || address.includes('%')) return null;
  if (slash === -1) return { address, prefix: null, family: family === 4 ? 'ipv4' : 'ipv6' };
  const prefix = rule.slice(slash + 1);
  if (!/^(0|[1-9]\d*)$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) return null;
  return { address, prefix: Number(prefix), family: family === 4 ? 'ipv4' : 'ipv6' };
}

/** The IP filter as typed, checked: every entry an address or a CIDR range. Refuses `academy.ip_rule_invalid`. */
export function checkIpRules(rules: readonly string[] | null): string[] | null {
  if (rules === null) return null;
  const out = rules.map((r) => r.trim());
  for (const rule of out) if (!ruleOf(rule)) throw new AcademyError(`academy.ip_rule_invalid ${rule}`, 'academy.ip_rule_invalid');
  return out;
}

/** Whether `address` is inside one of `rules`. Pure. */
export function addressAllowed(address: string, rules: readonly string[]): boolean {
  const list = new BlockList();
  for (const rule of rules) {
    const r = ruleOf(rule);
    if (!r) continue;
    if (r.prefix === null) list.addAddress(r.address, r.family);
    else list.addSubnet(r.address, r.prefix, r.family);
  }
  const plain = unmapped(address);
  const family = isIP(plain);
  return family !== 0 && list.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

/** Questions as one string with a fixed key order (jsonb keeps its own), to tell whether a save changes them. */
const canonical = (questions: readonly AcademyCourseQuizQuestion[]) =>
  JSON.stringify(questions.map((q) => [q.id, q.prompt, q.points, q.choices.map((c) => [c.id, c.text]), q.correctChoiceId]));

/** The published quiz as the attempt engine scores it; the item id is its slug. */
function definitionOf(row: QuizRow): AssessmentDefinition {
  return {
    slug: row.item_id,
    kind: 'quiz',
    passMark: row.pass_mark,
    attemptLimit: row.attempt_limit,
    cooldownSeconds: null,
    timeLimitSeconds: row.time_limit_seconds,
    reviewMode: row.review_mode ?? 'score_only',
    questions: (row.questions ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      kind: 'single' as const,
      points: q.points,
      choices: q.choices.map((c) => ({ id: c.id, text: c.text })),
      correctChoiceId: q.correctChoiceId,
    })),
  };
}

export type StartAttemptFn = (input: {
  userId: string;
  slug: string;
  now: Date;
  definition: AssessmentDefinition;
  tx: Sql;
}) => Promise<AcademyQuizAttempt>;

export class CourseQuizzes {
  constructor(private readonly sql: Sql) {}

  /** A quiz item as staff see it. A quiz item with nothing saved yet is revision 0, a draft with no questions. */
  async adminView(itemId: string): Promise<AcademyAdminCourseQuiz> {
    return this.adminIn(this.sql, await this.row(this.sql, itemId));
  }

  /** The draft over the revision read. Questions change only while no learner has an attempt; rules always may. */
  async save(input: AcademySaveCourseQuizInput & { operatorId: string; now: Date }): Promise<AcademyAdminCourseQuiz> {
    const ipAllow = checkIpRules(input.ipAllow);
    if (input.passMark !== null && input.passMark > input.questions.reduce((sum, q) => sum + q.points, 0))
      throw new AcademyError("academy.assessment_invalid the pass mark is more than the questions' points", 'academy.assessment_invalid');
    const newCode = typeof input.accessCode === 'string' ? await hashAccessCode(input.accessCode) : null;
    return this.sql.begin(async (tx) => {
      const row = await this.row(tx, input.itemId, true);
      const revision = row.revision ?? 0;
      if (revision !== input.revision)
        throw new AcademyError(`the quiz is at revision ${revision}, not ${input.revision}`, 'academy.revision_stale');
      const attempts = await this.attempts(tx, row.item_id);
      if (attempts > 0 && canonical(row.questions ?? []) !== canonical(input.questions))
        throw new AcademyError('learners have attempted this quiz, so its questions stay as they are', 'academy.item_has_attempts');
      const state = row.state ?? 'draft';
      // A published quiz stays publishable: a save that would block it refuses with the first blocker.
      const blockers = publishBlockers(input);
      if (state === 'published' && blockers.length > 0) throw new AcademyError(blockers[0]!, blockers[0]!);
      const code = input.accessCode === undefined ? row.access_code_hash : input.accessCode === null ? null : newCode;
      await tx`
        INSERT INTO academy.course_quizzes
          (item_id, revision, state, questions, pass_mark, attempt_limit, scoring_policy, time_limit_seconds, review_mode,
           access_code_hash, ip_allow, saved_by, saved_at)
        VALUES (${row.item_id}, ${revision + 1}, 'draft', ${tx.json(input.questions as never)}, ${input.passMark}, ${input.attemptLimit},
                ${input.scoringPolicy}, ${input.timeLimitSeconds}, ${input.reviewMode}, ${code}, ${ipAllow}, ${input.operatorId}, ${input.now})
        ON CONFLICT (item_id) DO UPDATE SET
          revision = EXCLUDED.revision, questions = EXCLUDED.questions, pass_mark = EXCLUDED.pass_mark,
          attempt_limit = EXCLUDED.attempt_limit, scoring_policy = EXCLUDED.scoring_policy,
          time_limit_seconds = EXCLUDED.time_limit_seconds, review_mode = EXCLUDED.review_mode,
          access_code_hash = EXCLUDED.access_code_hash, ip_allow = EXCLUDED.ip_allow, saved_by = EXCLUDED.saved_by,
          saved_at = EXCLUDED.saved_at
      `;
      await this.event(tx, row.item_id, revision + 1, 'saved', null, input.operatorId, input.now);
      return this.adminIn(tx, await this.row(tx, row.item_id));
    });
  }

  /** Publish when nothing blocks it, or take back to draft while no learner has an attempt. A repeat answers as stored. */
  async setState(input: AcademySetCourseQuizStateInput & { operatorId: string; now: Date }): Promise<AcademyAdminCourseQuiz> {
    return this.sql.begin(async (tx) => {
      const row = await this.row(tx, input.itemId, true);
      if (row.revision === null) throw new AcademyError('the quiz has nothing saved to publish', 'academy.quiz_no_questions');
      if (row.state === input.state) return this.adminIn(tx, row);
      if (input.state === 'published') {
        const blockers = publishBlockers({
          questions: row.questions ?? [],
          passMark: row.pass_mark,
          attemptLimit: row.attempt_limit,
          scoringPolicy: row.scoring_policy,
        });
        if (blockers.length > 0) throw new AcademyError(`${blockers[0]} blockers=${blockers.join(',')}`, blockers[0]!);
      } else if ((await this.attempts(tx, row.item_id)) > 0) {
        throw new AcademyError('learners have attempted this quiz, so it stays published', 'academy.item_has_attempts');
      }
      await tx`
        UPDATE academy.course_quizzes
        SET state = ${input.state}, published_at = ${input.state === 'published' ? input.now : null}
        WHERE item_id = ${row.item_id}
      `;
      await this.event(
        tx,
        row.item_id,
        row.revision,
        input.state === 'published' ? 'published' : 'unpublished',
        input.reason,
        input.operatorId,
        input.now,
      );
      return this.adminIn(tx, await this.row(tx, row.item_id));
    });
  }

  /** The published quiz as the enrolled learner reads it: no key, no code, no filter. Writes nothing. */
  async learnerView(input: { itemId: string; userId: string }): Promise<AcademyLearnerCourseQuiz> {
    const row = await this.learnerRow(this.sql, input.itemId, input.userId);
    const [used] = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM academy.quiz_attempts WHERE user_id = ${input.userId} AND slug = ${row.item_id}
    `;
    return {
      itemId: row.item_id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      title: row.title,
      passMark: row.pass_mark!,
      attemptLimit: row.attempt_limit,
      timeLimitSeconds: row.time_limit_seconds,
      reviewMode: row.review_mode ?? 'score_only',
      accessCodeRequired: row.access_code_hash !== null,
      attemptsUsed: used!.n,
      questions: (row.questions ?? []).map((q) => ({
        id: q.id,
        prompt: q.prompt,
        kind: 'single' as const,
        points: q.points,
        choices: q.choices.map((c) => ({ id: c.id, text: c.text })),
      })),
    };
  }

  /**
   * Start (or get back) the learner's attempt. Enrolment first, then the access code, then the IP filter, so a refusal
   * never tells someone outside the course what the quiz asks for. `clientAddress` is null when it cannot be read.
   */
  async start(
    input: { itemId: string; userId: string; accessCode: string | null; clientAddress: string | null; now: Date },
    startAttempt: StartAttemptFn,
  ): Promise<AcademyQuizAttempt> {
    // Checked outside the hold: hashing a typed code takes time and reads only the stored hash.
    const checked = await this.learnerRow(this.sql, input.itemId, input.userId);
    if (checked.access_code_hash !== null && !(input.accessCode && (await accessCodeMatches(input.accessCode, checked.access_code_hash))))
      throw new AcademyError('academy.access_code_invalid', 'academy.access_code_invalid');
    // Read again holding the item, as a take-down or a question change does, so neither slips in before the attempt lands.
    return this.sql.begin(async (tx) => {
      const row = await this.learnerRow(tx, input.itemId, input.userId, true);
      if (row.access_code_hash !== checked.access_code_hash)
        throw new AcademyError('academy.access_code_invalid the code changed; start again', 'academy.access_code_invalid');
      if (row.ip_allow !== null) {
        const address = input.clientAddress === null ? null : unmapped(input.clientAddress);
        if (address === null || isIP(address) === 0)
          throw new AcademyError('academy.ip_unreadable the caller address could not be read', 'academy.ip_unreadable');
        if (!addressAllowed(address, row.ip_allow)) throw new AcademyError('academy.ip_not_allowed', 'academy.ip_not_allowed');
      }
      return startAttempt({
        userId: input.userId,
        slug: row.item_id,
        now: input.now,
        definition: definitionOf(row),
        tx: tx as unknown as Sql,
      });
    });
  }

  private async learnerRow(sql: Db, itemId: string, userId: string, lock = false): Promise<LearnerRow> {
    const [row] = await sql<LearnerRow[]>`
      SELECT ${columns(sql)}, c.slug AS course_slug, c.title AS course_title, c.state AS course_state,
        EXISTS (SELECT 1 FROM academy.course_enrolments e
          WHERE e.course_id = c.id AND e.user_id = ${userId} AND e.left_at IS NULL) AS enrolled
      FROM academy.course_items i
      JOIN academy.courses c ON c.id = i.course_id
      LEFT JOIN academy.course_quizzes q ON q.item_id = i.id
      WHERE i.id = ${itemId}
      ${lock ? sql`FOR SHARE OF i` : sql``}
    `;
    // A draft course, an item that is not a quiz and a quiz not published are the same as no quiz at all.
    if (!row || row.kind !== 'quiz' || row.state !== 'published' || row.course_state !== 'published')
      throw new AcademyError('no quiz is open at that address', 'academy.assessment_unpublished');
    if (!row.enrolled) throw new AcademyError(`academy.enrolment_required course=${row.course_slug}`, 'academy.enrolment_required');
    return row;
  }

  private async row(sql: Db, itemId: string, lock = false): Promise<QuizRow> {
    const [row] = await sql<QuizRow[]>`
      SELECT ${columns(sql)}
      FROM academy.course_items i LEFT JOIN academy.course_quizzes q ON q.item_id = i.id
      WHERE i.id = ${itemId}
      ${lock ? sql`FOR UPDATE OF i` : sql``}
    `;
    if (!row) throw new AcademyError('no outline item with that id', 'academy.outline_item_unknown');
    if (row.kind !== 'quiz') throw new AcademyError(`a ${row.kind} is not a quiz`, 'academy.quiz_not_found');
    return row;
  }

  private async attempts(sql: Db, itemId: string): Promise<number> {
    const [counted] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM academy.quiz_attempts WHERE slug = ${itemId}`;
    return counted!.n;
  }

  private async event(sql: Db, itemId: string, revision: number, kind: string, reason: string | null, actorId: string, at: Date) {
    await sql`
      INSERT INTO academy.course_quiz_events (item_id, revision, kind, reason, actor_id, at)
      VALUES (${itemId}, ${revision}, ${kind}, ${reason}, ${actorId}, ${at})
    `;
  }

  private async adminIn(sql: Db, row: QuizRow): Promise<AcademyAdminCourseQuiz> {
    const questions = row.questions ?? [];
    const quiz = {
      passMark: row.pass_mark,
      attemptLimit: row.attempt_limit,
      scoringPolicy: row.scoring_policy,
      timeLimitSeconds: row.time_limit_seconds,
      reviewMode: row.review_mode ?? 'score_only',
      ipAllow: row.ip_allow,
    };
    return {
      itemId: row.item_id,
      courseId: row.course_id,
      title: row.title,
      revision: row.revision ?? 0,
      state: row.state ?? 'draft',
      ...quiz,
      accessCodeSet: row.access_code_hash !== null,
      questions,
      savedBy: row.saved_by,
      savedAt: row.saved_at?.toISOString() ?? null,
      publishedAt: row.published_at?.toISOString() ?? null,
      attempts: await this.attempts(sql, row.item_id),
      blockers: publishBlockers({ questions, ...quiz }),
    };
  }
}

/**
 * The caller address an IP filter checks: the edge's `x-intafaced-client-ip`, believed only from a socket peer inside
 * `cidrs`. Blank `cidrs`, a peer outside them or a missing header give null: the address cannot be read. A configured
 * range that is not one throws at startup.
 */
export function createQuizAddressResolver(cidrs: string | undefined): (peer: string | undefined, header: unknown) => string | null {
  const rules = cidrs === undefined || cidrs.trim() === '' ? [] : cidrs.split(',').map((c) => c.trim());
  for (const rule of rules)
    if (!rule.includes('/') || !ruleOf(rule)) throw new Error(`ACADEMY_TRUSTED_PROXY_CIDRS: ${rule} is not a CIDR range`);
  return (peer, header) => {
    if (rules.length === 0 || typeof peer !== 'string' || !addressAllowed(peer, rules)) return null;
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== 'string') return null;
    const address = unmapped(value.trim());
    return isIP(address) === 0 ? null : address;
  };
}
