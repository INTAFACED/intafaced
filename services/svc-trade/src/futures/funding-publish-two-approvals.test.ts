/** RC-derivatives-01: funding-rate publish needs two distinct operator approvals. TEST figures only. */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryApprovalBook, payloadHash } from '../admin/common.js';
import type { FundingHistoryRow } from './funding-history.js';
import type { FundingRateEntry } from './funding-rate-source.js';
import {
  FUNDING_PUBLISH_APPROVERS_NOT_DISTINCT,
  FUNDING_PUBLISH_TWO_APPROVALS_REQUIRED,
  registerInternalFundingRate,
} from './internal-funding-rate.js';

const SECRET = 'test-internal-secret-rc-derivatives-01';
const PATH = '/internal/futures/funding-rate';
const BODY = { marketId: 'm1', rate: '0.0001', periodId: 'm1:p1' };

function bind(book: MemoryApprovalBook, approvalId: string, requesterId: string, approverId: string, rate = BODY.rate) {
  book.put({
    approvalId,
    actionType: 'trade.funding_rate.publish',
    targetService: 'svc-trade',
    targetId: BODY.marketId,
    expectedVersion: BODY.periodId,
    payloadHash: payloadHash({
      actionType: 'trade.funding_rate.publish',
      marketId: BODY.marketId,
      periodId: BODY.periodId,
      rate,
      markPrice: null,
    }),
    requesterId,
    approverId,
  });
}

async function setup(maxAbsRate: string | null = '1') {
  const published: FundingRateEntry[] = [];
  const history: FundingHistoryRow[] = [];
  const book = new MemoryApprovalBook();
  const app = Fastify();
  registerInternalFundingRate(app, {
    internalSecret: SECRET,
    publishFundingRate: (e) => published.push(e),
    recordFundingHistory: (r) => history.push(r),
    maxAbsRate,
    now: () => 1_700_000_000_000,
    approvals: book,
  });
  await app.ready();
  const post = (body: unknown) => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-oracle', SECRET, raw) },
      payload: raw,
    });
  };
  return { app, book, post, published, history };
}

describe('funding publish needs two distinct approvals (RC-derivatives-01)', () => {
  it('two approvals by B and C for a rate requested by A → stored once with both approver ids; replay is a duplicate', async () => {
    const t = await setup();
    bind(t.book, 'apr-b', 'operator-a', 'operator-b');
    bind(t.book, 'apr-c', 'operator-a', 'operator-c');
    const res = await t.post({ ...BODY, approvalIds: ['apr-b', 'apr-c'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().approverIds).toEqual(['operator-b', 'operator-c']);
    expect(t.published).toHaveLength(1);
    expect(t.history).toEqual([expect.objectContaining({ fundingRate: '0.0001', approverIds: ['operator-b', 'operator-c'] })]);
    const replay = await t.post({ ...BODY, approvalIds: ['apr-b', 'apr-c'] });
    expect(replay.json().duplicate).toBe(true);
    expect(t.published).toHaveLength(1);
    await t.app.close();
  });

  it('one approval (or the old single approvalId form) → two_approvals_required, nothing consumed or stored', async () => {
    const t = await setup();
    bind(t.book, 'apr-b', 'operator-a', 'operator-b');
    for (const body of [
      { ...BODY, approvalIds: ['apr-b'] },
      { ...BODY, approvalId: 'apr-b' },
      { ...BODY, approvalIds: ['apr-b', ''] },
      { ...BODY, approvalIds: ['apr-b', 'x', 'y'] },
      { ...BODY, approvalIds: 'apr-b' },
      BODY,
    ]) {
      const res = await t.post(body);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe(FUNDING_PUBLISH_TWO_APPROVALS_REQUIRED);
    }
    expect(t.published).toEqual([]);
    // apr-b was never consumed: it still works in a valid pair.
    bind(t.book, 'apr-c', 'operator-a', 'operator-c');
    expect((await t.post({ ...BODY, approvalIds: ['apr-b', 'apr-c'] })).statusCode).toBe(200);
    await t.app.close();
  });

  it('the same id twice → approvers_not_distinct, nothing consumed', async () => {
    const t = await setup();
    bind(t.book, 'apr-b', 'operator-a', 'operator-b');
    const res = await t.post({ ...BODY, approvalIds: ['apr-b', 'apr-b'] });
    expect(res.json().error).toBe(FUNDING_PUBLISH_APPROVERS_NOT_DISTINCT);
    expect(t.published).toEqual([]);
    await t.app.close();
  });

  it('two ids, one approver → approvers_not_distinct; rate not stored', async () => {
    const t = await setup();
    bind(t.book, 'apr-1', 'operator-a', 'operator-b');
    bind(t.book, 'apr-2', 'operator-a', 'Operator-B');
    const res = await t.post({ ...BODY, approvalIds: ['apr-1', 'apr-2'] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(FUNDING_PUBLISH_APPROVERS_NOT_DISTINCT);
    expect(t.published).toEqual([]);
    expect(t.history).toEqual([]);
    await t.app.close();
  });

  it('an operator who requested one approval and approved the other → approvers_not_distinct', async () => {
    const t = await setup();
    bind(t.book, 'apr-1', 'operator-a', 'operator-b');
    bind(t.book, 'apr-2', 'operator-c', 'operator-a');
    const res = await t.post({ ...BODY, approvalIds: ['apr-1', 'apr-2'] });
    expect(res.json().error).toBe(FUNDING_PUBLISH_APPROVERS_NOT_DISTINCT);
    expect(t.published).toEqual([]);
    await t.app.close();
  });

  it('first approval already used → approval_reused; rate not stored', async () => {
    const t = await setup();
    bind(t.book, 'apr-b', 'operator-a', 'operator-b');
    bind(t.book, 'apr-c', 'operator-a', 'operator-c');
    expect((await t.post({ ...BODY, approvalIds: ['apr-b', 'apr-c'] })).statusCode).toBe(200);
    bind(t.book, 'apr-d', 'operator-a', 'operator-d', '0.0003');
    const res = await t.post({ ...BODY, rate: '0.0003', approvalIds: ['apr-b', 'apr-d'] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('approval_reused');
    expect(t.published).toHaveLength(1);
    await t.app.close();
  });

  it('second consume fails after the first succeeded → first stays consumed (single use), nothing stored', async () => {
    const t = await setup();
    bind(t.book, 'apr-b', 'operator-a', 'operator-b');
    bind(t.book, 'apr-c', 'operator-a', 'operator-c');
    bind(t.book, 'apr-d', 'operator-a', 'operator-d');
    expect((await t.post({ ...BODY, approvalIds: ['apr-c', 'apr-d'] })).statusCode).toBe(200);
    const t2 = await setup();
    bind(t2.book, 'apr-b', 'operator-a', 'operator-b');
    bind(t2.book, 'apr-c', 'operator-a', 'operator-c', '0.0002');
    const res = await t2.post({ ...BODY, approvalIds: ['apr-b', 'apr-c'] });
    expect(res.json().error).toBe('approval_mismatch');
    expect(t2.published).toEqual([]);
    bind(t2.book, 'apr-e', 'operator-a', 'operator-e');
    const again = await t2.post({ ...BODY, approvalIds: ['apr-b', 'apr-e'] });
    expect(again.json().error).toBe('approval_reused');
    expect(t2.published).toEqual([]);
    await t.app.close();
    await t2.app.close();
  });

  it('a refused rate burns no approval: bound unset and above-max refuse before any consume', async () => {
    const unset = await setup(null);
    bind(unset.book, 'apr-b', 'operator-a', 'operator-b');
    bind(unset.book, 'apr-c', 'operator-a', 'operator-c');
    expect((await unset.post({ ...BODY, approvalIds: ['apr-b', 'apr-c'] })).json().error).toBe('trade.funding_rate_bound_unconfigured');
    const consumed = await unset.book.consume({
      approvalId: 'apr-b',
      actionType: 'trade.funding_rate.publish',
      targetId: BODY.marketId,
      expectedVersion: BODY.periodId,
      payloadHash: payloadHash({ actionType: 'trade.funding_rate.publish', ...BODY, markPrice: null }),
      operationId: 'probe',
    });
    expect(consumed.ok).toBe(true);
    expect(unset.published).toEqual([]);
    await unset.app.close();
  });

  it('a missing approval book refuses', async () => {
    const app = Fastify();
    const published: FundingRateEntry[] = [];
    registerInternalFundingRate(app, {
      internalSecret: SECRET,
      publishFundingRate: (e) => published.push(e),
      maxAbsRate: '1',
      approvals: null,
    });
    await app.ready();
    const raw = JSON.stringify({ ...BODY, approvalIds: ['a', 'b'] });
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-oracle', SECRET, raw) },
      payload: raw,
    });
    expect(res.json().error).toBe(FUNDING_PUBLISH_TWO_APPROVALS_REQUIRED);
    expect(published).toEqual([]);
    await app.close();
  });
});
