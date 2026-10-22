import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryApprovalBook, payloadHash } from '../admin/common.js';
import { registerInternalFundingRate } from './internal-funding-rate.js';
import { periodIdFor, type FundingRateEntry } from './funding-rate-source.js';

const SECRET = 'test-internal-secret-for-trade-funding-rate';
const PATH = '/internal/futures/funding-rate';

/** Test-only magnitude bound — NOT product law (D2). Allows 0.0001; refuses 1000000. */
const FIXTURE_FUNDING_MAX_ABS = '1';

function signed(payload: unknown): { headers: Record<string, string>; payload: string } {
  const raw = JSON.stringify(payload);
  return {
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-oracle', SECRET, raw) },
    payload: raw,
  };
}

function periodOf(payload: Record<string, unknown>): string {
  const marketId = String(payload.marketId);
  const named = typeof payload.periodId === 'string' ? payload.periodId.trim() : '';
  if (named) return named;
  const start = String(payload.periodStartIso);
  return periodIdFor(marketId, new Date(Date.parse(start)).toISOString());
}

function markOf(payload: Record<string, unknown>): string | null {
  const raw = typeof payload.markPrice === 'string' ? payload.markPrice.trim() : '';
  return raw.length > 0 ? raw : null;
}

let approvalSeq = 0;

/** Two bound four-eyes rows (two approvers), then one post that spends both. Replays of the same period send no new approval. */
async function withBoundApproval(app: FastifyInstance, approvals: MemoryApprovalBook, payload: Record<string, unknown>) {
  const marketId = String(payload.marketId);
  const rate = String(payload.rate);
  const periodId = periodOf(payload);
  const markPrice = markOf(payload);
  const approvalIds = [`apr-funding-${++approvalSeq}`, `apr-funding-${++approvalSeq}`];
  for (const [i, approvalId] of approvalIds.entries()) {
    approvals.put({
      approvalId,
      actionType: 'trade.funding_rate.publish',
      targetService: 'svc-trade',
      targetId: marketId,
      expectedVersion: periodId,
      payloadHash: payloadHash({
        actionType: 'trade.funding_rate.publish',
        marketId,
        periodId,
        rate,
        markPrice,
      }),
      requesterId: 'requester-1',
      approverId: `approver-${i + 2}`,
      operationId: `op-${approvalId}`,
    });
  }
  const second = await app.inject({
    method: 'POST',
    url: PATH,
    ...signed({ ...payload, approvalIds, operationIds: approvalIds.map((id) => `op-${id}`) }),
  });
  return { second };
}

async function build(publish: (e: FundingRateEntry) => void, maxAbsRate: string | null = FIXTURE_FUNDING_MAX_ABS) {
  const app = Fastify();
  const approvals = new MemoryApprovalBook();
  registerInternalFundingRate(app, {
    internalSecret: SECRET,
    publishFundingRate: publish,
    maxAbsRate,
    now: () => 1_700_000_000_000,
    approvals,
  });

  await app.ready();
  return { app, approvals };
}

describe('POST /internal/futures/funding-rate', () => {
  it('401 without service auth', async () => {
    const { app } = await build(vi.fn());
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      payload: { marketId: 'm1', rate: '0.0001' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('requires body-bound HMAC — v1 header-only and tampered payload are 401', async () => {
    const published: FundingRateEntry[] = [];
    const { app } = await build((e) => published.push(e));
    const body = JSON.stringify({ marketId: 'm1', rate: '0.0001', periodId: 'm1:p0' });
    const v1 = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeaders('svc-oracle', SECRET) },
      payload: body,
    });
    expect(v1.statusCode).toBe(401);
    const signed = JSON.stringify({ marketId: 'm1', rate: '0.0001', periodId: 'm1:p0' });
    const tampered = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-oracle', SECRET, signed) },
      payload: JSON.stringify({ marketId: 'm1', rate: '0.9999', periodId: 'm1:p0' }),
    });
    expect(tampered.statusCode).toBe(401);
    expect(published).toEqual([]);
    await app.close();
  });

  it('canonicalises and preserves a publisher-supplied period end', async () => {
    const published: FundingRateEntry[] = [];
    const { app, approvals } = await build((entry) => published.push(entry));
    const { second: res } = await withBoundApproval(app, approvals, {
      marketId: 'm1',
      rate: '0.0001',
      periodId: 'm1:p0',
      periodEndIso: '2026-08-23T19:00:00+02:00',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().periodEndIso).toBe('2026-08-23T17:00:00.000Z');
    expect(published[0]?.periodEndIso).toBe('2026-08-23T17:00:00.000Z');
    await app.close();
  });

  it('400 when marketId or rate missing (never invent)', async () => {
    const { app } = await build(vi.fn());
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      ...signed({ marketId: 'm1' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.funding_rate_publish_invalid');
    await app.close();
  });

  /**
   * The publisher must name its period; the clock may not name it for them.
   *
   * `periodId` was derived from `asOfMs` via `toISOString()` — millisecond
   * resolution — so an oracle republishing the same rate every 60s minted a
   * fresh unsettled period each time. `runFundingTick` skips an already-settled
   * period BY ID, so every republish defeated that check and charged every
   * trader a full period again. Ordinary polling, no crash needed.
   */
  it('400 when the publisher names no period — the clock must not name it', async () => {
    const published: FundingRateEntry[] = [];
    const { app } = await build((e) => published.push(e));
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      ...signed({ marketId: 'm1', rate: '0.0001' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.funding_rate_publish_invalid');
    expect(res.json().message).toMatch(/periodId or periodStartIso/);
    // Nothing reached the rate book — a nameless period is not publishable.
    expect(published).toEqual([]);
    await app.close();
  });

  it('the same instant in three ISO spellings is ONE period', async () => {
    const published: FundingRateEntry[] = [];
    const { app, approvals } = await build((e) => published.push(e));
    const base = { marketId: 'm1', rate: '0.0001' };

    // Same moment, three encodings. Concatenated raw these were three distinct
    // ids and three full charges — an oracle changing its date library, or a
    // second publisher with a different one, double-charged with nobody
    // changing a period.
    const spellings = ['2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00Z', '2026-08-08T02:00:00+02:00'];
    const first = await withBoundApproval(app, approvals, { ...base, periodStartIso: spellings[0] });
    expect(first.second.statusCode).toBe(200);
    for (const iso of spellings.slice(1)) {
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        ...signed({ ...base, periodStartIso: iso, operatorId: 'operator-c' }),
      });
      expect(res.statusCode).toBe(200);
    }

    expect(published).toHaveLength(1);
    expect(new Set(published.map((p) => p.periodId)).size).toBe(1);
    expect(published[0]!.periodId).toBe('m1:2026-08-08T00:00:00.000Z');
    await app.close();
  });

  it('a periodId belonging to another market is refused', async () => {
    const published: FundingRateEntry[] = [];
    const { app } = await build((e) => published.push(e));

    // `funding_periods` is keyed on period_id ALONE, so one id copy-pasted
    // across two markets makes the second read as already settled and its
    // traders never exchange collateral — silently.
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      ...signed({ marketId: 'm2', rate: '0.0001', periodId: 'm1:2026-08-08T00:00:00.000Z' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/scoped to its market/);
    expect(published).toEqual([]);
    await app.close();
  });

  it('an unparseable periodStartIso is refused, not concatenated', async () => {
    const published: FundingRateEntry[] = [];
    const { app } = await build((e) => published.push(e));
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      ...signed({ marketId: 'm1', rate: '0.0001', periodStartIso: 'last tuesday' }),
    });
    expect(res.statusCode).toBe(400);
    expect(published).toEqual([]);
    await app.close();
  });

  /**
   * A future `asOfMs` stops funding for the market, permanently and silently.
   *
   * `isRateFresh` requires `now >= asOf`, so one publish stamped past the
   * horizon makes `quote()` return null forever — the tick only writes skip
   * rows. The same value also makes `new Date(asOfMs).toISOString()` throw in
   * the public funding-rate route, which does not catch it, so that symbol
   * 500s permanently too.
   */
  it('an asOfMs in the future is refused', async () => {
    const published: FundingRateEntry[] = [];
    const { app, approvals } = await build((e) => published.push(e));
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      ...signed({ marketId: 'm1', rate: '0.0001', periodId: 'm1:p0', asOfMs: 1e16 }),
    });
    expect(res.statusCode).toBe(400);
    expect(published).toEqual([]);

    // A minute of clock skew is still accepted — publishers are not atomic.
    const ok = await withBoundApproval(app, approvals, {
      marketId: 'm1',
      rate: '0.0001',
      periodId: 'm1:p0',
      asOfMs: 1_700_000_000_000 + 30_000,
    });
    expect(ok.second.statusCode).toBe(200);
    await app.close();
  });

  it('publishes rate when service-auth + body valid', async () => {
    const published: FundingRateEntry[] = [];
    const { app, approvals } = await build((e) => published.push(e));
    const { second: res } = await withBoundApproval(app, approvals, { marketId: 'm1', rate: '0.0001', periodId: 'm1:t0' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, marketId: 'm1', rate: '0.0001', periodId: 'm1:t0' });
    expect(published).toHaveLength(1);
    expect(published[0]!.rate).toBe('0.0001');
    await app.close();
  });

  /**
   * C12 / BUILD-STOP D2: absurd rate never enters the rate book.
   * Fixture max is test-only — not the product ceiling Denon still owns.
   */
  it('refuses rate 1000000 with trade.funding_rate_exceeds_max — nothing published', async () => {
    const published: FundingRateEntry[] = [];
    const { app } = await build((e) => published.push(e));
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      ...signed({ marketId: 'm1', rate: '1000000', periodId: 'm1:p-absurd' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.funding_rate_exceeds_max');
    expect(published).toEqual([]);
    await app.close();
  });

  it('refuses publish when max abs rate is unset (fail-closed)', async () => {
    const published: FundingRateEntry[] = [];
    const { app } = await build((e) => published.push(e), null);
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      ...signed({ marketId: 'm1', rate: '0.0001', periodId: 'm1:p0' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.funding_rate_bound_unconfigured');
    expect(published).toEqual([]);
    await app.close();
  });
});
