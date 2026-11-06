/**
 * The maker incentive programme and the launch-liquidity plan per market, two-person writes (J-cex-spot-20 #8;
 * RC-cex-spot-06, RC-cex-spot-09). Real Postgres via TEST_DATABASE_URL. A blank refuses by name before any approval is
 * spent; a write consumes its approval in the transaction that inserts the version; a retry returns the same version; a
 * plan names only active programme members.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { TradeService } from '../controls/test-admission.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { MakerProgrammeAdmin } from './maker-programme.js';
import {
  LAUNCH_PLAN_ACTION_TYPE,
  LAUNCH_PLAN_MAKER_UNKNOWN,
  LAUNCH_PLAN_UNSET,
  MAKER_MEMBER_ACTION_TYPE,
  MAKER_PROGRAMME_TERM_UNSET,
  MAKER_PROGRAMME_TIER_UNKNOWN,
  MAKER_TERMS_ACTION_TYPE,
  MAKER_TERMS_TARGET,
  memberApprovalBody,
  planApprovalBody,
  termsApprovalBody,
  type MemberInput,
  type PlanInput,
  type TermsInput,
} from './maker-programme-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const MAKER = '55555555-5555-4555-8555-555555555555';
const STRANGER = '66666666-6666-4666-8666-666666666666';
const writer = () => principalFor(OP, ['admin:read', 'admin:write']);
const reader = () => principalFor(OP, ['admin:read']);

const TERMS: TermsInput = {
  tiers: [
    { name: 'TEST Bronze', minMakerVolume30d: '0', minUptimePct: '90', maxSpreadAtDepthBps: '40', rebateBps: '1' },
    { name: 'TEST Gold', minMakerVolume30d: '1000000', minUptimePct: '97.5', maxSpreadAtDepthBps: '20', rebateBps: '3' },
  ],
  maxSpreadBps: '50',
  minDepth: '25000',
  minUptimePct: '95',
  cancelToFillCeiling: '30',
  clawbackWindowDays: '90',
  equalAccessCriteria: 'TEST: any account meeting the published tier criteria is admitted.',
};
const MEMBER: MemberInput = { accountId: MAKER, tier: 'TEST Gold', status: 'active', conflictDeclaration: 'TEST: none' };
const PLAN: PlanInput = {
  makers: [{ accountId: MAKER, capital: '50000', asset: 'USDT' }],
  maxSpreadBps: '30',
  minDepth: '10000',
  depthBandBps: '50',
  minUptimePct: '95',
  inventoryMin: '-2.5',
  inventoryMax: '2.5',
  exitReviewDate: '2030-02-01',
  exitUptimeBelowPct: '80',
  exitSpreadAboveBps: '100',
};

describe('maker programme and launch-liquidity plans (two-person)', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let admin: MakerProgrammeAdmin;
  let market: string;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.launch_liquidity_plans, trade.maker_clawbacks, trade.maker_programme_members,
      trade.maker_programme_terms, trade.operator_requests, trade.operator_audit, trade.fills, trade.orders, trade.markets
      RESTART IDENTITY CASCADE`;
    const trade = new TradeService(db.sql, new MemoryLedger(), new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
    });
    for (const [symbol, base] of [
      ['ETH/USDT', 'ETH'],
      ['SOL/USDT', 'SOL'],
    ] as const) {
      await trade.listMarket({
        symbol,
        baseAsset: base,
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: null,
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
      });
    }
    const [row] = await db.sql<Array<{ id: string }>>`SELECT id::text FROM trade.markets WHERE symbol = 'ETH/USDT'`;
    market = row!.id;
    book = new MemoryApprovalBook();
    admin = new MakerProgrammeAdmin({ sql: db.sql, approvals: book });
  });

  const put = (approvalId: string, actionType: string, targetId: string, expectedVersion: string, body: unknown) =>
    book.put({
      approvalId,
      actionType,
      targetService: 'svc-trade',
      targetId,
      expectedVersion,
      payloadHash: payloadHash(body),
      requesterId: OP,
      approverId: APPROVER,
      operationId: `op-${approvalId}`,
    });
  const writeTerms = (approvalId: string, terms = TERMS, expectedVersion = '0') => {
    put(approvalId, MAKER_TERMS_ACTION_TYPE, MAKER_TERMS_TARGET, expectedVersion, termsApprovalBody(expectedVersion, terms));
    return admin.setTerms(writer(), { terms, expectedVersion, approvalId, clientRequestId: `op-${approvalId}` });
  };
  const writeMember = (approvalId: string, member = MEMBER, expectedVersion = '0') => {
    put(approvalId, MAKER_MEMBER_ACTION_TYPE, member.accountId!, expectedVersion, memberApprovalBody(expectedVersion, member));
    return admin.setMember(writer(), { member, expectedVersion, approvalId, clientRequestId: `op-${approvalId}` });
  };
  const writePlan = (approvalId: string, plan = PLAN, expectedVersion = '0') => {
    put(approvalId, LAUNCH_PLAN_ACTION_TYPE, market, expectedVersion, planApprovalBody(market, expectedVersion, plan));
    return admin.setPlan(writer(), { market, plan, expectedVersion, approvalId, clientRequestId: `op-${approvalId}` });
  };

  it('reads no terms, no members and no clawbacks, and every spot market with no plan, before anything is written', async () => {
    expect(await admin.terms(reader())).toEqual({ terms: null });
    expect(await admin.members(reader())).toEqual({ members: [] });
    expect(await admin.clawbacks(reader())).toEqual({ clawbacks: [] });
    const { markets } = await admin.plans(reader());
    expect(markets.map((m) => [m.symbol, m.plan])).toEqual([
      ['ETH/USDT', null],
      ['SOL/USDT', null],
    ]);
  });

  it('refuses a blank term by name before any approval is spent', async () => {
    const blank = { ...TERMS, minUptimePct: '' };
    put('a-blank', MAKER_TERMS_ACTION_TYPE, MAKER_TERMS_TARGET, '0', termsApprovalBody('0', TERMS));
    await expect(
      admin.setTerms(writer(), { terms: blank, expectedVersion: '0', approvalId: 'a-blank', clientRequestId: 'op-a-blank' }),
    ).rejects.toMatchObject({ code: MAKER_PROGRAMME_TERM_UNSET, message: expect.stringContaining('min uptime') });
    // The approval is still unspent: the complete terms it was bound to write with it.
    const row = await admin.setTerms(writer(), {
      terms: TERMS,
      expectedVersion: '0',
      approvalId: 'a-blank',
      clientRequestId: 'op-a-blank',
    });
    expect(row.version).toBe('1');
  });

  it('writes terms v1 under a second operator, retries to the same version, and refuses a stale or reused approval', async () => {
    const row = await writeTerms('t1');
    expect(row).toMatchObject({ version: '1', approverId: APPROVER, approvalId: 't1', maxSpreadBps: '50', minUptimePct: '95' });
    expect(row.tiers).toEqual(TERMS.tiers);
    // A lost reply retried with the same request id answers the same version, and writes nothing more.
    const again = await admin.setTerms(writer(), { terms: TERMS, expectedVersion: '0', approvalId: 't1', clientRequestId: 'op-t1' });
    expect(again).toEqual(row);
    const [count] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.maker_programme_terms`;
    expect(count!.n).toBe(1);
    await expect(writeTerms('t-stale')).rejects.toMatchObject({ code: 'trade.maker_programme_stale' });
    const v2 = await writeTerms('t2', { ...TERMS, cancelToFillCeiling: '25' }, '1');
    expect(v2).toMatchObject({ version: '2', cancelToFillCeiling: '25' });
    expect((await admin.terms(reader())).terms).toMatchObject({ version: '2', clawbackWindowDays: '90' });
    const audits = await db.sql`SELECT 1 FROM trade.operator_audit WHERE kind = 'maker_programme.terms'`;
    expect(audits).toHaveLength(2);
  });

  it('refuses the same operator as approver', async () => {
    book.put({
      approvalId: 'self',
      actionType: MAKER_TERMS_ACTION_TYPE,
      targetService: 'svc-trade',
      targetId: MAKER_TERMS_TARGET,
      expectedVersion: '0',
      payloadHash: payloadHash(termsApprovalBody('0', TERMS)),
      requesterId: OP,
      approverId: OP,
      operationId: 'op-self',
    });
    await expect(
      admin.setTerms(writer(), { terms: TERMS, expectedVersion: '0', approvalId: 'self', clientRequestId: 'op-self' }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('admits a member only into a tier the terms define', async () => {
    await expect(writeMember('m0')).rejects.toMatchObject({ code: MAKER_PROGRAMME_TERM_UNSET });
    await writeTerms('t1');
    await expect(writeMember('m-tier', { ...MEMBER, tier: 'TEST Platinum' })).rejects.toMatchObject({ code: MAKER_PROGRAMME_TIER_UNKNOWN });
    const m = await writeMember('m1');
    expect(m).toMatchObject({ accountId: MAKER, tier: 'TEST Gold', status: 'active', version: '1', termsVersion: '1' });
    expect((await admin.members(reader())).members).toEqual([m]);
    const suspended = await writeMember('m2', { ...MEMBER, status: 'suspended' }, '1');
    expect(suspended).toMatchObject({ status: 'suspended', version: '2' });
  });

  it('refuses a blank plan field by name, and a maker not in the programme', async () => {
    await expect(writePlan('p-blank', { ...PLAN, exitReviewDate: null })).rejects.toMatchObject({
      code: LAUNCH_PLAN_UNSET,
      message: expect.stringContaining('exit criteria'),
    });
    await expect(writePlan('p-band', { ...PLAN, inventoryMin: '3' })).rejects.toMatchObject({ code: 'trade.launch_plan_invalid' });
    await expect(writePlan('p-past', { ...PLAN, exitReviewDate: '2020-01-01' })).rejects.toMatchObject({
      code: 'trade.launch_plan_invalid',
      message: expect.stringContaining('review date'),
    });
    await expect(writePlan('p-unknown')).rejects.toMatchObject({
      code: LAUNCH_PLAN_MAKER_UNKNOWN,
      message: expect.stringContaining(MAKER),
    });
    await writeTerms('t1');
    await writeMember('m1');
    await expect(
      writePlan('p-stranger', { ...PLAN, makers: [...PLAN.makers, { accountId: STRANGER, capital: '1', asset: 'USDT' }] }),
    ).rejects.toMatchObject({ code: LAUNCH_PLAN_MAKER_UNKNOWN, message: expect.stringContaining(STRANGER) });
    // A suspended member is not an active maker either.
    await writeMember('m2', { ...MEMBER, status: 'suspended' }, '1');
    await expect(writePlan('p-suspended')).rejects.toMatchObject({ code: LAUNCH_PLAN_MAKER_UNKNOWN });
    const [n] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.launch_liquidity_plans`;
    expect(n!.n).toBe(0);
  });

  it('writes an approved plan version for one market and reads it beside the market that has none', async () => {
    await writeTerms('t1');
    await writeMember('m1');
    const plan = await writePlan('p1');
    expect(plan).toMatchObject({
      market,
      symbol: 'ETH/USDT',
      version: '1',
      state: 'approved',
      makers: PLAN.makers,
      inventoryMin: '-2.5',
      inventoryMax: '2.5',
      exitReviewDate: '2030-02-01',
      approverId: APPROVER,
    });
    const again = await admin.setPlan(writer(), { market, plan: PLAN, expectedVersion: '0', approvalId: 'p1', clientRequestId: 'op-p1' });
    expect(again).toEqual(plan);
    await expect(writePlan('p-stale')).rejects.toMatchObject({ code: 'trade.launch_plan_stale' });
    const { markets } = await admin.plans(reader());
    expect(markets.find((m) => m.symbol === 'ETH/USDT')?.plan).toEqual(plan);
    expect(markets.find((m) => m.symbol === 'SOL/USDT')?.plan).toBeNull();
    const v2 = await writePlan('p2', { ...PLAN, minUptimePct: '97' }, '1');
    expect((await admin.planHistory(reader(), market)).versions.map((v) => [v.version, v.minUptimePct])).toEqual([
      [v2.version, '97'],
      ['1', '95'],
    ]);
  });

  it('a reader without admin:write cannot write', async () => {
    await expect(
      admin.setTerms(reader(), { terms: TERMS, expectedVersion: '0', approvalId: 'x', clientRequestId: 'op-x' }),
    ).rejects.toBeTruthy();
  });
});
