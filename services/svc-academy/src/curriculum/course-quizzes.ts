/**
 * AC-quizzes-01 and AC-quizzes-02 — quizzes and surveys on the items of a course staff made, and their attempts.
 *
 * Staff save a quiz item's questions and rules as a draft over the revision they read, then publish it. Publish refuses
 * what would leave learners with a quiz nobody can be marked on: no questions (`academy.quiz_no_questions`), a blank pass
 * mark (`academy.pass_mark_unset`), and more than one attempt with no scoring policy across them
 * (`academy.scoring_policy_unset`). Once a learner has an attempt (or a survey a response) the questions stay as they are
 * and it stays published (`academy.item_has_attempts`); its rules still change. A null attempt or time limit is the
 * author's choice of none.
 *
 * A question is single choice, multi-select (with or without partial credit), numeric (an exact decimal within a
 * tolerance) or essay. Attempts are this module's own rows: each keeps its copy of the questions, so a later edit never
 * rescores it. An attempt with an essay is pending review until staff score it, under an alias, never the account. The
 * score shows as the quiz's results visibility allows. A survey has no key and no score; an anonymous survey stores no
 * account with its answers, only the one-way hash of a token the learner's device keeps.
 *
 * Each start checks enrolment, then the access code (kept only as a salted scrypt hash, never read back) and then the IP
 * filter: a caller address the service cannot read refuses `academy.ip_unreadable`, one outside the list
 * `academy.ip_not_allowed`. Every save, publish, take-down and essay score is an event row with who. No money moves here.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BlockList, isIP } from 'node:net';
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyAdminCourseQuiz,
  AcademyCourseQuizAnswer,
  AcademyCourseQuizAttempt,
  AcademyCourseQuizBlocker,
  AcademyCourseQuizKind,
  AcademyCourseQuizQuestion,
  AcademyCourseQuizReview,
  AcademyCourseQuizState,
  AcademyLearnerCourseQuiz,
  AcademyQuizReviewMode,
  AcademyQuizScoringPolicy,
  AcademyResultsVisibility,
  AcademySaveCourseQuizInput,
  AcademySetCourseQuizStateInput,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { answerFits, scoreAttempt, scoreQuestion } from './course-quiz-score.js';
import { assertItemOpen } from './course-release.js';

type Db = Sql | TransactionSql;

type QuizRow = {
  item_id: string;
  course_id: string;
  title: string;
  /** The outline item's kind; the quiz's own kind is `quiz_kind`. */
  kind: string;
  quiz_kind: AcademyCourseQuizKind | null;
  anonymous: boolean | null;
  results_visibility: AcademyResultsVisibility | null;
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

type AttemptRow = {
  id: string;
  item_id: string;
  user_id: string;
  number: number;
  started_at: Date;
  deadline_at: Date | null;
  quiz: { questions: AcademyCourseQuizQuestion[]; passMark: number };
  answers: Record<string, AcademyCourseQuizAnswer>;
  finished_at: Date | null;
  state: 'open' | 'pending_review' | 'graded';
  auto_score: number | null;
  max_score: number | null;
  essay_points: Record<string, number> | null;
  score: number | null;
  passed: boolean | null;
};

const columns = (sql: Db) => sql`
  i.id AS item_id, i.course_id, i.title, i.kind, q.kind AS quiz_kind, q.anonymous, q.results_visibility, q.revision, q.state,
  q.questions, q.pass_mark, q.attempt_limit, q.scoring_policy, q.time_limit_seconds, q.review_mode, q.access_code_hash, q.ip_allow,
  q.saved_by, q.saved_at, q.published_at
`;

const ATTEMPT = (sql: Db) => sql`
  id, item_id, user_id, number, started_at, deadline_at, quiz, answers, finished_at, state, auto_score, max_score, essay_points,
  score, passed
`;

/** Questions as stored. A question saved before question kinds existed is single choice. */
export function questionsOf(row: { questions: AcademyCourseQuizQuestion[] | null }): AcademyCourseQuizQuestion[] {
  return (row.questions ?? []).map((q) =>
    'kind' in q && q.kind ? q : ({ ...(q as object), kind: 'single' } as AcademyCourseQuizQuestion),
  );
}

/** What stops a draft from being published, in the order the editor lists them. A survey needs only questions. Pure. */
export function publishBlockers(quiz: {
  kind: AcademyCourseQuizKind;
  questions: readonly unknown[];
  passMark: number | null;
  attemptLimit: number | null;
  scoringPolicy: AcademyQuizScoringPolicy | null;
}): AcademyCourseQuizBlocker[] {
  const graded = quiz.kind === 'quiz';
  return [
    ...(quiz.questions.length === 0 ? (['academy.quiz_no_questions'] as const) : []),
    ...(graded && quiz.passMark === null ? (['academy.pass_mark_unset'] as const) : []),
    ...(graded && quiz.attemptLimit !== 1 && quiz.scoringPolicy === null ? (['academy.scoring_policy_unset'] as const) : []),
  ];
}

/** A value as one string with its object keys sorted (jsonb keeps its own order), to tell whether a save changes it. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Each answer of a graded attempt against the key of its own copy of the questions, with what it earned. Pure. */
function reviewOf(row: AttemptRow) {
  return row.quiz.questions.map((q) => {
    const given = row.answers[q.id] ?? null;
    const key = q.kind === 'single' ? q.correctChoiceId : q.kind === 'multi' ? q.correctChoiceIds : q.kind === 'numeric' ? q.answer : null;
    const earned = scoreQuestion(q, given ?? undefined) ?? row.essay_points?.[q.id] ?? 0;
    return { questionId: q.id, kind: q.kind, given, key, earned, points: q.points };
  });
}

/** One row of a quiz's own history: a save, publish, take-down, essay score or key fix, with who and why. */
export async function recordQuizEvent(
  sql: Db,
  itemId: string,
  revision: number,
  kind: string,
  reason: string | null,
  actorId: string,
  at: Date,
): Promise<void> {
  await sql`
    INSERT INTO academy.course_quiz_events (item_id, revision, kind, reason, actor_id, at)
    VALUES (${itemId}, ${revision}, ${kind}, ${reason}, ${actorId}, ${at})
  `;
}

/** The one-way hash an anonymous survey response is kept under: nothing in it names an account. */
export const surveyTokenHash = (itemId: string, clientToken: string) =>
  createHash('sha256').update(`${itemId}:${clientToken}`).digest('hex');

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

export class CourseQuizzes {
  constructor(private readonly sql: Sql) {}

  /** A quiz item as staff see it. A quiz item with nothing saved yet is revision 0, a draft with no questions. */
  async adminView(itemId: string): Promise<AcademyAdminCourseQuiz> {
    return this.adminIn(this.sql, await this.row(this.sql, itemId));
  }

  /** The draft over the revision read. Questions and kind change only while nobody has taken it; rules always may. */
  async save(input: AcademySaveCourseQuizInput & { operatorId: string; now: Date }): Promise<AcademyAdminCourseQuiz> {
    const ipAllow = checkIpRules(input.ipAllow);
    const survey = input.kind === 'survey';
    if (survey && (typeof input.accessCode === 'string' || ipAllow !== null))
      throw new AcademyError('academy.assessment_invalid a survey takes no access code or IP filter', 'academy.assessment_invalid');
    // A survey has no score, so nothing to pass and nothing to pick between attempts.
    const passMark = survey ? null : input.passMark;
    const scoringPolicy = survey ? null : input.scoringPolicy;
    if (passMark !== null && passMark > input.questions.reduce((sum, q) => sum + q.points, 0))
      throw new AcademyError("academy.assessment_invalid the pass mark is more than the questions' points", 'academy.assessment_invalid');
    const newCode = typeof input.accessCode === 'string' ? await hashAccessCode(input.accessCode) : null;
    return this.sql.begin(async (tx) => {
      const row = await this.row(tx, input.itemId, true);
      const revision = row.revision ?? 0;
      if (revision !== input.revision)
        throw new AcademyError(`the quiz is at revision ${revision}, not ${input.revision}`, 'academy.revision_stale');
      const was = { kind: row.quiz_kind ?? 'quiz', anonymous: row.anonymous ?? false, questions: questionsOf(row) };
      const next = { kind: input.kind, anonymous: input.anonymous, questions: input.questions };
      if ((await this.taken(tx, row.item_id)) > 0 && canonical(was) !== canonical(next))
        throw new AcademyError('learners have taken this quiz, so its questions stay as they are', 'academy.item_has_attempts');
      const state = row.state ?? 'draft';
      // A published quiz stays publishable: a save that would block it refuses with the first blocker.
      const blockers = publishBlockers({ ...input, passMark, scoringPolicy });
      if (state === 'published' && blockers.length > 0) throw new AcademyError(blockers[0]!, blockers[0]!);
      const code = survey ? null : input.accessCode === undefined ? row.access_code_hash : input.accessCode === null ? null : newCode;
      await tx`
        INSERT INTO academy.course_quizzes
          (item_id, revision, state, kind, anonymous, results_visibility, questions, pass_mark, attempt_limit, scoring_policy,
           time_limit_seconds, review_mode, access_code_hash, ip_allow, saved_by, saved_at)
        VALUES (${row.item_id}, ${revision + 1}, 'draft', ${input.kind}, ${input.anonymous}, ${input.resultsVisibility},
                ${tx.json(input.questions as never)}, ${passMark}, ${input.attemptLimit}, ${scoringPolicy}, ${input.timeLimitSeconds},
                ${input.reviewMode}, ${code}, ${ipAllow}, ${input.operatorId}, ${input.now})
        ON CONFLICT (item_id) DO UPDATE SET
          revision = EXCLUDED.revision, kind = EXCLUDED.kind, anonymous = EXCLUDED.anonymous,
          results_visibility = EXCLUDED.results_visibility, questions = EXCLUDED.questions, pass_mark = EXCLUDED.pass_mark,
          attempt_limit = EXCLUDED.attempt_limit, scoring_policy = EXCLUDED.scoring_policy,
          time_limit_seconds = EXCLUDED.time_limit_seconds, review_mode = EXCLUDED.review_mode,
          access_code_hash = EXCLUDED.access_code_hash, ip_allow = EXCLUDED.ip_allow, saved_by = EXCLUDED.saved_by,
          saved_at = EXCLUDED.saved_at
      `;
      await this.event(tx, row.item_id, revision + 1, 'saved', null, input.operatorId, input.now);
      return this.adminIn(tx, await this.row(tx, row.item_id));
    });
  }

  /** Publish when nothing blocks it, or take back to draft while nobody has taken it. A repeat answers as stored. */
  async setState(input: AcademySetCourseQuizStateInput & { operatorId: string; now: Date }): Promise<AcademyAdminCourseQuiz> {
    return this.sql.begin(async (tx) => {
      const row = await this.row(tx, input.itemId, true);
      if (row.revision === null) throw new AcademyError('the quiz has nothing saved to publish', 'academy.quiz_no_questions');
      if (row.state === input.state) return this.adminIn(tx, row);
      if (input.state === 'published') {
        const blockers = publishBlockers({
          kind: row.quiz_kind ?? 'quiz',
          questions: questionsOf(row),
          passMark: row.pass_mark,
          attemptLimit: row.attempt_limit,
          scoringPolicy: row.scoring_policy,
        });
        if (blockers.length > 0) throw new AcademyError(`${blockers[0]} blockers=${blockers.join(',')}`, blockers[0]!);
      } else if ((await this.taken(tx, row.item_id)) > 0) {
        throw new AcademyError('learners have taken this quiz, so it stays published', 'academy.item_has_attempts');
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

  /** The published quiz or survey as the enrolled learner reads it: no key, no code, no filter. Writes nothing. */
  async learnerView(input: { itemId: string; userId: string }): Promise<AcademyLearnerCourseQuiz> {
    const row = await this.learnerRow(this.sql, input.itemId, input.userId);
    const [used] = await this.sql<Array<{ n: number; responded: boolean }>>`
      SELECT
        (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = ${row.item_id} AND user_id = ${input.userId})::int AS n,
        EXISTS (SELECT 1 FROM academy.course_survey_takers WHERE item_id = ${row.item_id} AND user_id = ${input.userId}) AS responded
    `;
    const kind = row.quiz_kind ?? 'quiz';
    return {
      itemId: row.item_id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      title: row.title,
      kind,
      anonymous: row.anonymous ?? false,
      passMark: kind === 'survey' ? null : row.pass_mark,
      attemptLimit: row.attempt_limit,
      timeLimitSeconds: row.time_limit_seconds,
      reviewMode: row.review_mode ?? 'score_only',
      resultsVisibility: row.results_visibility ?? 'always',
      accessCodeRequired: row.access_code_hash !== null,
      attemptsUsed: used!.n,
      responded: used!.responded,
      questions: questionsOf(row).map((q) => ({
        id: q.id,
        prompt: q.prompt,
        kind: q.kind,
        points: q.points,
        choices: 'choices' in q ? q.choices.map((c) => ({ id: c.id, text: c.text })) : null,
      })),
    };
  }

  /**
   * Start (or get back) the learner's attempt. Enrolment first, then the access code, then the IP filter, so a refusal
   * never tells someone outside the course what the quiz asks for. `clientAddress` is null when it cannot be read. An open
   * attempt past its deadline is finished with what was saved by then; at the attempt limit Start refuses.
   */
  async start(input: {
    itemId: string;
    userId: string;
    accessCode: string | null;
    clientAddress: string | null;
    now: Date;
  }): Promise<AcademyCourseQuizAttempt> {
    // Checked outside the hold: hashing a typed code takes time and reads only the stored hash.
    const checked = await this.learnerRow(this.sql, input.itemId, input.userId, false, input.now);
    if ((checked.quiz_kind ?? 'quiz') === 'survey')
      throw new AcademyError('a survey is answered with submitCourseSurvey, not started', 'academy.quiz_not_found');
    if (checked.access_code_hash !== null && !(input.accessCode && (await accessCodeMatches(input.accessCode, checked.access_code_hash))))
      throw new AcademyError('academy.access_code_invalid', 'academy.access_code_invalid');
    // Read again holding the item, as a take-down or a question change does, so neither slips in before the attempt lands.
    return this.sql.begin(async (tx) => {
      const row = await this.learnerRow(tx, input.itemId, input.userId, true, input.now);
      if (row.access_code_hash !== checked.access_code_hash || (row.quiz_kind ?? 'quiz') !== 'quiz')
        throw new AcademyError('academy.access_code_invalid the quiz changed; start again', 'academy.access_code_invalid');
      if (row.ip_allow !== null) {
        const address = input.clientAddress === null ? null : unmapped(input.clientAddress);
        if (address === null || isIP(address) === 0)
          throw new AcademyError('academy.ip_unreadable the caller address could not be read', 'academy.ip_unreadable');
        if (!addressAllowed(address, row.ip_allow)) throw new AcademyError('academy.ip_not_allowed', 'academy.ip_not_allowed');
      }
      await this.hold(tx, input.userId, row.item_id);
      const open = await this.settleOpen(tx, input.userId, row.item_id, input.now);
      if (open) return this.attemptIn(tx, open, input.now);
      const [counted] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM academy.course_quiz_attempts WHERE item_id = ${row.item_id} AND user_id = ${input.userId}
      `;
      if (row.attempt_limit !== null && counted!.n >= row.attempt_limit)
        throw new AcademyError(`academy.attempt_limit limit=${row.attempt_limit}`, 'academy.attempt_limit');
      const deadline = row.time_limit_seconds === null ? null : new Date(input.now.getTime() + row.time_limit_seconds * 1000);
      const [created] = await tx<AttemptRow[]>`
        INSERT INTO academy.course_quiz_attempts (item_id, user_id, number, started_at, deadline_at, quiz, state)
        VALUES (${row.item_id}, ${input.userId}, ${counted!.n + 1}, ${input.now}, ${deadline},
                ${tx.json({ questions: questionsOf(row), passMark: row.pass_mark } as never)}, 'open')
        RETURNING ${ATTEMPT(tx)}
      `;
      return this.attemptIn(tx, created!, input.now);
    });
  }

  /** The caller's newest attempt on this quiz, or null. One past its deadline is finished here with what was saved. */
  async current(input: { itemId: string; userId: string; now: Date }): Promise<AcademyCourseQuizAttempt | null> {
    const row = await this.learnerRow(this.sql, input.itemId, input.userId, false, input.now);
    return this.sql.begin(async (tx) => {
      await this.hold(tx, input.userId, row.item_id);
      await this.settleOpen(tx, input.userId, row.item_id, input.now);
      const [latest] = await tx<AttemptRow[]>`
        SELECT ${ATTEMPT(tx)} FROM academy.course_quiz_attempts
        WHERE item_id = ${row.item_id} AND user_id = ${input.userId} ORDER BY number DESC LIMIT 1
      `;
      return latest ? this.attemptIn(tx, latest, input.now) : null;
    });
  }

  /** Save one answer on the caller's open attempt. A finished attempt, or one past its deadline, refuses `academy.attempt_closed`. */
  async answer(input: {
    attemptId: string;
    userId: string;
    questionId: string;
    answer: AcademyCourseQuizAnswer;
    now: Date;
  }): Promise<AcademyCourseQuizAttempt> {
    return this.sql.begin(async (tx) => {
      const open = await this.ownOpen(tx, input.attemptId, input.userId, input.now);
      const question = open.quiz.questions.find((q) => q.id === input.questionId);
      if (!question || !answerFits(question, input.answer))
        throw new AcademyError('academy.assessment_invalid the answer does not fit that question', 'academy.assessment_invalid');
      const [saved] = await tx<AttemptRow[]>`
        UPDATE academy.course_quiz_attempts SET answers = answers || ${tx.json({ [input.questionId]: input.answer } as never)}
        WHERE id = ${open.id}
        RETURNING ${ATTEMPT(tx)}
      `;
      return this.attemptIn(tx, saved!, input.now);
    });
  }

  /** Finish and score the saved answers once. Finishing again answers with the same result; nothing is scored twice. */
  async finish(input: { attemptId: string; userId: string; now: Date }): Promise<AcademyCourseQuizAttempt> {
    return this.sql.begin(async (tx) => {
      const row = await this.ownAttempt(tx, input.attemptId, input.userId);
      await this.hold(tx, input.userId, row.item_id);
      const [current] = await tx<AttemptRow[]>`SELECT ${ATTEMPT(tx)} FROM academy.course_quiz_attempts WHERE id = ${row.id}`;
      const finished = current!.state === 'open' ? await this.finishRow(tx, current!, input.now) : current!;
      return this.attemptIn(tx, finished, input.now);
    });
  }

  /** Finished attempts waiting for an essay score, oldest first, each under the learner's alias on this quiz. */
  async reviews(itemId: string): Promise<AcademyCourseQuizReview[]> {
    const row = await this.row(this.sql, itemId);
    const rows = await this.sql<Array<AttemptRow & { alias: number }>>`
      SELECT ${ATTEMPT(this.sql)}, a.alias FROM academy.course_quiz_attempts t
      JOIN (SELECT user_id, row_number() OVER (ORDER BY min(started_at), user_id)::int AS alias
            FROM academy.course_quiz_attempts WHERE item_id = ${row.item_id} GROUP BY user_id) a USING (user_id)
      WHERE t.item_id = ${row.item_id} AND t.state = 'pending_review'
      ORDER BY t.finished_at, t.id
    `;
    return rows.map((r) => ({
      attemptId: r.id,
      alias: r.alias,
      number: r.number,
      finishedAt: r.finished_at!.toISOString(),
      autoScore: r.auto_score ?? 0,
      essays: r.quiz.questions
        .filter((q) => q.kind === 'essay')
        .map((q) => {
          const text = r.answers[q.id];
          return { questionId: q.id, prompt: q.prompt, points: q.points, text: typeof text === 'string' ? text : null };
        }),
    }));
  }

  /** Score an attempt's essays, each from 0 to its points, and grade it. A graded attempt is not scored again. */
  async scoreEssays(input: {
    itemId: string;
    attemptId: string;
    points: Record<string, number>;
    operatorId: string;
    now: Date;
  }): Promise<AcademyCourseQuizReview[]> {
    const itemId = await this.sql.begin(async (tx) => {
      const [row] = await tx<AttemptRow[]>`
        SELECT ${ATTEMPT(tx)} FROM academy.course_quiz_attempts WHERE id = ${input.attemptId} FOR UPDATE
      `;
      // An attempt on another quiz is not found here, so a score never lands on a quiz the editor is not showing.
      if (!row || row.item_id !== input.itemId) throw new AcademyError('academy.attempt_not_found', 'academy.attempt_not_found');
      if (row.state !== 'pending_review')
        throw new AcademyError(`academy.attempt_closed the attempt is ${row.state}, not waiting for a score`, 'academy.attempt_closed');
      const essays = row.quiz.questions.filter((q) => q.kind === 'essay');
      const given = Object.keys(input.points);
      if (given.length !== essays.length || essays.some((q) => !Object.hasOwn(input.points, q.id) || input.points[q.id]! > q.points))
        throw new AcademyError('academy.assessment_invalid score every essay, each from 0 to its points', 'academy.assessment_invalid');
      const score = (row.auto_score ?? 0) + essays.reduce((sum, q) => sum + input.points[q.id]!, 0);
      await tx`
        UPDATE academy.course_quiz_attempts
        SET state = 'graded', essay_points = ${tx.json(input.points)}, score = ${score}, passed = ${score >= row.quiz.passMark},
            scored_by = ${input.operatorId}, scored_at = ${input.now}
        WHERE id = ${row.id}
      `;
      const [quiz] = await tx<Array<{ revision: number }>>`SELECT revision FROM academy.course_quizzes WHERE item_id = ${row.item_id}`;
      await this.event(tx, row.item_id, quiz?.revision ?? 1, 'essay_scored', null, input.operatorId, input.now);
      return row.item_id;
    });
    return this.reviews(itemId);
  }

  /**
   * One survey response per learner; a second refuses `academy.survey_duplicate`. That the learner answered is a row of its
   * own with no answers and no time. An anonymous survey keeps the answers with the one-way hash of the device's token, no
   * account and the hour only; a named one keeps the account with them.
   */
  async submitSurvey(input: {
    itemId: string;
    userId: string;
    clientToken: string;
    answers: Record<string, AcademyCourseQuizAnswer>;
    now: Date;
  }): Promise<{ itemId: string; anonymous: boolean; submittedAt: string }> {
    const row = await this.learnerRow(this.sql, input.itemId, input.userId, false, input.now);
    if ((row.quiz_kind ?? 'quiz') !== 'survey')
      throw new AcademyError('a graded quiz is started, not sent as a survey', 'academy.quiz_not_found');
    const questions = questionsOf(row);
    const entries = Object.entries(input.answers);
    if (entries.length === 0)
      throw new AcademyError('academy.assessment_invalid answer at least one question', 'academy.assessment_invalid');
    for (const [questionId, answer] of entries) {
      const question = questions.find((q) => q.id === questionId);
      if (!question || !answerFits(question, answer))
        throw new AcademyError(`academy.assessment_invalid the answer to ${questionId} does not fit it`, 'academy.assessment_invalid');
    }
    const anonymous = row.anonymous ?? false;
    // An anonymous response keeps its time to the hour only, so it cannot be matched to a request by the second.
    const at = anonymous ? new Date(Math.floor(input.now.getTime() / 3_600_000) * 3_600_000) : input.now;
    const duplicate = () => new AcademyError('this survey already has your answers', 'academy.survey_duplicate');
    const [taken] = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM academy.course_survey_takers WHERE item_id = ${row.item_id} AND user_id = ${input.userId}
    `;
    if (taken!.n > 0) throw duplicate();
    // The answers and the record that this learner answered are separate statements, never one transaction, so the
    // two rows share no transaction id to join them by. A crash between them leaves at most one extra response, not a lost one.
    let responseId: string;
    try {
      const [response] = await this.sql<Array<{ id: string }>>`
        INSERT INTO academy.course_survey_responses (item_id, user_id, token_hash, answers, submitted_at)
        VALUES (${row.item_id}, ${anonymous ? null : input.userId}, ${surveyTokenHash(row.item_id, input.clientToken)},
                ${this.sql.json(input.answers as never)}, ${at})
        RETURNING id
      `;
      responseId = response!.id;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw duplicate();
      throw error;
    }
    try {
      await this.sql`INSERT INTO academy.course_survey_takers (item_id, user_id) VALUES (${row.item_id}, ${input.userId})`;
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      // Two answers raced: the learner had already answered, so this one is taken back.
      await this.sql`DELETE FROM academy.course_survey_responses WHERE id = ${responseId}`;
      throw duplicate();
    }
    return { itemId: row.item_id, anonymous, submittedAt: input.now.toISOString() };
  }

  /** One learner's attempts on one quiz are taken in turn. */
  private async hold(tx: Db, userId: string, itemId: string) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:course-quiz:${itemId}`}, 0))`;
  }

  /** The caller's own attempt; another learner's id is not found, the same as one that does not exist. */
  private async ownAttempt(tx: Db, attemptId: string, userId: string): Promise<AttemptRow> {
    const [row] = await tx<AttemptRow[]>`
      SELECT ${ATTEMPT(tx)} FROM academy.course_quiz_attempts WHERE id = ${attemptId} AND user_id = ${userId}
    `;
    if (!row) throw new AcademyError('academy.attempt_not_found', 'academy.attempt_not_found');
    return row;
  }

  private async ownOpen(tx: Db, attemptId: string, userId: string, now: Date): Promise<AttemptRow> {
    const row = await this.ownAttempt(tx, attemptId, userId);
    await this.hold(tx, userId, row.item_id);
    const open = await this.settleOpen(tx, userId, row.item_id, now);
    if (!open || open.id !== attemptId) throw new AcademyError('academy.attempt_closed this attempt is finished', 'academy.attempt_closed');
    return open;
  }

  /** The open attempt, unless its deadline has passed: then it is finished with the answers saved by the deadline. */
  private async settleOpen(tx: Db, userId: string, itemId: string, now: Date): Promise<AttemptRow | null> {
    const [open] = await tx<AttemptRow[]>`
      SELECT ${ATTEMPT(tx)} FROM academy.course_quiz_attempts WHERE item_id = ${itemId} AND user_id = ${userId} AND state = 'open'
    `;
    if (!open) return null;
    if (open.deadline_at && now.getTime() >= open.deadline_at.getTime()) {
      await this.finishRow(tx, open, open.deadline_at);
      return null;
    }
    return open;
  }

  /** Score the saved answers against the attempt's own copy; an essay leaves it pending review. */
  private async finishRow(tx: Db, row: AttemptRow, at: Date): Promise<AttemptRow> {
    const scored = scoreAttempt(row.quiz.questions, row.answers);
    const finishedAt = row.deadline_at && at.getTime() > row.deadline_at.getTime() ? row.deadline_at : at;
    const graded = !scored.essays;
    const [finished] = await tx<AttemptRow[]>`
      UPDATE academy.course_quiz_attempts
      SET finished_at = ${finishedAt}, state = ${graded ? 'graded' : 'pending_review'}, auto_score = ${scored.autoScore},
          max_score = ${scored.maxScore}, score = ${graded ? scored.autoScore : null},
          passed = ${graded ? scored.autoScore >= row.quiz.passMark : null}
      WHERE id = ${row.id}
      RETURNING ${ATTEMPT(tx)}
    `;
    return finished!;
  }

  /** An attempt as its learner sees it: the score only as the quiz's results visibility allows. */
  private async attemptIn(tx: Db, row: AttemptRow, now: Date): Promise<AcademyCourseQuizAttempt> {
    const secondsLeft =
      row.state === 'open' && row.deadline_at ? Math.max(0, Math.ceil((row.deadline_at.getTime() - now.getTime()) / 1000)) : null;
    const base = {
      attemptId: row.id,
      itemId: row.item_id,
      number: row.number,
      startedAt: row.started_at.toISOString(),
      deadlineAt: row.deadline_at?.toISOString() ?? null,
      secondsLeft,
      answers: row.answers,
    };
    if (row.state === 'open') return { ...base, result: null };
    const finishedAt = row.finished_at!.toISOString();
    if (row.state === 'pending_review') return { ...base, result: { state: 'pending_review', finishedAt } };
    const shown = await this.resultsShow(tx, row);
    if (!shown.show) return { ...base, result: { state: 'withheld', finishedAt } };
    // A score changed after grading (AC-quizzes-04) shows as its newest score event left it.
    const [changed] = await tx<
      Array<{ score: number; passed: boolean; points: Record<string, number>; keys: Record<string, Record<string, unknown>> }>
    >`
      SELECT score, passed, points, keys FROM academy.course_quiz_score_events WHERE attempt_id = ${row.id} ORDER BY n DESC LIMIT 1
    `;
    const review = shown.reviewMode === 'answers' ? reviewOf(row) : null;
    // After a key fix and rescore, the review shows the key the points stand on, not the one the attempt was taken under.
    const keyNow = (questionId: string, key: unknown) => {
      const applied = changed?.keys[questionId];
      return applied ? (applied.correctChoiceId ?? applied.correctChoiceIds ?? applied.answer ?? key) : key;
    };
    return {
      ...base,
      result: {
        state: 'graded',
        score: changed?.score ?? row.score!,
        maxScore: row.max_score!,
        pass: changed?.passed ?? row.passed!,
        finishedAt,
        review:
          review && changed
            ? review.map((r) => ({
                ...r,
                key: keyNow(r.questionId, r.key) as typeof r.key,
                earned: changed.points[r.questionId] ?? r.earned,
              }))
            : review,
      },
    };
  }

  /** Whether the quiz's results visibility, as it is now, lets this learner see a graded score, and its review mode. */
  private async resultsShow(tx: Db, row: AttemptRow): Promise<{ show: boolean; reviewMode: AcademyQuizReviewMode }> {
    const [quiz] = await tx<
      Array<{ visibility: AcademyResultsVisibility; limit: number | null; finished: number; review_mode: AcademyQuizReviewMode }>
    >`
      SELECT q.results_visibility AS visibility, q.attempt_limit AS limit, q.review_mode,
        (SELECT count(*)::int FROM academy.course_quiz_attempts t
          WHERE t.item_id = q.item_id AND t.user_id = ${row.user_id} AND t.state <> 'open') AS finished
      FROM academy.course_quizzes q WHERE q.item_id = ${row.item_id}
    `;
    if (!quiz || quiz.visibility === 'never') return { show: false, reviewMode: 'score_only' };
    const show = quiz.visibility === 'always' || (quiz.limit !== null && quiz.finished >= quiz.limit);
    return { show, reviewMode: quiz.review_mode };
  }

  private async learnerRow(sql: Db, itemId: string, userId: string, lock = false, now = new Date()): Promise<LearnerRow> {
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
    // A section scheduled for later, or an unmet prerequisite, keeps the quiz closed (AC-release-access-01, 02).
    await assertItemOpen(sql, row.item_id, userId, now);
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

  /** Attempts and survey responses on the quiz: once there is one, its questions stay as they are. */
  private async taken(sql: Db, itemId: string): Promise<number> {
    const [counted] = await sql<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = ${itemId})::int
           + (SELECT count(*) FROM academy.course_survey_responses WHERE item_id = ${itemId})::int AS n
    `;
    return counted!.n;
  }

  private async event(sql: Db, itemId: string, revision: number, kind: string, reason: string | null, actorId: string, at: Date) {
    await recordQuizEvent(sql, itemId, revision, kind, reason, actorId, at);
  }

  private async adminIn(sql: Db, row: QuizRow): Promise<AcademyAdminCourseQuiz> {
    const questions = questionsOf(row);
    const kind = row.quiz_kind ?? 'quiz';
    const quiz = {
      kind,
      anonymous: row.anonymous ?? false,
      resultsVisibility: row.results_visibility ?? 'always',
      passMark: row.pass_mark,
      attemptLimit: row.attempt_limit,
      scoringPolicy: row.scoring_policy,
      timeLimitSeconds: row.time_limit_seconds,
      reviewMode: row.review_mode ?? 'score_only',
      ipAllow: row.ip_allow,
    };
    const [counts] = await sql<Array<{ attempts: number; pending: number; responses: number }>>`
      SELECT
        (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = ${row.item_id})::int AS attempts,
        (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = ${row.item_id} AND state = 'pending_review')::int AS pending,
        (SELECT count(*) FROM academy.course_survey_responses WHERE item_id = ${row.item_id})::int AS responses
    `;
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
      attempts: counts!.attempts,
      pendingReview: counts!.pending,
      responses: counts!.responses,
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
