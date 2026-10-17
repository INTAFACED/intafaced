import { describe, expect, it } from 'vitest';
import { evaluateFraud } from './evaluate.js';
import { assertFraudReviewListLimit, FraudReviewError, MemoryFraudReviewQueue } from './review-queue.js';

describe('D26-P1-P5 fraud review queue', () => {
  it('enqueues only review outcomes with reasons', () => {
    const q = new MemoryFraudReviewQueue();
    const decision = evaluateFraud({
      merchantId: 'm1',
      amount: '100',
      assetId: 'USDT',
      recentPaymentCount: 12,
      thresholds: { maxPaymentsInWindow: 5 },
    });
    expect(decision.outcome).toBe('review');

    const c = q.enqueue({
      id: 'rev-1',
      merchantId: 'm1',
      amount: '100',
      assetId: 'USDT',
      decision,
    });
    expect(c.status).toBe('open');
    expect(c.decision.reasons.length).toBeGreaterThan(0);
    expect(q.listOpen('m1', 50)).toHaveLength(1);
  });

  it('listOpen refuses unset limit — never invent 50', () => {
    const q = new MemoryFraudReviewQueue();
    expect(() => q.listOpen('m1')).toThrow(FraudReviewError);
    expect(() => assertFraudReviewListLimit(undefined)).toThrow(FraudReviewError);
    try {
      assertFraudReviewListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect((e as FraudReviewError).code).toBe('pay.fraud_review_list_limit_unset');
      expect((e as FraudReviewError).message).not.toMatch(/default 50|50-row/i);
    }
    expect(assertFraudReviewListLimit(50)).toBe(50);
    expect(assertFraudReviewListLimit(201)).toBe(200);
  });

  it('refuses allow/decline enqueue (no silent queue pollution)', () => {
    const q = new MemoryFraudReviewQueue();
    const allow = evaluateFraud({
      merchantId: 'm1',
      amount: '1',
      assetId: 'USDT',
      enabled: { velocity_count: false, velocity_volume: false, amount_anomaly: false },
    });
    expect(allow.outcome).toBe('allow');
    expect(() => q.enqueue({ id: 'x', merchantId: 'm1', amount: '1', assetId: 'USDT', decision: allow })).toThrowError(FraudReviewError);
  });

  it('resolve requires actor and is idempotent-closed after first decision', () => {
    const q = new MemoryFraudReviewQueue();
    const decision = evaluateFraud({
      merchantId: 'm1',
      amount: '100',
      assetId: 'USDT',
      recentPaymentCount: 9,
      thresholds: { maxPaymentsInWindow: 2 },
    });
    q.enqueue({ id: 'rev-2', merchantId: 'm1', amount: '100', assetId: 'USDT', decision });
    const closed = q.resolve({ id: 'rev-2', outcome: 'allow', actorId: 'ops-1', note: 'vip' });
    expect(closed.status).toBe('allowed');
    expect(closed.resolvedBy).toBe('ops-1');
    expect(() => q.resolve({ id: 'rev-2', outcome: 'decline', actorId: 'ops-2' })).toThrowError(/already allowed/);
  });

  it('deciding the same outcome twice keeps the first decision', () => {
    const q = new MemoryFraudReviewQueue();
    const decision = evaluateFraud({
      merchantId: 'm1',
      amount: '100',
      assetId: 'USDT',
      recentPaymentCount: 9,
      thresholds: { maxPaymentsInWindow: 2 },
    });
    q.enqueue({ id: 'rev-same', merchantId: 'm1', amount: '100', assetId: 'USDT', decision });
    const first = q.resolve({ id: 'rev-same', outcome: 'allow', actorId: 'ops-1', note: 'vip' });
    const second = q.resolve({ id: 'rev-same', outcome: 'allow', actorId: 'ops-2' });
    expect(second).toBe(first);
    expect(second.resolvedBy).toBe('ops-1');
    expect(q.listOpen('m1', 50)).toHaveLength(0);
  });

  it('refuses another merchant the same id and returns nothing of the case', () => {
    const q = new MemoryFraudReviewQueue();
    const decision = evaluateFraud({
      merchantId: 'm1',
      amount: '100',
      assetId: 'USDT',
      recentPaymentCount: 9,
      thresholds: { maxPaymentsInWindow: 2 },
    });
    const owned = q.enqueue({ id: 'rev-foreign', merchantId: 'm1', amount: '100', assetId: 'USDT', decision });
    let refused: unknown;
    try {
      q.enqueue({ id: 'rev-foreign', merchantId: 'm2', amount: '1', assetId: 'USDT', decision });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(FraudReviewError);
    expect((refused as FraudReviewError).code).toBe('pay.fraud_review_not_found');
    expect((refused as FraudReviewError).message).not.toContain('m1');
    expect((refused as FraudReviewError).message).not.toContain('100');
    expect(q.get('rev-foreign')).toEqual(owned);
  });

  it('refuses an id reserved for system holds and stores nothing', () => {
    const q = new MemoryFraudReviewQueue();
    const decision = evaluateFraud({
      merchantId: 'm1',
      amount: '100',
      assetId: 'USDT',
      recentPaymentCount: 9,
      thresholds: { maxPaymentsInWindow: 2 },
    });
    expect(decision.outcome).toBe('review');
    let refused: unknown;
    try {
      q.enqueue({ id: 'held:x', merchantId: 'm1', amount: '100', assetId: 'USDT', decision });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(FraudReviewError);
    expect((refused as FraudReviewError).code).toBe('pay.fraud_review_not_review');
    expect((refused as FraudReviewError).message).toContain('reserved for system holds');
    expect(q.get('held:x')).toBeNull();
  });

  it('claim is idempotent for the same operator and refuses a second operator', () => {
    const q = new MemoryFraudReviewQueue();
    const decision = evaluateFraud({
      merchantId: 'm1',
      amount: '100',
      assetId: 'USDT',
      recentPaymentCount: 9,
      thresholds: { maxPaymentsInWindow: 2 },
    });
    q.enqueue({ id: 'rev-claim', merchantId: 'm1', amount: '100', assetId: 'USDT', decision });
    const claimed = q.claim({ id: 'rev-claim', actorId: 'ops-1' });
    expect(claimed.status).toBe('claimed');
    expect(q.claim({ id: 'rev-claim', actorId: 'ops-1' })).toBe(claimed);
    expect(() => q.claim({ id: 'rev-claim', actorId: 'ops-2' })).toThrowError(FraudReviewError);
    expect(q.listOpen('m1', 50)).toHaveLength(1);
  });
});
