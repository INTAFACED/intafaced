import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { ActivityService, type LedgerPageRequest } from '../activity/activity-service.js';
import { StatementService } from './statement-service.js';
import {
  parseStatementJobsInterval,
  parseStatementJobsLease,
  parseStatementJobsTestHold,
  StatementJobService,
  startStatementJobWorker,
  statementJobKey,
} from './statement-jobs.js';

/**
 * PF-statements-02 (J-portfolio-11 #4, #5): background exports against the real `bank.statement_jobs` table. A request is
 * checked when asked, the same request is the same job, a worker that dies mid-render leaves a claim that lapses and is
 * taken again on the same key, and the second file is byte-for-byte the file a direct download makes as of the same moment.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!parsed.pathname.replace(/^\//, '').endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

if (!process.env.TEST_DATABASE_URL?.trim()) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');

const SECRET = 'a-bank-statement-job-test-secret-long-enough';
let users = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++users).padStart(12, '0')}`;

let db!: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: dedicatedTestUrl(process.env.TEST_DATABASE_URL!.trim()), migrations });
}, 120_000);
afterAll(() => db?.drop());

/** Ledger pages with two posted lines for every person; `down` makes the read fail as an outage would. */
function activity(state = { down: false }): ActivityService {
  return new ActivityService(
    { allNamedSpaces: async () => [] },
    {
      cursorSecret: SECRET,
      pages: {
        async page(req: LedgerPageRequest) {
          if (state.down) throw new Error('ledger history unreachable');
          if (req.cursor !== undefined || req.ownerType !== 'user') return { entries: [], nextCursor: null };
          return {
            entries: [
              {
                txId: 'tx-2',
                module: 'bank',
                reason: 'bank.transfer.manual',
                direction: 'debit' as const,
                amount: '2.25',
                postedAt: new Date('2026-10-05T00:00:00.000Z'),
                assetId: 'USDT',
                entryId: '2',
              },
              {
                txId: 'tx-1',
                module: 'bank',
                reason: 'bank.transfer.manual',
                direction: 'credit' as const,
                amount: '12.50',
                postedAt: new Date('2026-10-04T00:00:00.000Z'),
                assetId: 'USDT',
                entryId: '1',
              },
            ],
            nextCursor: null,
          };
        },
      },
    },
  );
}

const LONG = { from: '2025-11-07T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z', format: 'csv' as const, report: 'ledger' as const };

function service(leaseMs: number | null = 60_000, state = { down: false }) {
  const statements = new StatementService(activity(state), SECRET);
  return { statements, jobs: new StatementJobService(db.sql, statements, { leaseMs }) };
}

describe('bank.statements.jobs', () => {
  it('refuses when background exports are off, and writes no row', async () => {
    const { jobs } = service(null);
    const who = fresh();
    await expect(jobs.create(who, LONG)).rejects.toMatchObject({ code: 'bank.statement_jobs_unset' });
    expect(await jobs.list(who)).toEqual([]);
  });

  it('refuses at request what the file would be refused for, before any row', async () => {
    const { jobs } = service();
    const who = fresh();
    await expect(
      jobs.create(who, { from: '2026-09-20T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', format: 'pdf' }),
    ).rejects.toMatchObject({ code: 'bank.statement_pdf_one_month' });
    await expect(jobs.create(who, { ...LONG, report: 'balances' })).rejects.toMatchObject({ code: 'bank.statement_balances_unavailable' });
    await expect(jobs.create(who, { ...LONG, from: '2024-01-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'bank.statement_range' });
    expect(await jobs.list(who)).toEqual([]);
  });

  it('returns the same job for the same request, however the instants are spelled', async () => {
    const { jobs } = service();
    const who = fresh();
    const first = await jobs.create(who, LONG);
    expect(first).toMatchObject({ state: 'queued', attempts: 0, report: 'ledger', format: 'csv' });
    const again = await jobs.create(who, { ...LONG, from: '2025-11-07T00:00:00Z', to: '2026-11-06T08:00:00+08:00' });
    expect(again.id).toBe(first.id);
    const other = await jobs.create(who, { ...LONG, report: 'trades' });
    expect(other.id).not.toBe(first.id);
    expect((await jobs.list(who)).map((job) => job.id)).toEqual([other.id, first.id]);
    expect(statementJobKey({ ...LONG, assetId: null, spaceId: null })).toBe(
      'statement-job:ledger:csv:2025-11-07T00:00:00.000Z:2026-11-06T00:00:00.000Z:-:-',
    );
  });

  it('makes a queued job and hands back the same file a direct download makes as of the same moment', async () => {
    const { jobs, statements } = service();
    const who = fresh();
    const asOf = new Date('2026-11-06T01:02:03.000Z');
    const job = await jobs.create(who, LONG, asOf);
    await expect(jobs.download(who, job.id)).rejects.toMatchObject({ code: 'bank.statement_job_not_ready' });
    let made = await jobs.renderNext();
    while (made && made.id !== job.id) made = await jobs.renderNext();
    expect(made).toMatchObject({ id: job.id, state: 'ready', attempts: 1, rowCount: 2 });
    const file = await jobs.download(who, job.id);
    const direct = await statements.export(who, { ...LONG, now: asOf });
    expect(file.bodyBase64).toBe(direct.bodyBase64);
    expect(file.sha256).toBe(direct.sha256);
    expect(file.signature).toBe(direct.signature);
    expect(file.proof).toMatchObject({ holderUserId: who, report: 'ledger', generatedAt: asOf.toISOString(), sha256: direct.sha256 });
  });

  it('re-queues a job whose worker died mid-render on the same key, and the second file has the same content', async () => {
    const { jobs, statements } = service(50);
    const who = fresh();
    const job = await jobs.create(who, LONG);
    // A worker claims it and dies: nothing it would have written is written.
    let dead = await jobs.claim();
    while (dead && dead.id !== job.id) dead = await jobs.claim();
    expect(dead).toMatchObject({ id: job.id, state: 'rendering', attempts: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    let made = await jobs.renderNext();
    while (made && made.id !== job.id) made = await jobs.renderNext();
    expect(made).toMatchObject({ id: job.id, state: 'ready', attempts: 2 });
    // Still one job for the request.
    expect((await jobs.create(who, LONG)).id).toBe(job.id);
    expect((await jobs.list(who)).length).toBe(1);
    const direct = await statements.export(who, { ...LONG, now: new Date(job.createdAt) });
    const file = await jobs.download(who, job.id);
    expect(file.sha256).toBe(direct.sha256);
    expect(file.bodyBase64).toBe(direct.bodyBase64);
  });

  it('a stale worker cannot overwrite the claim another worker took after its lease lapsed', async () => {
    const { jobs } = service(50);
    const who = fresh();
    const job = await jobs.create(who, { ...LONG, report: 'trades' });
    let first = await jobs.claim();
    while (first && first.id !== job.id) first = await jobs.claim();
    await new Promise((resolve) => setTimeout(resolve, 120));
    let second = await jobs.claim();
    while (second && second.id !== job.id) second = await jobs.claim();
    expect(second).toMatchObject({ id: job.id, attempts: 2 });
    // The first worker comes back and tries to fail the job on its old claim: nothing changes.
    const touched = await db.sql`
      UPDATE bank.statement_jobs SET state = 'failed', error_code = 'x', finished_at = now(), lease_until = NULL
       WHERE id = ${job.id} AND state = 'rendering' AND attempts = ${first!.attempts}
      RETURNING id
    `;
    expect(touched.length).toBe(0);
  });

  it('re-queues on an activity outage after a wait, and only another person reads as not found', async () => {
    const state = { down: true };
    const { jobs } = service(200, state);
    const who = fresh();
    const job = await jobs.create(who, { ...LONG, report: 'statement' });
    let made = await jobs.renderNext();
    while (made && made.id !== job.id) made = await jobs.renderNext();
    expect(made).toMatchObject({ id: job.id, state: 'queued', attempts: 1 });
    state.down = false;
    // Not claimed again in the same breath: a brief outage cannot use every attempt at once.
    expect((await jobs.renderNext())?.id).not.toBe(job.id);
    await new Promise((resolve) => setTimeout(resolve, 250));
    made = await jobs.renderNext();
    while (made && made.id !== job.id) made = await jobs.renderNext();
    expect(made).toMatchObject({ id: job.id, state: 'ready', attempts: 2 });
    const stranger = fresh();
    await expect(jobs.download(stranger, job.id)).rejects.toMatchObject({ code: 'bank.statement_job_not_found' });
    expect(await jobs.list(stranger)).toEqual([]);
  });

  it('refuses a range that has not ended, so the same request is always the same document', async () => {
    const { jobs } = service();
    const now = new Date('2026-11-06T10:00:00.000Z');
    await expect(
      jobs.create(fresh(), { ...LONG, from: '2026-11-01T00:00:00.000Z', to: '2026-11-06T23:59:59.999Z' }, now),
    ).rejects.toMatchObject({ code: 'bank.statement_job_unfinished' });
  });

  it('queues a failed request again when it is asked for again', async () => {
    const { jobs } = service();
    const who = fresh();
    const job = await jobs.create(who, { ...LONG, report: 'trades', to: '2026-11-04T00:00:00.000Z' });
    await db.sql`
      UPDATE bank.statement_jobs SET state = 'failed', error_code = 'bank.statement_unavailable', finished_at = now(), attempts = 5
       WHERE id = ${job.id}
    `;
    const again = await jobs.create(who, { ...LONG, report: 'trades', to: '2026-11-04T00:00:00.000Z' });
    expect(again).toMatchObject({ id: job.id, state: 'queued', attempts: 0, errorCode: null });
  });

  it('marks failed a lapsed claim that has used every attempt, instead of claiming it again', async () => {
    const { jobs } = service(50);
    const who = fresh();
    const job = await jobs.create(who, { ...LONG, report: 'trades', to: '2026-11-03T00:00:00.000Z' });
    await db.sql`
      UPDATE bank.statement_jobs SET state = 'rendering', attempts = 5, lease_until = now() - interval '1 second' WHERE id = ${job.id}
    `;
    let made = await jobs.renderNext();
    while (made && made.id !== job.id) made = await jobs.renderNext();
    expect(made).toBeNull();
    expect((await jobs.list(who))[0]).toMatchObject({ id: job.id, state: 'failed', errorCode: 'bank.statement_unavailable' });
  });

  it('a background PDF is the direct download of the same request, byte for byte, as the dates were spelled', async () => {
    const { jobs, statements } = service();
    const who = fresh();
    const request = { from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z', format: 'pdf' as const };
    const asOf = new Date('2026-11-06T02:00:00.000Z');
    const job = await jobs.create(who, request, asOf);
    let made = await jobs.renderNext();
    while (made && made.id !== job.id) made = await jobs.renderNext();
    expect(made).toMatchObject({ state: 'ready' });
    const direct = await statements.export(who, { ...request, now: asOf });
    expect((await jobs.download(who, job.id)).bodyBase64).toBe(direct.bodyBase64);
  });

  it('renews its claim while a render runs, so a long render is not taken by a second worker', async () => {
    const statements = new StatementService(activity(), SECRET);
    const slow = new StatementJobService(db.sql, statements, { leaseMs: 100, testRenderHoldMs: 400 });
    const other = new StatementJobService(db.sql, statements, { leaseMs: 100 });
    const who = fresh();
    // Make everything older first, so the slow worker claims this job.
    while (await other.renderNext());
    const job = await slow.create(who, { ...LONG, report: 'trades', to: '2026-11-02T00:00:00.000Z' });
    const making = (async () => {
      let made = await slow.renderNext();
      while (made && made.id !== job.id) made = await slow.renderNext();
      return made;
    })();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stolen = await other.claim();
    expect(stolen?.id).not.toBe(job.id);
    expect(await making).toMatchObject({ id: job.id, state: 'ready', attempts: 1 });
  });

  it('the worker makes queued jobs on its interval and stops', async () => {
    const { jobs } = service();
    const who = fresh();
    const job = await jobs.create(who, { ...LONG, format: 'csv', report: 'statement', to: '2026-11-05T00:00:00.000Z' });
    const worker = startStatementJobWorker({ jobs, intervalMs: 20 });
    expect(worker.running).toBe(true);
    try {
      await expect.poll(async () => (await jobs.list(who)).find((j) => j.id === job.id)?.state, { timeout: 5_000 }).toBe('ready');
    } finally {
      worker.stop();
    }
    const warned: string[] = [];
    expect(startStatementJobWorker({ jobs, intervalMs: null, onWarn: (m) => warned.push(m) }).running).toBe(false);
    expect(warned[0]).toMatch(/background exports are off/);
  });
});

describe('background export settings', () => {
  it('stay off when unset or blank, and refuse boot when out of range', () => {
    expect(parseStatementJobsInterval(undefined)).toBeNull();
    expect(parseStatementJobsInterval('  ')).toBeNull();
    expect(parseStatementJobsInterval('2000')).toBe(2000);
    expect(() => parseStatementJobsInterval('10')).toThrow(/BANK_STATEMENT_JOBS_INTERVAL_MS/);
    expect(parseStatementJobsLease('')).toBeNull();
    expect(() => parseStatementJobsLease('soon')).toThrow(/BANK_STATEMENT_JOBS_LEASE_MS/);
  });

  it('the TEST render hold runs only in an explicit dev or test process', () => {
    expect(parseStatementJobsTestHold(undefined, { APP_ENV: 'prod' })).toBeNull();
    expect(parseStatementJobsTestHold('5000', { APP_ENV: 'dev' })).toBe(5000);
    expect(() => parseStatementJobsTestHold('5000', { APP_ENV: 'prod' })).toThrow(/TEST fault/);
    expect(() => parseStatementJobsTestHold('5000', { APP_ENV: 'test', NODE_ENV: 'production' })).toThrow(/TEST fault/);
  });
});
