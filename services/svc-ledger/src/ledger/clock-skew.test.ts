import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import postgres from 'postgres';
import { issueAccessToken } from '@intafaced/auth';
import { MemoryEventBus } from '@intafaced/events';
import { LedgerError, parseAmount, recipes } from '@intafaced/ledger-client';
import { registerOperatorHttp } from '../operator-http.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { LedgerService } from '../service.js';
import { httpError } from '../s2s-http.js';
import { SKEW_BOUND_UNSET, WRITES_BLOCKED_CLOCK_SKEW, assessClockSkew, parseClockSkewBoundMs } from './clock-skew.js';

const APP = new Date('2026-10-23T00:00:00.000Z');
const DB = new Date('2026-10-23T00:00:00.000Z');
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('parseClockSkewBoundMs', () => {
  it('treats blank as unset, not as zero and not as a default window', () => {
    expect(parseClockSkewBoundMs(undefined)).toBeNull();
    expect(parseClockSkewBoundMs(null)).toBeNull();
    expect(parseClockSkewBoundMs('')).toBeNull();
    expect(parseClockSkewBoundMs('   ')).toBeNull();
  });

  it('keeps an explicit zero', () => {
    expect(parseClockSkewBoundMs('0')).toBe(0);
    expect(parseClockSkewBoundMs(' 0 ')).toBe(0);
  });

  it('refuses a non-integer, a sign, or a scientific form', () => {
    for (const raw of ['-1', '1.5', '1e3', '+10', '00', 'abc', ' 12ms']) {
      expect(() => parseClockSkewBoundMs(raw), raw).toThrow(/LEDGER_CLOCK_SKEW_BOUND_MS/);
    }
  });
});

describe('assessClockSkew', () => {
  it('refuses a blank bound with ledger.skew_bound_unset and does not invent one', () => {
    const view = assessClockSkew({ boundMs: null, appNow: APP, databaseNow: DB });
    expect(view).toEqual({
      ok: false,
      code: SKEW_BOUND_UNSET,
      boundMs: null,
      skewMs: '0',
      appNow: APP.toISOString(),
      databaseNow: DB.toISOString(),
    });
  });

  it('allows an explicit zero only when the clocks match', () => {
    expect(assessClockSkew({ boundMs: 0, appNow: APP, databaseNow: DB }).ok).toBe(true);
    const blocked = assessClockSkew({
      boundMs: 0,
      appNow: APP,
      databaseNow: new Date(APP.getTime() + 1),
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe(WRITES_BLOCKED_CLOCK_SKEW);
    expect(blocked.boundMs).toBe('0');
    expect(blocked.skewMs).toBe('1');
  });

  it('allows a difference equal to the bound and blocks one millisecond past it', () => {
    const within = assessClockSkew({
      boundMs: 1000,
      appNow: APP,
      databaseNow: new Date(APP.getTime() - 1000),
    });
    expect(within).toMatchObject({ ok: true, code: null, boundMs: '1000', skewMs: '1000' });
    const past = assessClockSkew({
      boundMs: 1000,
      appNow: APP,
      databaseNow: new Date(APP.getTime() - 1001),
    });
    expect(past).toMatchObject({ ok: false, code: WRITES_BLOCKED_CLOCK_SKEW, skewMs: '1001' });
  });
});

describe('LedgerService clock skew', () => {
  const deposit = recipes.deposit({
    userId: USER,
    assetId: 'USDT',
    amount: parseAmount('1'),
    rail: 'test',
    railRef: 'clock-skew-1',
  });

  it('does not read the database clock on post when the bound is blank', async () => {
    let reads = 0;
    const service = new LedgerService({} as never, new MemoryEventBus(), {
      clockSkewBoundMs: null,
      readDatabaseNow: async () => {
        reads += 1;
        return DB;
      },
    });
    await expect(service.post(deposit)).rejects.not.toMatchObject({ code: WRITES_BLOCKED_CLOCK_SKEW });
    expect(reads).toBe(0);
    await expect(service.clockSkew()).resolves.toMatchObject({ ok: false, code: SKEW_BOUND_UNSET, boundMs: null });
    expect(reads).toBe(1);
  });

  it('refuses the post before booking when an explicit bound is exceeded', async () => {
    let reads = 0;
    const service = new LedgerService({} as never, new MemoryEventBus(), {
      clockSkewBoundMs: 0,
      now: () => APP,
      readDatabaseNow: async () => {
        reads += 1;
        return new Date(APP.getTime() + 5);
      },
    });
    await expect(service.post(deposit)).rejects.toBeInstanceOf(LedgerError);
    await expect(service.post(deposit)).rejects.toMatchObject({ code: WRITES_BLOCKED_CLOCK_SKEW });
    expect(reads).toBe(2);
    expect(httpError(new LedgerError('blocked', WRITES_BLOCKED_CLOCK_SKEW))).toEqual({
      status: 503,
      body: { message: WRITES_BLOCKED_CLOCK_SKEW, code: WRITES_BLOCKED_CLOCK_SKEW },
    });
  });
});

describe('GET /operator/integrity/clock', () => {
  const tokens = {
    secret: 'a-ledger-operator-test-secret-long-enough',
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
  };

  async function bearer(): Promise<string> {
    const { token } = await issueAccessToken(
      {
        userId: USER,
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        scopes: ['admin:treasury'],
        tier: 'basic',
        mfa: true,
      },
      tokens,
    );
    return `Bearer ${token}`;
  }

  it('requires an operator and returns the unset code without a bound', async () => {
    const app = Fastify({ logger: false });
    const view = {
      ok: false as const,
      code: SKEW_BOUND_UNSET,
      boundMs: null,
      skewMs: '4',
      appNow: APP.toISOString(),
      databaseNow: DB.toISOString(),
    };
    registerOperatorHttp(
      app,
      { clockSkew: async () => view } as never,
      tokens,
      stubApprovalConsumer('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    );
    const bare = await app.inject({ method: 'GET', url: '/operator/integrity/clock' });
    expect(bare.statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/operator/integrity/clock', headers: { authorization: await bearer() } });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual(view);
    await app.close();
  });
});

describe('clock skew against postgres', () => {
  const url = process.env.TEST_DATABASE_URL?.trim();

  it('refuses a blank bound and blocks an explicit zero against a shifted app clock', async () => {
    if (!url) throw new Error('TEST_DATABASE_URL is required for the clock-skew postgres proof');
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const blank = new LedgerService(sql, new MemoryEventBus(), { clockSkewBoundMs: null });
      const unset = await blank.clockSkew();
      expect(unset.ok).toBe(false);
      if (unset.ok) return;
      expect(unset.code).toBe(SKEW_BOUND_UNSET);
      expect(unset.boundMs).toBeNull();
      expect(unset.skewMs).toMatch(/^\d+$/);

      const wide = new LedgerService(sql, new MemoryEventBus(), { clockSkewBoundMs: 86_400_000 });
      await expect(wide.clockSkew()).resolves.toMatchObject({ ok: true, code: null, boundMs: '86400000' });

      const zero = new LedgerService(sql, new MemoryEventBus(), {
        clockSkewBoundMs: 0,
        now: () => new Date(Date.now() + 60_000),
      });
      const blocked = await zero.clockSkew();
      expect(blocked).toMatchObject({ ok: false, code: WRITES_BLOCKED_CLOCK_SKEW, boundMs: '0' });
      const deposit = recipes.deposit({
        userId: USER,
        assetId: 'USDT',
        amount: parseAmount('1'),
        rail: 'test',
        railRef: 'clock-skew-pg',
      });
      await expect(zero.post(deposit)).rejects.toMatchObject({ code: WRITES_BLOCKED_CLOCK_SKEW });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
