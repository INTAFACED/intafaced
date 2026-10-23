import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import {
  academyCodeOf,
  academyRefusalKey,
  academyRefusalText,
  enrolReceipt,
  enrolmentsFor,
  leaveReceipt,
  missingProgrammes,
  readQuiz,
  readAttempts,
  readEnrolments,
  settleByReading,
  verifyCertificate,
} from './academy-flows';
import { academyLmsCopy } from './academy-lms-copy';

const owner = '11111111-1111-4111-8111-111111111111';
const code = '0123456789abcdef0123456789abcdef';
const slug = 'foundations-01';

const quiz = {
  slug,
  kind: 'quiz',
  passMark: 3,
  timeLimitSeconds: 600,
  attemptLimit: 2,
  reviewMode: 'answers',
  questions: [
    {
      id: 'q1',
      prompt: 'What is a spot trade?',
      kind: 'single',
      points: 2,
      choices: [
        { id: 'a', text: 'Immediate delivery' },
        { id: 'b', text: 'A future date' },
      ],
    },
    {
      id: 'q2',
      prompt: 'What does a limit order set?',
      kind: 'single',
      points: 1,
      choices: [
        { id: 'a', text: 'A worst price' },
        { id: 'b', text: 'A volume' },
      ],
    },
  ],
};
const attempt = (score: number, at: string, over = {}) => ({ slug, score, maxScore: 3, pass: score >= 3, submittedAt: at, hiddenUntil: null, ...over });

type Call = { method: string; url: URL; body: unknown; authorization: string | null };
type Reply = Response | Error | ((call: Call) => Response | Error);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown) => json(200, { result: { data } });
/** A tRPC refusal as svc-academy's error formatter sends it: the Academy code rides in `data.cause.code`. */
const refusal = (status: number, trpcCode: string, academyCode: string, message = academyCode) =>
  json(status, { error: { message, code: -32000, data: { code: trpcCode, httpStatus: status, cause: { code: academyCode } } } });

function harness(replies: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const queue = new Map(Object.entries(replies).map(([key, list]) => [key, [...list]]));
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    const procedure = url.pathname.split('/trpc/')[1] ?? '';
    const list = queue.get(procedure);
    const next = list && list.length > 1 ? list.shift() : list?.[0];
    if (!next) throw new Error(`no reply staged for ${procedure}`);
    const reply = typeof next === 'function' ? next(call) : next;
    if (reply instanceof Error) throw reply;
    return reply.clone();
  }) as typeof fetch;
  const api = createApiClient({ fetch: fetcher, token: () => 'tok' });
  const of = (procedure: string) => calls.filter((call) => call.url.pathname.endsWith(`/trpc/${procedure}`));
  return { api, calls, of };
}
const lostReply = () => new TypeError('network dropped');

describe('assessment reads', () => {
  it('asks assessment.get by lesson slug and keeps the published questions', async () => {
    const { api, of } = harness({ 'assessment.get': [ok(quiz)] });
    const result = await readQuiz(api, slug);
    expect(result.ok && result.data.questions).toHaveLength(2);
    const [call] = of('assessment.get');
    expect(call!.method).toBe('GET');
    expect(call!.url.pathname).toBe('/api/academy/trpc/assessment.get');
    expect(JSON.parse(call!.url.searchParams.get('input')!)).toEqual({ slug });
    expect(result.ok && result.data.timeLimitSeconds).toBe(600);
  });

  it('does not accept repeated question ids', async () => {
    const { api } = harness({ 'assessment.get': [ok({ ...quiz, questions: [quiz.questions[0], quiz.questions[0]] })] });
    expect((await readQuiz(api, slug)).ok).toBe(false);
  });

  it('turns a reply that does not match into a failed read, not a half-drawn quiz', async () => {
    const { api } = harness({ 'assessment.get': [ok({ ...quiz, slug: 'someone-elses' })] });
    const result = await readQuiz(api, slug);
    expect(result.ok).toBe(false);
  });

  it('reads attempts newest first as Academy sends them and rejects another lesson’s rows', async () => {
    const rows = [attempt(3, '2026-10-12T10:00:00.000Z'), attempt(1, '2026-10-11T10:00:00.000Z')];
    const { api } = harness({
      'assessment.attempts': [ok(rows), ok([...rows, attempt(2, '2026-10-10T10:00:00.000Z', { slug: 'other' })])],
    });
    const first = await readAttempts(api, slug);
    expect(first.ok && first.data.map((row) => row.score)).toEqual([3, 1]);
    expect((await readAttempts(api, slug)).ok).toBe(false);
  });

  it('names its typed refusal when the lesson has no published assessment', async () => {
    const { api } = harness({
      'assessment.get': [
        refusal(412, 'PRECONDITION_FAILED', 'academy.assessment_unpublished', `academy.assessment_unpublished slug=${slug}`),
      ],
    });
    const result = await readQuiz(api, slug);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('academy.assessment_unpublished');
    expect(academyRefusalText(result, academyLmsCopy.t)).toBe('Academy has no scored assessment published for this lesson.');
  });
});

describe('public certificate check', () => {
  const found = { certId: 'foundations-v1', title: 'Foundations', grantedAt: '2026-10-10T08:00:00.000Z', status: 'valid' as const };

  it('calls certVerify with the code alone, shows the fields Academy returns and keeps a holder name only when sent', async () => {
    const { api, of } = harness({ certVerify: [ok(found), ok({ ...found, status: 'revoked', holderName: 'A. Learner' })] });
    const valid = await verifyCertificate(api, code);
    expect(valid.ok && valid.data).toEqual(found);
    const call = of('certVerify')[0]!;
    expect(call.method).toBe('GET');
    expect(JSON.parse(call.url.searchParams.get('input')!)).toEqual({ publicId: code });
    const revoked = await verifyCertificate(api, code);
    expect(revoked.ok && revoked.data).toMatchObject({ status: 'revoked', holderName: 'A. Learner' });
  });

  it('refuses a status or a date it does not know', async () => {
    const { api } = harness({ certVerify: [ok({ ...found, status: 'pending' }), ok({ ...found, grantedAt: 'yesterday' })] });
    expect((await verifyCertificate(api, code)).ok).toBe(false);
    expect((await verifyCertificate(api, code)).ok).toBe(false);
  });

  it('will not send anything that is not a 32-character lowercase code', () => {
    const { api } = harness({ certVerify: [ok(found)] });
    expect(() => verifyCertificate(api, 'CERT:abc')).toThrow();
    expect(() => verifyCertificate(api, code.toUpperCase())).toThrow();
  });

  it.each([
    ['academy.cert_not_found', 404, 'NOT_FOUND', 'No certificate has this verification code. Check the code and try again.'],
    [
      'academy.certificate_unpublished',
      412,
      'PRECONDITION_FAILED',
      'This certificate is on record, but its definition is no longer published, so Academy cannot describe it.',
    ],
    [
      'academy.verify_rate_limited',
      429,
      'TOO_MANY_REQUESTS',
      'Too many certificate checks came from your connection. Wait a moment, then check again.',
    ],
    [
      'academy.verify_rate_unset',
      412,
      'PRECONDITION_FAILED',
      'Academy has no limit set for certificate checks, so it refuses every check.',
    ],
    ['academy.verify_address_unset', 412, 'PRECONDITION_FAILED', 'Academy could not tell where this check came from, so it refuses it.'],
  ])('words %s, whatever the status the gateway gave it', async (academyCode, status, trpcCode, words) => {
    const { api } = harness({ certVerify: [refusal(status, trpcCode, academyCode)] });
    const result = await verifyCertificate(api, code);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(academyCode);
    expect(academyRefusalText(result, academyLmsCopy.t)).toBe(words);
  });
});

describe('enrolments', () => {
  const row = (pathSlug: string, over = {}) => ({ userId: owner, pathSlug, enrolledAt: '2026-10-01T08:00:00.000Z', ...over });

  it('reads myEnrollments and rejects another account’s rows or the same programme twice', async () => {
    const { api, of } = harness({
      myEnrollments: [
        ok([row('foundations'), row('markets')]),
        ok([row('foundations', { userId: '22222222-2222-4222-8222-222222222222' })]),
        ok([row('markets'), row('markets')]),
      ],
    });
    const mine = await readEnrolments(api, owner);
    expect(mine.ok && mine.data.map((r) => r.pathSlug)).toEqual(['foundations', 'markets']);
    expect(of('myEnrollments')[0]!.url.search).toBe('');
    expect((await readEnrolments(api, owner)).ok).toBe(false);
    expect((await readEnrolments(api, owner)).ok).toBe(false);
    expect(enrolmentsFor(undefined).safeParse([]).success).toBe(true);
  });

  it('checks that a receipt is for this account and programme', () => {
    expect(enrolReceipt(owner, 'markets').safeParse(row('markets')).success).toBe(true);
    expect(enrolReceipt(owner, 'markets').safeParse(row('builder')).success).toBe(false);
    const left = { ...row('markets'), leftAt: '2026-10-05T08:00:00.000Z' };
    expect(leaveReceipt(owner, 'markets').safeParse(left).success).toBe(true);
    expect(leaveReceipt(owner, 'markets').safeParse(row('markets')).success).toBe(false);
    expect(leaveReceipt('22222222-2222-4222-8222-222222222222', 'markets').safeParse(left).success).toBe(false);
  });

  const lost = { ok: false as const, reason: 'uncertain' as const, message: 'unknown' };
  const notRecorded = () => ({ ok: false as const, reason: 'aborted' as const, code: 'academy.not_recorded', message: 'not recorded' });

  it('passes a reply through untouched when it arrived, and never reads in that case', async () => {
    let reads = 0;
    const read = async () => {
      reads++;
      return { ok: true as const, data: [] };
    };
    const done = { ok: true as const, data: { any: 1 } };
    const refused = { ok: false as const, reason: 'error' as const, message: 'no', code: 'academy.enrollment_not_found' };
    expect(await settleByReading(done, read, () => true, notRecorded)).toBe(done);
    expect(await settleByReading(refused, read, () => true, notRecorded)).toBe(refused);
    expect(reads).toBe(0);
  });

  it('counts a lost reply as done when the enrolments show the change, and as not recorded when they do not', async () => {
    const enrolled = async () => ({ ok: true as const, data: [row('markets')] });
    const none = async () => ({ ok: true as const, data: [] });
    expect((await settleByReading(lost, enrolled, (rows) => rows.some((r) => r.pathSlug === 'markets'), notRecorded)).ok).toBe(true);
    expect(await settleByReading(lost, none, (rows) => rows.some((r) => r.pathSlug === 'markets'), notRecorded)).toMatchObject({
      ok: false,
      code: 'academy.not_recorded',
    });
    expect((await settleByReading(lost, none, (rows) => !rows.some((r) => r.pathSlug === 'markets'), notRecorded)).ok).toBe(true);
  });

  it('keeps the lost-reply answer when the enrolments cannot be read either', async () => {
    const unreadable = async () => ({ ok: false as const, reason: 'unreachable' as const, message: 'down' });
    expect(await settleByReading(lost, unreadable, () => true, notRecorded)).toBe(lost);
  });

  it('settles a leave whose reply was lost from the real wire: one POST with the leave reference, one read', async () => {
    const { api, of } = harness({ leaveCertPath: [lostReply()], myEnrollments: [ok([row('foundations')])] });
    const sent = await api.mutate(
      'academy',
      'leaveCertPath',
      { pathSlug: 'markets', clientRequestId: 'leave-1' },
      leaveReceipt(owner, 'markets'),
    );
    const settled = await settleByReading(
      sent,
      () => readEnrolments(api, owner),
      (rows) => !rows.some((r) => r.pathSlug === 'markets'),
      notRecorded,
    );
    expect(settled.ok).toBe(true);
    expect(of('leaveCertPath')).toHaveLength(1);
    expect(of('leaveCertPath')[0]!.body).toEqual({ pathSlug: 'markets', clientRequestId: 'leave-1' });
    expect(of('myEnrollments')).toHaveLength(1);
  });
});

describe('refusal wording', () => {
  const failure = (code: string | undefined, message = 'x') => ({ code, message });

  it('names each typed refusal and nothing else', () => {
    expect(academyRefusalKey(failure('academy.enrollment_not_found'))).toBe('refEnrollmentNotFound');
    expect(academyRefusalKey(failure('academy.cert_invalid'))).toBe('refProgrammeInvalid');
    expect(academyRefusalKey(failure('academy.video_storage_unconfigured'))).toBe('refVideoStorageUnconfigured');
    expect(academyRefusalKey(failure('academy.video_url_ttl_unset'))).toBe('refVideoUrlTtlUnset');
    expect(academyRefusalKey(failure('academy.video_s3_region_unset'))).toBe('refVideoRegionUnset');
    expect(academyRefusalKey(failure('academy.video_grant_required'))).toBe('refVideoGrantRequired');
    expect(academyRefusalKey(failure('academy.video_not_found'))).toBe('refVideoNotFound');
    expect(academyRefusalKey(failure('academy.sign_in_required'))).toBe('refSignInRequired');
    expect(academyRefusalKey(failure('academy.curriculum_not_found'))).toBe('refCurriculumNotFound');
    expect(academyRefusalKey(failure('edge.upstream_unavailable'))).toBeNull();
    expect(academyRefusalKey(failure(undefined, 'The service could not be reached.'))).toBeNull();
    expect(academyRefusalText(failure('PRECONDITION_FAILED'), academyLmsCopy.t)).toBeNull();
  });

  it('finds an Academy code named inside the message when the gateway sent a broad one', () => {
    expect(academyCodeOf(failure('PRECONDITION_FAILED', 'academy.attempt_limit slug=x'))).toBe('academy.attempt_limit');
    expect(academyCodeOf(failure('academy.cert_not_found'))).toBe('academy.cert_not_found');
    expect(academyCodeOf(failure(undefined, 'plain words'))).toBeNull();
  });

  it('names the programmes a prerequisite refusal lists, in each language', () => {
    const f = failure('academy.prerequisite_unmet', 'academy.prerequisite_unmet missing=foundations,markets');
    expect(missingProgrammes(f.message)).toEqual(['foundations', 'markets']);
    expect(academyRefusalText(f, academyLmsCopy.t)).toBe('Enrolling needs these programmes first: Foundations, Markets.');
    expect(academyRefusalText(f, academyLmsCopy.forLocale('es').t)).toBe(
      'Para inscribirte primero necesitas estos programas: Fundamentos, Mercados.',
    );
    expect(academyRefusalText(f, academyLmsCopy.forLocale('fr').t)).toBe(
      'Pour vous inscrire, il faut d’abord ces programmes : Fondamentaux, Marchés.',
    );
    expect(academyRefusalText(failure('academy.prerequisite_unmet', 'academy.prerequisite_unmet'), academyLmsCopy.t)).toBe(
      'Academy says a programme you have not joined is required first.',
    );
  });

  it('words every typed refusal in Spanish and French as well as English', () => {
    const codes = [
      'assessment_unpublished',
      'pass_mark_unset',
      'assessment_invalid',
      'attempt_limit',
      'attempt_cooldown',
      'cert_not_found',
      'certificate_unpublished',
      'verify_rate_limited',
      'verify_rate_unset',
      'verify_address_unset',
      'enrollment_not_found',
      'cert_invalid',
      'path_not_found',
    ];
    for (const locale of ['en', 'es', 'fr'] as const) {
      const seen = new Set<string>();
      for (const code of codes) {
        const text = academyRefusalText(failure(`academy.${code}`), academyLmsCopy.forLocale(locale).t);
        expect(text, `${locale} ${code}`).toBeTruthy();
        expect(text).not.toMatch(/academy\.[a-z_]+/);
        seen.add(text!);
      }
      expect(seen.size).toBeGreaterThanOrEqual(codes.length - 1);
    }
  });
});
