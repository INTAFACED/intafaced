/**
 * Assessments, certificate paths, public verification, holder consent.
 * Figures in the injected catalogs are TEST fixtures. The owner catalog is not.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type Context } from '@intafaced/contracts';
import { TRPCError } from '@trpc/server';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { createAcademyRouter } from '../router.js';
import { FOUNDATIONS_V1 } from '../certs/catalog.js';
import type { AssessmentDefinition } from './catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const SECRET = 'academy-certs-backend-edge-secret-32b';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

const TEST_QUIZ: AssessmentDefinition = {
  slug: 'foundations-risk-first',
  kind: 'quiz',
  passMark: 1,
  attemptLimit: null,
  cooldownSeconds: null,
  questions: [
    {
      id: 'q1',
      prompt: 'TEST question',
      kind: 'single',
      points: 1,
      choices: [
        { id: 'a', text: 'TEST wrong' },
        { id: 'b', text: 'TEST right' },
      ],
      correctChoiceId: 'b',
    },
  ],
};

const BLANK_MARK: AssessmentDefinition = { ...TEST_QUIZ, slug: 'foundations-order-types', passMark: null };
const LIMITED: AssessmentDefinition = { ...TEST_QUIZ, slug: 'foundations-fees-are-real', attemptLimit: 1 };
const COOLING: AssessmentDefinition = { ...TEST_QUIZ, slug: 'foundations-journal-discipline', cooldownSeconds: 60 };

const TEST_ASSESSED = {
  id: 'test-assessed-v1',
  title: 'TEST assessed',
  path: 'markets' as const,
  requiredItemSlugs: ['assessment:foundations-risk-first'],
};

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

function service(options: ConstructorParameters<typeof AcademyService>[4] = {}) {
  return new AcademyService(
    sql,
    {
      async stakeOf() {
        return 0n;
      },
    },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false, ...options },
  );
}

function principal(userId = USER, scopes: string[] = ['academy:read', 'academy:write']): Principal {
  return {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req',
  });
}

function anonymous(address?: string): Context {
  const ctx = edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' });
  if (address) return Object.assign(ctx, { clientAddress: address });
  return ctx;
}

function refusal(err: unknown): string {
  const error = err as TRPCError;
  const cause = error.cause as { code?: string } | undefined;
  return JSON.stringify({ code: error.code, message: error.message, cause: cause?.code ?? null });
}

const wrong = [{ questionId: 'q1', choiceId: 'a' }];
const right = [{ questionId: 'q1', choiceId: 'b' }];

describe('academy assessments and certificates', () => {
  it('refuses an unpublished assessment and a blank pass mark, and hides the answer key', async () => {
    const bare = service();
    await expect(bare.getAssessment('foundations-risk-first')).rejects.toMatchObject({ code: 'academy.assessment_unpublished' });
    const blank = service({ assessmentCatalog: [BLANK_MARK] });
    await expect(blank.getAssessment('foundations-order-types')).rejects.toMatchObject({ code: 'academy.pass_mark_unset' });

    const academy = service({ assessmentCatalog: [TEST_QUIZ], certCatalog: [FOUNDATIONS_V1, TEST_ASSESSED] });
    const caller = createAcademyRouter(academy).createCaller(signed());
    const body = await caller.assessment.get({ slug: 'foundations-risk-first' });
    expect(JSON.stringify(body)).not.toMatch(/correct/i);
    expect(body.questions[0]).not.toHaveProperty('correctChoiceId');
    expect(body.passMark).toBe(1);
    expect(body.questions[0]?.points).toBe(1);
  });

  it('scores on the server, replays the first result, and hides another account', async () => {
    const academy = service({ assessmentCatalog: [TEST_QUIZ], certCatalog: [FOUNDATIONS_V1, TEST_ASSESSED] });
    const caller = createAcademyRouter(academy).createCaller(signed());
    const first = await caller.assessment.submit({ slug: 'foundations-risk-first', clientAttemptId: 'replay-1', answers: wrong });
    expect(first).toMatchObject({ score: 0, pass: false, maxScore: 1 });
    const replay = await caller.assessment.submit({ slug: 'foundations-risk-first', clientAttemptId: 'replay-1', answers: right });
    expect(replay.score).toBe(first.score);
    expect(replay.pass).toBe(false);
    expect(replay.submittedAt.toISOString()).toBe(first.submittedAt.toISOString());

    const passed = await caller.assessment.submit({ slug: 'foundations-risk-first', clientAttemptId: 'pass-1', answers: right });
    expect(passed).toMatchObject({ score: 1, pass: true });
    const mine = await caller.assessment.attempts({ slug: 'foundations-risk-first' });
    expect(mine).toHaveLength(2);
    const other = createAcademyRouter(academy).createCaller(signed(principal(OTHER)));
    expect(await other.assessment.attempts({ slug: 'foundations-risk-first' })).toEqual([]);
  });

  it('counts only a passing attempt toward the certificate and keeps grant idempotent', async () => {
    const academy = service({ assessmentCatalog: [TEST_QUIZ], certCatalog: [FOUNDATIONS_V1, TEST_ASSESSED] });
    await academy.submitAssessment({ userId: USER, slug: 'foundations-risk-first', clientAttemptId: 'fail-1', answers: wrong });
    const failing = await academy.certProgress({ userId: USER, certId: 'test-assessed-v1' });
    expect(failing.complete).toBe(false);
    expect(failing.missingItemSlugs).toEqual(['assessment:foundations-risk-first']);
    await expect(academy.grantCert({ userId: USER, certId: 'test-assessed-v1' })).rejects.toMatchObject({
      code: 'academy.cert_incomplete',
    });

    await academy.submitAssessment({ userId: USER, slug: 'foundations-risk-first', clientAttemptId: 'pass-2', answers: right });
    const passing = await academy.certProgress({ userId: USER, certId: 'test-assessed-v1' });
    expect(passing.complete).toBe(true);
    const granted = await academy.grantCert({ userId: USER, certId: 'test-assessed-v1' });
    const again = await academy.grantCert({ userId: USER, certId: 'test-assessed-v1' });
    expect(again.alreadyGranted).toBe(true);
    expect(again.grant.publicId).toBe(granted.grant.publicId);
    expect(again.grant.idempotencyKey).toBe(`cert:${USER}:test-assessed-v1`);
  });

  it('applies an attempt limit or cooldown only when the definition publishes one', async () => {
    const open = service({ assessmentCatalog: [TEST_QUIZ] });
    await open.submitAssessment({ userId: USER, slug: 'foundations-risk-first', clientAttemptId: 'n1', answers: wrong });
    await open.submitAssessment({ userId: USER, slug: 'foundations-risk-first', clientAttemptId: 'n2', answers: right });

    const limited = service({ assessmentCatalog: [LIMITED] });
    await limited.submitAssessment({ userId: USER, slug: 'foundations-fees-are-real', clientAttemptId: 'lim-1', answers: wrong });
    await expect(
      limited.submitAssessment({ userId: USER, slug: 'foundations-fees-are-real', clientAttemptId: 'lim-2', answers: right }),
    ).rejects.toMatchObject({ code: 'academy.attempt_limit' });
    const replay = await limited.submitAssessment({
      userId: USER,
      slug: 'foundations-fees-are-real',
      clientAttemptId: 'lim-1',
      answers: right,
    });
    expect(replay.pass).toBe(false);

    const cooling = service({ assessmentCatalog: [COOLING] });
    await cooling.submitAssessment({
      userId: USER,
      slug: 'foundations-journal-discipline',
      clientAttemptId: 'cool-1',
      answers: wrong,
      now: new Date('2026-10-17T00:00:00Z'),
    });
    await expect(
      cooling.submitAssessment({
        userId: USER,
        slug: 'foundations-journal-discipline',
        clientAttemptId: 'cool-2',
        answers: right,
        now: new Date('2026-10-17T00:00:30Z'),
      }),
    ).rejects.toMatchObject({ code: 'academy.attempt_cooldown' });
    const later = await cooling.submitAssessment({
      userId: USER,
      slug: 'foundations-journal-discipline',
      clientAttemptId: 'cool-3',
      answers: right,
      now: new Date('2026-10-17T00:01:00Z'),
    });
    expect(later.pass).toBe(true);
  });

  it('refuses a path with no certificate and leaves foundations-v1 on its lessons', async () => {
    const academy = service();
    await expect(academy.enrollCertPath({ userId: USER, pathSlug: 'markets' })).rejects.toMatchObject({
      code: 'academy.certificate_unpublished',
    });
    await expect(academy.certProgress({ userId: USER, certId: 'sovereign' })).rejects.toMatchObject({
      code: 'academy.certificate_unpublished',
    });
    const none = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM academy.cert_enrollments WHERE path_slug = 'markets'
    `;
    expect(none[0]?.n).toBe(0);
    await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
    for (const slug of FOUNDATIONS_V1.requiredItemSlugs) {
      await academy.markCurriculumComplete({ userId: USER, itemSlug: slug });
    }
    const progress = await academy.certProgress({ userId: USER, certId: 'foundations-v1' });
    expect(progress.requiredCount).toBe(7);
    expect(progress.complete).toBe(true);
    expect(progress.missingItemSlugs.some((slug) => slug.startsWith('assessment:'))).toBe(false);
    const first = await academy.grantCert({ userId: USER, certId: 'foundations-v1' });
    const second = await academy.grantCert({ userId: USER, certId: 'foundations-v1' });
    expect(second.alreadyGranted).toBe(true);
    expect(second.grant.publicId).toBe(first.grant.publicId);
  });

  it('verifies a public id without a session and refuses a blank or exceeded rate', async () => {
    const academy = service();
    for (const slug of FOUNDATIONS_V1.requiredItemSlugs) {
      await academy.markCurriculumComplete({ userId: USER, itemSlug: slug });
      await academy.markCurriculumComplete({ userId: OTHER, itemSlug: slug });
    }
    const mine = await academy.grantCert({ userId: USER, certId: 'foundations-v1' });
    const theirs = await academy.grantCert({ userId: OTHER, certId: 'foundations-v1' });
    expect(mine.grant.publicId).not.toBe(theirs.grant.publicId);
    expect(mine.grant.publicId).toMatch(/^[0-9a-f]{32}$/);
    expect(mine.grant.publicId.includes(USER.replace(/-/g, ''))).toBe(false);
    const reference = `cert:${USER}:foundations-v1`;
    expect(mine.grant.publicId).not.toBe(createHash('sha256').update(USER).digest('hex').slice(0, 32));
    expect(mine.grant.publicId).not.toBe(createHash('sha256').update(reference).digest('hex').slice(0, 32));
    expect(reference.includes(mine.grant.publicId)).toBe(false);

    await sql`
      INSERT INTO academy.cert_grants (user_id, cert_id, idempotency_key)
      VALUES (${USER}, 'backfill-v1', ${`cert:${USER}:backfill-v1`})
    `;
    const backfill = await sql<Array<{ public_id: string }>>`
      SELECT public_id FROM academy.cert_grants WHERE cert_id = 'backfill-v1' AND user_id = ${USER}
    `;
    const filled = backfill[0]?.public_id ?? '';
    expect(filled).toMatch(/^[0-9a-f]{32}$/);
    expect(filled.includes(USER.replace(/-/g, ''))).toBe(false);
    expect(filled).not.toBe(createHash('sha256').update(`cert:${USER}:backfill-v1`).digest('hex').slice(0, 32));

    const listed = await academy.myCertGrants(USER, 10);
    expect(listed.find((row) => row.certId === 'foundations-v1')?.publicId).toBe(mine.grant.publicId);

    const unset = createAcademyRouter(academy).createCaller(anonymous('203.0.113.10'));
    await expect(unset.certVerify({ publicId: mine.grant.publicId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'academy.verify_rate_unset',
    });

    const open = createAcademyRouter(academy, {}, undefined, undefined, { max: 8, windowSeconds: 60 }).createCaller(
      anonymous('203.0.113.10'),
    );
    const verified = await open.certVerify({ publicId: mine.grant.publicId });
    expect(Object.keys(verified).sort()).toEqual(['certId', 'grantedAt', 'status', 'title']);
    expect(verified).toEqual({
      certId: 'foundations-v1',
      title: 'Foundations',
      grantedAt: mine.grant.grantedAt,
      status: 'valid',
    });
    expect(JSON.stringify(verified)).not.toMatch(USER);
    expect(JSON.stringify(verified)).not.toContain('cert:');

    const malformed = await open.certVerify({ publicId: 'not-a-public-id' }).catch((err: unknown) => err);
    const unknown = await open.certVerify({ publicId: 'd'.repeat(32) }).catch((err: unknown) => err);
    expect(refusal(malformed)).toBe(refusal(unknown));
    expect(refusal(unknown)).toContain('academy.cert_not_found');

    await sql`UPDATE academy.cert_grants SET status = 'revoked' WHERE public_id = ${mine.grant.publicId}`;
    const revoked = await open.certVerify({ publicId: mine.grant.publicId });
    expect(revoked.status).toBe('revoked');
    expect(Object.keys(revoked).sort()).toEqual(['certId', 'grantedAt', 'status', 'title']);

    const capped = createAcademyRouter(academy, {}, undefined, undefined, { max: 1, windowSeconds: 60 });
    const firstAddress = capped.createCaller(anonymous('203.0.113.20'));
    await expect(firstAddress.certVerify({ publicId: 'e'.repeat(32) })).rejects.toMatchObject({
      cause: { code: 'academy.cert_not_found' },
    });
    await expect(firstAddress.certVerify({ publicId: 'f'.repeat(32) })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'academy.verify_rate_limited',
    });
    const secondAddress = capped.createCaller(anonymous('203.0.113.21'));
    await expect(secondAddress.certVerify({ publicId: 'e'.repeat(32) })).rejects.toMatchObject({
      cause: { code: 'academy.cert_not_found' },
    });
    await expect(capped.createCaller(anonymous()).certVerify({ publicId: mine.grant.publicId })).rejects.toMatchObject({
      message: 'academy.verify_address_unset',
    });
  });

  it('shows a holder name only after that holder consents', async () => {
    const academy = service();
    for (const slug of FOUNDATIONS_V1.requiredItemSlugs) {
      await academy.markCurriculumComplete({ userId: USER, itemSlug: slug });
      await academy.markCurriculumComplete({ userId: OTHER, itemSlug: slug });
    }
    const mine = await academy.grantCert({ userId: USER, certId: 'foundations-v1' });
    const theirs = await academy.grantCert({ userId: OTHER, certId: 'foundations-v1' });
    const rate = { max: 20, windowSeconds: 60 } as const;
    const reader = () => createAcademyRouter(academy, {}, undefined, undefined, rate).createCaller(anonymous('203.0.113.30'));
    const before = await reader().certVerify({ publicId: mine.grant.publicId });
    expect(before).not.toHaveProperty('holderName');

    const holder = createAcademyRouter(academy).createCaller(signed());
    const named = await holder.setCertHolderName({
      publicId: mine.grant.publicId,
      holderName: '  Ada Lovelace  ',
      consent: true,
      clientRequestId: 'name-1',
    });
    expect(named.holderName).toBe('Ada Lovelace');
    const shown = await reader().certVerify({ publicId: mine.grant.publicId });
    expect(shown.holderName).toBe('Ada Lovelace');
    expect(Object.keys(shown).sort()).toEqual(['certId', 'grantedAt', 'holderName', 'status', 'title']);

    const replay = await holder.setCertHolderName({
      publicId: mine.grant.publicId,
      holderName: 'Bob',
      consent: true,
      clientRequestId: 'name-1',
    });
    expect(replay.holderName).toBe('Ada Lovelace');
    expect(replay.consentAt?.toISOString()).toBe(named.consentAt?.toISOString());
    expect((await reader().certVerify({ publicId: mine.grant.publicId })).holderName).toBe('Ada Lovelace');

    const cleared = await holder.setCertHolderName({
      grantId: 'foundations-v1',
      holderName: null,
      consent: true,
      clientRequestId: 'name-2',
    });
    expect(cleared.holderName).toBeNull();
    expect(await reader().certVerify({ publicId: mine.grant.publicId })).not.toHaveProperty('holderName');

    const stranger = createAcademyRouter(academy).createCaller(signed(principal(OTHER)));
    await expect(
      stranger.setCertHolderName({
        publicId: mine.grant.publicId,
        holderName: 'Not theirs',
        consent: true,
        clientRequestId: 'name-other',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', cause: { code: 'academy.cert_not_found' } });
    expect((await reader().certVerify({ publicId: theirs.grant.publicId })).holderName).toBeUndefined();

    await expect(
      holder.setCertHolderName({
        publicId: mine.grant.publicId,
        holderName: 'Ada\nLovelace',
        consent: true,
        clientRequestId: 'name-3',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'academy.holder_name_invalid' } });
  });
});
