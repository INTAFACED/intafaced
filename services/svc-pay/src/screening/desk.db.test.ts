import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  ACTION_APPROVAL_PAYLOAD_MISMATCH,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from '../action-approval-consume.js';
import { FRESH, settleGuardRefusal, type GuardReplay, type PartialPayGuards } from '../seams/guards.js';
import { createScreeningRouter } from './desk-router.js';
import { ScreeningDeskService } from './desk-service.js';
import { createScreeningGuards, screeningSubjectKey, type ScreeningScreener } from './guard.js';
import { createSqlScreeningCaseStore } from './store.js';

/**
 * The compliance desk over screened sends (W-compliance-notices-02), against a real Postgres with every forward
 * migration, the real guard and the real router. TEST figures only; no list contents and no supplier exist here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_screening_desk_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const OFFICER = 'officer-a';
const SECOND = 'officer-b';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

describe('screening desk (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let approver: string | null = SECOND;
  let consumed: ActionApprovalConsumeInput[] = [];
  let bindHash: string | null = null;
  let ttl: number | null = 600;
  let posture: 'blank' | 'named' = 'named';
  let answer: 'review' | 'clear' | 'refuse' | 'down' = 'review';

  const approvals: ActionApprovalConsumer = {
    async consume(input) {
      consumed.push(input);
      if (bindHash !== null && input.payloadHash !== bindHash) {
        throw new ActionApprovalConsumeError('payload hash does not match the approved action', ACTION_APPROVAL_PAYLOAD_MISMATCH);
      }
      if (approver === null) return unwiredApprovalConsumer().consume(input);
      return stubApprovalConsumer(approver).consume(input);
    },
  };
  const screener: ScreeningScreener = async () => {
    if (answer === 'down') throw new Error('supplier down');
    return { category: answer, factors: [{ code: answer === 'review' ? 'possible_match' : `provider_${answer}` }] };
  };

  const desk = () =>
    new ScreeningDeskService({
      sql: db.sql,
      approvals,
      screener,
      providerLabel: 'test-supplier',
      releaseTtlSeconds: ttl,
      listPosture: posture,
    });
  const guards = (): PartialPayGuards =>
    createScreeningGuards({
      sql: db.sql,
      screener,
      listPosture: posture,
      providerLabel: 'test-supplier',
      store: createSqlScreeningCaseStore(db.sql),
    });

  async function send(clientRef: string, over: { userId?: string; amount?: bigint; replay?: GuardReplay; tx?: typeof db.sql } = {}) {
    const g = guards();
    try {
      await g.beforeUserMoneyWithdrawal!({
        tx: over.tx ?? db.sql,
        userId: over.userId ?? USER,
        assetId: 'USDT',
        amount: over.amount ?? 5n * 10n ** 18n,
        rail: 'card-sandbox',
        destination: { kind: 'bank', ref: 'DE89370400440532013000' },
        clientRef,
        replay: over.replay ?? FRESH,
      });
      return 'passed' as const;
    } catch (error) {
      await settleGuardRefusal(error);
      return (error as { code: string }).code;
    }
  }
  const keyOf = (clientRef: string, userId = USER) => screeningSubjectKey('withdrawal', [userId, clientRef]);
  const approval = { approvalId: 'appr-1', operationId: 'op-1' };
  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('expected refusal');
      },
      (e: { code?: string; cause?: { code?: string } }) => e,
    );

  let router: ReturnType<typeof createScreeningRouter>;
  const caller = (scopes: string[], mfa = true) => {
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: scopes as Principal['scopes'],
      mfa,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    return router.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    router = createScreeningRouter(desk());
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    approver = SECOND;
    consumed = [];
    bindHash = null;
    ttl = 600;
    posture = 'named';
    answer = 'review';
    await db.sql.unsafe(`ALTER TABLE pay.screening_case_events DISABLE TRIGGER screening_case_events_append_only_trg`);
    await db.sql.unsafe(`TRUNCATE pay.screening_case_events, pay.screening_cases RESTART IDENTITY CASCADE`);
    await db.sql.unsafe(`ALTER TABLE pay.screening_case_events ENABLE TRIGGER screening_case_events_append_only_trg`);
  });

  describe('reading', () => {
    it('a held send leaves a case with provider, verdict, who and how much, and timing', async () => {
      expect(await send('w1')).toBe('pay.guard_screening_review');
      const detail = await desk().get('withdrawal', keyOf('w1'));
      expect(detail.case).toMatchObject({
        subjectKind: 'withdrawal',
        status: 'review',
        factors: ['possible_match'],
        provider: 'test-supplier',
        partyRef: USER,
        amount: '5',
        assetId: 'USDT',
        decision: null,
      });
      expect(Date.parse(detail.case.createdAt)).not.toBeNaN();
      expect(detail.events).toEqual([]);
    });

    it('with no supplier the verdict is a refusal, labelled provider none', async () => {
      const bare = createScreeningGuards({ sql: db.sql, listPosture: 'named' });
      await bare.beforeUserMoneyWithdrawal!({
        tx: db.sql,
        userId: USER,
        assetId: 'USDT',
        amount: 1n,
        rail: 'card-sandbox',
        destination: { kind: 'bank', ref: 'x' },
        clientRef: 'n1',
        replay: FRESH,
      }).catch(settleGuardRefusal);
      expect((await desk().get('withdrawal', keyOf('n1'))).case).toMatchObject({
        status: 'unavailable',
        provider: 'none',
        factors: ['no_result'],
      });
    });

    it('lists newest first, filters, and pages by cursor without repeating or skipping', async () => {
      for (const ref of ['a', 'b', 'c']) await send(ref);
      answer = 'refuse';
      await send('d');
      const first = await desk().list({ limit: 2 });
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await desk().list({ limit: 2, cursor: first.nextCursor! });
      expect(second.rows).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.rows, ...second.rows].map((r) => r.caseId);
      expect(new Set(ids).size).toBe(4);
      expect((await desk().list({ limit: 10, status: 'refuse' })).rows.map((r) => r.caseId)).toEqual([keyOf('d')]);
      expect(await desk().list({ limit: 10, subjectKind: 'payout' })).toEqual({ rows: [], nextCursor: null });
    });

    it('an unknown case is not found', async () => {
      expect((await refused(desk().get('withdrawal', 'a'.repeat(64)))).code).toBe('screening.case_not_found');
    });
  });

  describe('uphold', () => {
    it('needs no second person, is recorded, and is final', async () => {
      await send('u1');
      const view = await desk().decide(OFFICER, {
        subjectKind: 'withdrawal',
        caseId: keyOf('u1'),
        decision: 'uphold',
        reason: 'confirmed match',
      });
      expect(view).toMatchObject({ decision: 'upheld', decidedBy: OFFICER, approverId: null, status: 'review', releaseExpiresAt: null });
      expect(consumed).toEqual([]);
      expect((await desk().get('withdrawal', keyOf('u1'))).events.map((e) => e.action)).toEqual(['uphold']);
      expect(
        (await refused(desk().decide(OFFICER, { subjectKind: 'withdrawal', caseId: keyOf('u1'), decision: 'uphold', reason: 'again' })))
          .code,
      ).toBe('screening.case_decided');
      expect((await refused(desk().rescreen(OFFICER, { subjectKind: 'withdrawal', caseId: keyOf('u1'), reason: 'again' }))).code).toBe(
        'screening.case_decided',
      );
    });

    it('a repeat of the same send leaves the decided case as decided', async () => {
      await send('u2');
      await desk().decide(OFFICER, { subjectKind: 'withdrawal', caseId: keyOf('u2'), decision: 'uphold', reason: 'confirmed match' });
      answer = 'clear';
      expect(await send('u2')).toBe('passed');
      expect((await desk().get('withdrawal', keyOf('u2'))).case).toMatchObject({ decision: 'upheld', status: 'review' });
    });
  });

  describe('release', () => {
    const release = (clientRef: string, over: Record<string, unknown> = {}) =>
      desk().decide(OFFICER, {
        subjectKind: 'withdrawal',
        caseId: keyOf(clientRef),
        decision: 'release',
        reason: 'documents checked',
        ...approval,
        ...over,
      } as never);

    it('needs a second person, bound to this case and reason', async () => {
      await send('r1');
      approver = null;
      expect((await refused(release('r1'))).code).toBeDefined();
      approver = OFFICER;
      expect((await refused(release('r1'))).code).toBeDefined();
      expect((await desk().get('withdrawal', keyOf('r1'))).case.decision).toBeNull();
      approver = SECOND;
      const view = await release('r1');
      expect(view).toMatchObject({ decision: 'released', decidedBy: OFFICER, approverId: SECOND, status: 'review' });
      expect(Date.parse(view.releaseExpiresAt!)).toBeGreaterThan(Date.now());
      expect(consumed.at(-1)?.targetId).toBe('pay.screening_release');
    });

    it('an approval for another reason is refused: the hash binds the case and the reason', async () => {
      await send('r2');
      const first = await release('r2').catch(() => null);
      expect(first).not.toBeNull();
      await send('r2b', { userId: OTHER });
      bindHash = consumed[0]!.payloadHash;
      const second = await refused(release('r2b', { caseId: keyOf('r2b', OTHER) }));
      expect(second.code).toBe(ACTION_APPROVAL_PAYLOAD_MISMATCH);
      expect((await desk().get('withdrawal', keyOf('r2b', OTHER))).case.decision).toBeNull();
    });

    it('a refused case, a blank list, a payout and a missing time-to-live cannot be released', async () => {
      answer = 'refuse';
      await send('x1');
      expect((await refused(release('x1'))).code).toBe('screening.release_not_allowed');
      answer = 'review';
      await send('x2');
      ttl = null;
      expect((await refused(release('x2'))).code).toBe('screening.release_ttl_unset');
      ttl = 600;
      posture = 'blank';
      expect((await refused(release('x2'))).code).toBe('screening.release_blocked_blank_list');
      posture = 'named';
      await createSqlScreeningCaseStore(db.sql).save({
        subjectKind: 'payout',
        subjectKey: 'b'.repeat(64),
        status: 'review',
        factors: [{ code: 'possible_match' }],
        context: { partyRef: USER, amount: '1', assetId: 'USDT', provider: 'p' },
      });
      expect(
        (
          await refused(
            desk().decide(OFFICER, {
              subjectKind: 'payout',
              caseId: 'b'.repeat(64),
              decision: 'release',
              reason: 'checked it',
              ...approval,
            }),
          )
        ).code,
      ).toBe('screening.release_unsupported_kind');
      expect((await desk().get('withdrawal', keyOf('x2'))).case.decision).toBeNull();
    });

    it('the database also refuses a release of a refused case or without a second person', async () => {
      answer = 'refuse';
      await send('x3');
      await expect(
        db.sql`UPDATE pay.screening_cases SET decision = 'released', decided_by = 'a', decided_at = now(), decision_reason = 'r', approver_id = 'b', release_expires_at = now() + interval '1 hour' WHERE subject_key = ${keyOf('x3')}`,
      ).rejects.toMatchObject({ constraint_name: 'screening_cases_release_ck' });
      answer = 'review';
      await send('x4');
      await expect(
        db.sql`UPDATE pay.screening_cases SET decision = 'released', decided_by = 'a', decided_at = now(), decision_reason = 'r', approver_id = 'a', release_expires_at = now() + interval '1 hour' WHERE subject_key = ${keyOf('x4')}`,
      ).rejects.toMatchObject({ constraint_name: 'screening_cases_release_ck' });
    });

    it('is spent ONCE by a NEW withdrawal key of the same party and asset, up to the case amount; the original stays rejected', async () => {
      await send('s1', { amount: 5n * 10n ** 18n });
      await release('s1');
      // The same key again is still rejected: a release is not a re-screen of the old send.
      expect(await send('s1')).toBe('pay.guard_screening_review');
      // A new key above the released amount, and another party, do not spend it.
      expect(await send('s-big', { amount: 6n * 10n ** 18n })).toBe('pay.guard_screening_review');
      expect(await send('s-other', { userId: OTHER })).toBe('pay.guard_screening_review');
      // A new key within it passes once...
      expect(await send('s2', { amount: 4n * 10n ** 18n })).toBe('passed');
      const spent = (await desk().get('withdrawal', keyOf('s1'))).case;
      expect(spent.releaseSpentAt).not.toBeNull();
      expect(spent.status).toBe('review');
      // ...and not twice.
      expect(await send('s3', { amount: 1n * 10n ** 18n })).toBe('pay.guard_screening_review');
      expect((await desk().get('withdrawal', keyOf('s1'))).events.map((e) => e.action)).toEqual(['release_spent', 'release']);
    });

    it('a send that spent its release keeps it on a retry: recovery or fresh, with the screener dark, and a rolled-back claim leaves nothing', async () => {
      await send('k1');
      await release('k1');
      // A claim that rolls back after the spend gives the release back.
      await db.sql
        .begin(async (tx) => {
          expect(await send('k2', { amount: 1n * 10n ** 18n, tx })).toBe('passed');
          throw new Error('claim rolled back');
        })
        .catch(() => undefined);
      expect((await desk().get('withdrawal', keyOf('k1'))).case.releaseSpentAt).toBeNull();
      // The claim commits: the release is spent for k2.
      expect(await send('k2', { amount: 1n * 10n ** 18n })).toBe('passed');
      expect((await desk().get('withdrawal', keyOf('k1'))).case.releaseSpentAt).not.toBeNull();
      // The process died after the claim: the retry classifies as recovery, and the screener is dark. It must not refuse.
      answer = 'down';
      expect(await send('k2', { amount: 1n * 10n ** 18n, replay: { kind: 'recovery', reason: 'withdrawal_hold_booked' } })).toBe('passed');
      // Or the claim committed before the hold: the retry is still fresh. It spends no second release.
      expect(await send('k2', { amount: 1n * 10n ** 18n })).toBe('passed');
      // A retry above the released amount is not covered.
      expect(await send('k2', { amount: 6n * 10n ** 18n })).toBe('pay.guard_screening_unavailable');
      answer = 'review';
      await send('k4');
      await release('k4');
      expect(await send('k2', { amount: 1n * 10n ** 18n })).toBe('passed');
      expect((await desk().get('withdrawal', keyOf('k4'))).case.releaseSpentAt).toBeNull();
      // A recovery with no release of its own draws none.
      expect(await send('k5', { replay: { kind: 'recovery', reason: 'withdrawal_hold_booked' } })).toBe('pay.guard_screening_review');
      expect((await desk().get('withdrawal', keyOf('k4'))).case.releaseSpentAt).toBeNull();
      // Once the release has expired, the same send is not honoured again.
      await db.sql`UPDATE pay.screening_cases SET release_expires_at = now() - interval '1 second' WHERE subject_key = ${keyOf('k1')}`;
      expect(await send('k2', { amount: 1n * 10n ** 18n, replay: { kind: 'recovery', reason: 'withdrawal_hold_booked' } })).toBe(
        'pay.guard_screening_review',
      );
    });

    it('a send whose own case was refused or upheld is not covered by another send’s release', async () => {
      answer = 'refuse';
      await send('m1', { amount: 1n * 10n ** 18n });
      answer = 'review';
      await send('m2');
      await release('m2');
      answer = 'refuse';
      expect(await send('m1', { amount: 1n * 10n ** 18n })).toBe('pay.guard_screening_refuse');
      expect((await desk().get('withdrawal', keyOf('m2'))).case.releaseSpentAt).toBeNull();
      answer = 'review';
      await send('m3', { userId: OTHER });
      await send('m4', { userId: OTHER });
      const key = (ref: string) => keyOf(ref, OTHER);
      await desk().decide(OFFICER, { subjectKind: 'withdrawal', caseId: key('m4'), decision: 'uphold', reason: 'confirmed match' });
      await desk().decide(OFFICER, {
        subjectKind: 'withdrawal',
        caseId: key('m3'),
        decision: 'release',
        reason: 'documents checked',
        ...approval,
      });
      expect(await send('m4', { userId: OTHER })).toBe('pay.guard_screening_review');
      expect((await desk().get('withdrawal', key('m3'))).case.releaseSpentAt).toBeNull();
    });

    it('a retry whose own case exists and now screens clear completes inside the claim transaction', async () => {
      await send('n1');
      answer = 'clear';
      const outcome = await Promise.race([
        db.sql.begin(async (tx) => send('n1', { tx })),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 5000)),
      ]);
      expect(outcome).toBe('passed');
    }, 15000);

    it('two sends racing for one release: exactly one spends it', async () => {
      await send('t1');
      await release('t1');
      const results = await Promise.all([send('t2', { amount: 1n * 10n ** 18n }), send('t3', { amount: 1n * 10n ** 18n })]);
      expect(results.filter((r) => r === 'passed')).toHaveLength(1);
    });

    it('an expired release spends nothing, and a blank list honours none', async () => {
      await send('e1');
      await release('e1');
      await db.sql`UPDATE pay.screening_cases SET release_expires_at = now() - interval '1 second' WHERE subject_key = ${keyOf('e1')}`;
      expect(await send('e2', { amount: 1n * 10n ** 18n })).toBe('pay.guard_screening_review');
      await send('e3');
      await release('e3');
      posture = 'blank';
      expect(await send('e4', { amount: 1n * 10n ** 18n })).toBe('pay.guard_screening_unavailable');
      expect((await desk().get('withdrawal', keyOf('e3'))).case.releaseSpentAt).toBeNull();
    });
  });

  describe('rescreen', () => {
    it('writes the new answer and history; a clear answer releases nothing', async () => {
      await send('q1');
      answer = 'clear';
      const view = await desk().rescreen(OFFICER, { subjectKind: 'withdrawal', caseId: keyOf('q1'), reason: 'supplier updated' });
      expect(view).toMatchObject({ status: 'clear', decision: null, releaseExpiresAt: null });
      const events = (await desk().get('withdrawal', keyOf('q1'))).events;
      expect(events[0]).toMatchObject({ action: 'rescreen', fromStatus: 'review', toStatus: 'clear' });
      expect(await send('q2')).toBe('passed');
    });

    it('a dark supplier or a blank list rescreens to unavailable, never clear', async () => {
      await send('q3');
      answer = 'down';
      expect((await desk().rescreen(OFFICER, { subjectKind: 'withdrawal', caseId: keyOf('q3'), reason: 'try again' })).status).toBe(
        'unavailable',
      );
      answer = 'clear';
      posture = 'blank';
      expect((await desk().rescreen(OFFICER, { subjectKind: 'withdrawal', caseId: keyOf('q3'), reason: 'try again' })).status).toBe(
        'unavailable',
      );
    });
  });

  describe('sanctions list status', () => {
    it('says blank and unconfigured when nothing is set, with no list contents', () => {
      const status = new ScreeningDeskService({ sql: db.sql, approvals, env: {}, releaseTtlSeconds: null }).listStatus();
      expect(status).toEqual({ posture: 'blank', grade: 'unconfigured', regionCount: 0, supplier: 'none', releaseTtlSeconds: null });
    });
    it('names a counsel-sourced list as named and says whether a supplier is connected', () => {
      const env = { INTAFACED_SANCTIONS_REGIONS: 'AA:programme ref', INTAFACED_SANCTIONS_LIST_SOURCE: 'governance-record-1' };
      const status = new ScreeningDeskService({ sql: db.sql, approvals, env, screener, releaseTtlSeconds: 60 }).listStatus();
      expect(status).toEqual({ posture: 'named', grade: 'counsel', regionCount: 1, supplier: 'connected', releaseTtlSeconds: 60 });
    });
  });

  describe('the door', () => {
    it('needs the compliance scope, and MFA to decide or rescreen', async () => {
      await send('d1');
      const input = { subjectKind: 'withdrawal' as const, caseId: keyOf('d1') };
      await expect(caller(['pay:read']).screening.cases.list({ limit: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller(['admin:compliance']).screening.cases.list({ limit: 5 })).resolves.toMatchObject({
        rows: [expect.objectContaining({ caseId: input.caseId })],
      });
      await expect(
        caller(['admin:compliance'], false).screening.cases.decide({ ...input, decision: 'uphold', reason: 'confirmed' }),
      ).rejects.toBeDefined();
      await expect(
        caller(['admin:compliance'], true).screening.cases.decide({ ...input, decision: 'uphold', reason: 'confirmed' }),
      ).resolves.toMatchObject({ decision: 'upheld' });
    });
    it('refuses a list with no page size and an input with an extra field', async () => {
      const c = caller(['admin:compliance']);
      await expect(c.screening.cases.list({} as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        c.screening.cases.get({ subjectKind: 'withdrawal', caseId: 'a'.repeat(64), partyRef: 'x' } as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
