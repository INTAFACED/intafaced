import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { tradeFeePort, tradeHistoryPort } from '../engine/ports.js';
import { createQuantRouter } from '../router.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { performanceClaims } from './claims.js';
import { createMemoryLibraryRepository } from './memory-repository.js';

// AL-library-01 and AL-library-02 (J-algo-dev-09): the publish checks, the realism checklist, stale listings, the
// library in registration order, invite-only access, clone with lineage, and reviews only after a run.
const SECRET = 'a-quant-library-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const NOW = T0 + 48 * HOUR;
const CLOSES = ['100', '100', '100', '110', '120', '130', '115', '100'];
const LICENCES = ['TEST open licence', 'TEST all rights reserved'];
const CHECKLIST = { version: 'TEST v1', items: ['TEST costs are included', 'TEST results are simulated'] };

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '1' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};

function signed(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: { 'x-intafaced-region': 'DE', [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE') },
    id: `req-${userId}`,
  });
}

const candles = () =>
  CLOSES.map((close, i) => {
    const open = i === 0 ? close : CLOSES[i - 1]!;
    return [T0 + i * HOUR, open, String(Math.max(+open, +close)), String(Math.min(+open, +close)), close, '1'];
  });
const fetch = async (url: string) => {
  const path = url.replace('http://trade.test', '').split('?')[0]!;
  const body =
    path === '/api/v1/ohlcv/BTC%2FUSDT' ? candles() : { version: 'local-test:v1', fees: { 'BTC/USDT': { makerBps: 8, takerBps: 10 } } };
  return { ok: true, status: 200, json: async () => body };
};

function setup(owner: { licences?: string[] | null; checklist?: typeof CHECKLIST | null } = {}) {
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits: { maxOps: 5_000, maxSource: 8_000 },
    strategies: createMemoryStrategyRepository(),
    runs: createMemoryRunRepository(RUN_RESULT_MAX_BYTES),
    history: tradeHistoryPort({ tradeUrl: 'http://trade.test', now: () => NOW, fetch }),
    fees: tradeFeePort({ tradeUrl: 'http://trade.test', fetch }),
    now: () => NOW,
    library: {
      repository: createMemoryLibraryRepository(),
      licences: owner.licences === undefined ? LICENCES : owner.licences,
      checklist: owner.checklist === undefined ? CHECKLIST : owner.checklist,
    },
  });
  return { owner: app.createCaller(signed(OWNER)), reader: app.createCaller(signed(READER)) };
}
type Caller = ReturnType<typeof setup>['owner'];

const body = (name: string) => ({
  name,
  blocks: [],
  modules: RULES,
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  cash: '1000',
  environment: 'paper',
});
async function strategy(who: Caller, name: string) {
  return who.studio.save({ ...body(name), clientStrategyId: `client:${name}`, idempotencyKey: `studio.save:${name}` });
}
async function backtest(who: Caller, strategyId: string, strategyVersion = 1) {
  return who.backtest.start({
    strategyId,
    strategyVersion,
    cash: '1000',
    from: new Date(T0).toISOString(),
    to: new Date(T0 + CLOSES.length * HOUR).toISOString(),
    fillTiming: 'next_open',
    costs: { feeRole: 'taker', slippageBps: '0', delayBars: '0' },
  });
}
const details = (strategyId: string, overrides: Record<string, unknown> = {}) => ({
  strategyId,
  strategyVersion: 1,
  title: 'TEST cross',
  description: 'Buys when the fast average crosses above the slow one. Every figure is simulated.',
  tags: ['trend' as const],
  visibility: 'open' as const,
  licence: LICENCES[0]!,
  ...overrides,
});
const publish = (who: Caller, strategyId: string, overrides: Record<string, unknown> = {}) =>
  who.library.publish({ ...details(strategyId, overrides), checklistVersion: CHECKLIST.version, checklistAccepted: true });

describe('performance claims', () => {
  it('names each sentence that claims a return, and passes plain descriptions', () => {
    expect(performanceClaims('A trend follower. It returns 40% a year. Costs are included.')).toEqual(['It returns 40% a year.']);
    expect(performanceClaims('Guaranteed profit on every trade')).toEqual(['Guaranteed profit on every trade']);
    expect(performanceClaims('Annual return of 12.5 percent.')).toHaveLength(1);
    expect(performanceClaims('Uses a 20 bar average and a 2 percent stop.')).toEqual([]);
  });
});

describe('publish (AL-library-01)', () => {
  it('fails the claim check naming the sentence, and lists nothing', async () => {
    const t = setup();
    const s = await strategy(t.owner, 'claim');
    await backtest(t.owner, s.id);
    const claim = 'It returns 40% a year.';
    const reading = await t.owner.library.check(details(s.id, { description: `A trend follower. ${claim}` }));
    expect(reading.passed).toBe(false);
    expect(reading.checks.find((row) => row.id === 'claim')).toEqual({
      id: 'claim',
      passed: false,
      detail: `performance claim: "${claim}"`,
    });
    await expect(publish(t.owner, s.id, { description: `A trend follower. ${claim}` })).rejects.toThrow(
      `quant.listing_check_failed — claim — performance claim: "${claim}"; nothing was listed`,
    );
    expect((await t.owner.library.mine()).listings).toEqual([]);
  });

  it('passes every check with a backtest of this version and costs; needs the checklist; refuses an unset licence list', async () => {
    const t = setup();
    const s = await strategy(t.owner, 'clean');
    const before = await t.owner.library.check(details(s.id));
    expect(before.checks.filter((row) => !row.passed).map((row) => row.id)).toEqual(['backtest', 'costs']);
    await backtest(t.owner, s.id);
    const reading = await t.owner.library.check(details(s.id));
    expect(reading.passed).toBe(true);
    expect(reading.checks.map((row) => row.id)).toEqual(['version', 'backtest', 'costs', 'claim', 'licence']);
    expect(JSON.stringify(reading)).not.toContain('function');
    await expect(
      t.owner.library.publish({ ...details(s.id), checklistVersion: CHECKLIST.version, checklistAccepted: false }),
    ).rejects.toThrow(/quant\.realism_checklist_unaccepted — /);
    await expect(t.owner.library.publish({ ...details(s.id), checklistVersion: 'old', checklistAccepted: true })).rejects.toThrow(
      /quant\.realism_checklist_unaccepted/,
    );
    const listed = await publish(t.owner, s.id);
    expect(listed).toMatchObject({ strategyVersion: 1, stale: false, visibility: 'open', checklistVersion: CHECKLIST.version });
    expect((await publish(t.owner, s.id)).listingId).toBe(listed.listingId);

    const blank = setup({ licences: null });
    const b = await strategy(blank.owner, 'blank');
    await expect(blank.owner.library.check(details(b.id))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(blank.owner.library.check(details(b.id))).rejects.toThrow(/quant\.library_licences_unset — /);
    expect((await blank.owner.library.options()).licences).toBeNull();
    const none = setup({ checklist: null });
    const n = await strategy(none.owner, 'none');
    await backtest(none.owner, n.id);
    await expect(publish(none.owner, n.id)).rejects.toThrow(/quant\.realism_checklist_unset/);
  });

  it('makes the old listing stale on a new version, and refuses re-listing it without a new check', async () => {
    const t = setup();
    const s = await strategy(t.owner, 'stale');
    await backtest(t.owner, s.id);
    const listed = await publish(t.owner, s.id);
    await t.owner.studio.update({ ...body('stale v2'), id: s.id, idempotencyKey: 'studio.update:stale:2' });
    const [mine] = (await t.owner.library.mine()).listings;
    expect(mine).toMatchObject({ listingId: listed.listingId, stale: true, strategyVersion: 1, headVersion: 2 });
    await expect(publish(t.owner, s.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(publish(t.owner, s.id)).rejects.toThrow(/quant\.listing_stale — version 1 is not the newest \(version 2\)/);
    await expect(publish(t.owner, s.id, { strategyVersion: 2 })).rejects.toThrow(/quant\.listing_check_failed — backtest — /);
    expect((await t.reader.library.browse({ limit: 10 })).entries).toEqual([]);
  });
});

describe('library (AL-library-02)', () => {
  it('lists open listings in registration order, filters by tag, and never by return', async () => {
    const t = setup();
    const ids: string[] = [];
    for (const [name, tag] of [
      ['a', 'trend'],
      ['b', 'momentum'],
      ['c', 'trend'],
    ] as const) {
      const s = await strategy(t.owner, name);
      await backtest(t.owner, s.id);
      ids.push((await publish(t.owner, s.id, { title: `TEST ${name}`, tags: [tag] })).listingId);
    }
    const invite = await strategy(t.owner, 'hidden');
    await backtest(t.owner, invite.id);
    await publish(t.owner, invite.id, { visibility: 'invite' });
    expect((await t.reader.library.browse({ limit: 10 })).entries.map((row) => row.listingId)).toEqual(ids);
    expect((await t.reader.library.browse({ limit: 10, tag: 'trend' })).entries.map((row) => row.listingId)).toEqual([ids[0], ids[2]]);
    const first = await t.reader.library.browse({ limit: 2 });
    expect(first.entries.map((row) => row.listingId)).toEqual(ids.slice(0, 2));
    expect((await t.reader.library.browse({ limit: 2, cursor: first.nextCursor })).entries.map((row) => row.listingId)).toEqual([ids[2]]);
    expect(JSON.stringify(first)).not.toMatch(/net|pnl|return/i);
  });

  it('shows an invite-only listing as its title until the owner grants, and refuses the next read after revoke', async () => {
    const t = setup();
    const s = await strategy(t.owner, 'invite');
    await backtest(t.owner, s.id);
    const { listingId } = await publish(t.owner, s.id, { visibility: 'invite' });
    expect(await t.reader.library.preview({ listingId })).toMatchObject({ title: 'TEST cross', access: 'none', rows: 0 });
    await expect(t.reader.library.get({ listingId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(t.reader.library.get({ listingId })).rejects.toThrow(/quant\.listing_access_denied — /);
    expect((await t.reader.library.request({ listingId, seq: 0 })).access).toBe('requested');
    expect((await t.reader.library.request({ listingId, seq: 0 })).rows).toBe(1);
    await expect(t.reader.library.grant({ listingId, userId: OWNER, seq: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const granted = await t.owner.library.grant({ listingId, userId: READER, seq: 1 });
    expect(granted.access).toEqual([expect.objectContaining({ userId: READER, state: 'granted', rows: 2 })]);
    expect((await t.reader.library.get({ listingId })).source).toBeTruthy();
    await t.owner.library.revoke({ listingId, userId: READER, seq: 2 });
    await expect(t.reader.library.get({ listingId })).rejects.toThrow(/quant\.listing_access_denied/);
    await expect(t.reader.library.clone({ listingId })).rejects.toThrow(/quant\.listing_access_denied/);
  });

  it('clones an open listing as a new strategy with lineage, once; never returns or copies a protected source', async () => {
    const t = setup();
    const s = await strategy(t.owner, 'open');
    await backtest(t.owner, s.id);
    const { listingId } = await publish(t.owner, s.id);
    const lineage = await t.reader.library.clone({ listingId });
    expect(lineage).toMatchObject({ listingId, listingTitle: 'TEST cross', sourceVersion: 1 });
    expect((await t.reader.library.clone({ listingId })).strategyId).toBe(lineage.strategyId);
    const copy = await t.reader.studio.get({ id: lineage.strategyId });
    expect(copy.versions).toHaveLength(1);
    expect(copy.modules).toEqual(RULES);
    expect((await t.reader.library.lineage({ strategyId: lineage.strategyId })).lineage).toMatchObject({ listingId });
    expect((await t.owner.library.lineage({ strategyId: s.id })).lineage).toBeNull();
    expect((await t.reader.studio.list({ limit: 10 })).strategies).toHaveLength(1);

    const p = await strategy(t.owner, 'protected');
    await backtest(t.owner, p.id);
    const prot = await publish(t.owner, p.id, { visibility: 'protected' });
    const page = await t.reader.library.get({ listingId: prot.listingId });
    expect(page.source).toBeNull();
    expect(page.result).toMatchObject({ label: 'Historical simulation — not a forecast' });
    await expect(t.reader.library.clone({ listingId: prot.listingId })).rejects.toThrow(/quant\.listing_source_protected — /);
    expect((await t.reader.studio.list({ limit: 10 })).strategies).toHaveLength(1);
  });

  it('refuses a review before the reader ran their clone, then accepts it once', async () => {
    const t = setup();
    const s = await strategy(t.owner, 'review');
    await backtest(t.owner, s.id);
    const { listingId } = await publish(t.owner, s.id);
    await expect(t.reader.library.review({ listingId, text: 'TEST clear rules.' })).rejects.toThrow(/quant\.review_needs_run — /);
    const { strategyId } = await t.reader.library.clone({ listingId });
    await expect(t.reader.library.review({ listingId, text: 'TEST clear rules.' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await backtest(t.reader, strategyId);
    await expect(t.reader.library.review({ listingId, text: 'It made 30% a month.' })).rejects.toThrow(
      /quant\.listing_check_failed — claim/,
    );
    const page = await t.reader.library.review({ listingId, text: 'TEST clear rules.' });
    expect(page.reviews).toEqual([expect.objectContaining({ reviewerId: READER, text: 'TEST clear rules.' })]);
    expect((await t.reader.library.review({ listingId, text: 'TEST again.' })).reviews).toHaveLength(1);
  });
});
