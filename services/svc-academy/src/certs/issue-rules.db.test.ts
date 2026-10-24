/**
 * AC-certificates-02: certificate issue rules against Postgres. Manual (no rule) issues nothing by itself; automatic
 * issues once on the last required completion; delayed waits for the owner's delay, survives a crash between completion
 * and issue, drops its wait on an Undo, and is issued once by the sweep. A rule change is a revision with its history.
 * The delay figures are TEST values.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { FOUNDATIONS_V1 } from './catalog.js';
import type { CertGrantRecord } from './progress.js';
import type { CertXpEmitResult, CertXpPublisher } from './xp-publish.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '44444444-4444-4444-8444-444444444444';
const CERT = FOUNDATIONS_V1.id;
const ITEMS = FOUNDATIONS_V1.requiredItemSlugs;
const T0 = new Date('2026-10-24T12:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** Counts XP publications, so a test can see each grant publishes once per issue and never posts anything else. */
class CountingXp implements CertXpPublisher {
  readonly id = 'counting';
  readonly usable = true;
  readonly published: string[] = [];
  async publishCertXp(grant: CertGrantRecord): Promise<CertXpEmitResult> {
    this.published.push(`${grant.userId}:${grant.certId}`);
    return { emitted: false, reason: 'publisher_unavailable' };
  }
}

function service(xp: CertXpPublisher = new CountingXp(), sweepSeconds: number | null = 5) {
  return new AcademyService(
    sql,
    { stakeOf: async () => 0n },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false, ...(sweepSeconds === null ? {} : { certIssueSweepSeconds: sweepSeconds }) },
    xp,
  );
}

const grants = async () =>
  (await sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM academy.cert_grants WHERE user_id = ${USER} AND cert_id = ${CERT}`)[0]!.n;

async function finish(academy: AcademyService, at: Date, items: readonly string[] = ITEMS) {
  await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
  for (const itemSlug of items) await academy.markCurriculumComplete({ userId: USER, itemSlug, now: at });
}

const rule = (academy: AcademyService, mode: 'manual' | 'automatic' | 'delayed', delayMinutes: number | null = null) =>
  academy.setCertIssueRule({ certId: CERT, mode, delayMinutes, reason: `TEST ${mode}`, operatorId: OPERATOR, now: T0 });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

describe('certificate issue rules', () => {
  it('with no rule nothing is issued by itself: the learner claims it, as before', async () => {
    const academy = service();
    await finish(academy, T0);
    expect(await grants()).toBe(0);
    const progress = await academy.certProgress({ userId: USER, certId: CERT, now: T0 });
    expect(progress.issue).toEqual({ mode: 'manual', delayMinutes: null, issuesAt: null });
    expect(progress.complete).toBe(true);
    await academy.grantCert({ userId: USER, certId: CERT });
    expect(await grants()).toBe(1);
  });

  it('automatic issues exactly one certificate on the last required completion, even when it is sent twice', async () => {
    const xp = new CountingXp();
    const academy = service(xp);
    await rule(academy, 'automatic');
    await finish(academy, T0, ITEMS.slice(0, -1));
    expect(await grants()).toBe(0);
    await Promise.all([
      academy.markCurriculumComplete({ userId: USER, itemSlug: ITEMS.at(-1)!, now: T0 }),
      academy.markCurriculumComplete({ userId: USER, itemSlug: ITEMS.at(-1)!, now: T0 }),
    ]);
    expect(await grants()).toBe(1);
    const progress = await academy.certProgress({ userId: USER, certId: CERT, now: T0 });
    expect(progress.granted).toBe(true);
    expect(progress.issue).toEqual({ mode: 'automatic', delayMinutes: null, issuesAt: null });
    // Each issue path asks for the XP once; identity drops repeats on the business key.
    expect(new Set(xp.published)).toEqual(new Set([`${USER}:${CERT}`]));
  });

  it('delayed issues nothing until the delay passes, refuses an early claim, and the sweep then issues it once', async () => {
    const academy = service();
    await rule(academy, 'delayed', 60);
    await finish(academy, T0);
    expect(await grants()).toBe(0);
    const waiting = await academy.certProgress({ userId: USER, certId: CERT, now: minutes(10) });
    expect(waiting.issue).toEqual({ mode: 'delayed', delayMinutes: 60, issuesAt: minutes(60) });
    await expect(academy.grantCert({ userId: USER, certId: CERT, now: minutes(10) })).rejects.toMatchObject({
      code: 'academy.cert_not_due',
    });
    expect(await academy.issueDueCertificates(minutes(59))).toBe(0);
    expect(await grants()).toBe(0);
    expect(await academy.issueDueCertificates(minutes(60))).toBe(1);
    expect(await academy.issueDueCertificates(minutes(61))).toBe(0);
    expect(await grants()).toBe(1);
    const pending = await sql`SELECT 1 FROM academy.cert_issue_pending`;
    expect(pending).toHaveLength(0);
  });

  it('a delayed certificate is due the delay after the last completion, even when the wait is first written later', async () => {
    const academy = service();
    await finish(academy, T0, ITEMS.slice(0, -1));
    await rule(academy, 'delayed', 60);
    // The completion is recorded, and the process stops before the wait is written.
    await sql`
      INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES (${USER}, ${ITEMS.at(-1)!}, ${minutes(5)})
    `;
    const later = await academy.certProgress({ userId: USER, certId: CERT, now: minutes(30) });
    expect(later.issue.issuesAt).toEqual(minutes(65));
    // A read once due issues it: the recovery path for an issue the completion never reached.
    const due = await academy.certProgress({ userId: USER, certId: CERT, now: minutes(65) });
    expect(due.granted).toBe(true);
    expect(await grants()).toBe(1);
  });

  it('an Undo before the delay passes drops the wait; nothing is issued for an incomplete course', async () => {
    const academy = service();
    await rule(academy, 'delayed', 60);
    await finish(academy, T0);
    const last = ITEMS.at(-1)!;
    const [row] = await sql<Array<{ completed_at: Date }>>`
      SELECT completed_at FROM academy.cert_item_completions WHERE user_id = ${USER} AND item_slug = ${last}
    `;
    await academy.undoCurriculumComplete({
      userId: USER,
      itemSlug: last,
      completedAt: row!.completed_at.toISOString(),
      clientRequestId: `undo:${last}:test`,
    });
    expect(await academy.issueDueCertificates(minutes(90))).toBe(1);
    expect(await grants()).toBe(0);
    expect(await sql`SELECT 1 FROM academy.cert_issue_pending`).toHaveLength(0);
  });

  it('a rule change is a new revision with its history row; the same rule again writes nothing', async () => {
    const academy = service();
    const first = await rule(academy, 'automatic');
    const again = await rule(academy, 'automatic');
    const delayed = await rule(academy, 'delayed', 30);
    expect([first.revision, again.revision, delayed.revision]).toEqual([1, 1, 2]);
    const history = await sql<Array<{ revision: number; mode: string; delay_minutes: number | null; actor: string; reason: string }>>`
      SELECT revision, mode, delay_minutes, actor, reason FROM academy.cert_issue_rule_events WHERE cert_id = ${CERT} ORDER BY revision
    `;
    expect(history.map((row) => [row.revision, row.mode, row.delay_minutes, row.actor, row.reason])).toEqual([
      [1, 'automatic', null, OPERATOR, 'TEST automatic'],
      [2, 'delayed', 30, OPERATOR, 'TEST delayed'],
    ]);
    expect(await academy.certIssueRule(CERT)).toMatchObject({ mode: 'delayed', delayMinutes: 30, revision: 2 });
  });

  it('refuses a delayed rule with no delay, a delayed rule with no sweep, and an unpublished certificate', async () => {
    await expect(rule(service(), 'delayed', null)).rejects.toMatchObject({ code: 'academy.cert_delay_unset' });
    await expect(rule(service(new CountingXp(), null), 'delayed', 60)).rejects.toMatchObject({ code: 'academy.cert_sweep_unset' });
    await expect(
      service().setCertIssueRule({ certId: 'markets', mode: 'automatic', delayMinutes: null, reason: 'TEST', operatorId: OPERATOR }),
    ).rejects.toMatchObject({ code: 'academy.certificate_unpublished' });
    expect(await sql`SELECT 1 FROM academy.cert_issue_rules`).toHaveLength(0);
  });
});
