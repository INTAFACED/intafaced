import { describe, expect, it } from 'vitest';
import { dependencyReading, MINING_STEPS, miningHealth, poolVerdict, type MiningHealth } from './mining-journey';

const health = (over: Partial<MiningHealth> = {}): MiningHealth => ({
  ok: true,
  service: 'svc-mining-pool',
  ledger: { status: 'configured', code: 'mining.ledger_unprobed' },
  pg: { status: 'configured', code: 'mining.pg_unprobed' },
  jobs: ['mining.epoch_payout'],
  ...over,
});

describe('mining pool reading', () => {
  it('parses the public health shape and refuses anything else', () => {
    expect(miningHealth.safeParse(health()).success).toBe(true);
    expect(miningHealth.safeParse({ ...health(), service: 'other' }).success).toBe(false);
    expect(miningHealth.safeParse({ ...health(), ok: false }).success).toBe(false);
  });
  it('never calls a pool live: the strongest verdict is configured', () => {
    expect(poolVerdict(null)).toBe('unreachable');
    expect(poolVerdict(health({ ledger: { status: 'absent', code: 'mining.ledger_unavailable' } }))).toBe('incomplete');
    expect(poolVerdict(health({ pg: { status: 'absent', code: 'mining.pg_unavailable' } }))).toBe('incomplete');
    expect(poolVerdict(health({ jobs: [] }))).toBe('configured_no_jobs');
    expect(poolVerdict(health())).toBe('configured');
  });
  it('lets a customer read three steps and refuses the fourth', () => {
    expect(MINING_STEPS.map((step) => step.id)).toEqual(['worker', 'shares', 'window', 'payout']);
    expect(MINING_STEPS.map((step) => step.access)).toEqual(['refused', 'read', 'read', 'read']);
  });
  it('reads the dependency a step needs without checking it', () => {
    const worker = MINING_STEPS[0]!,
      shares = MINING_STEPS[1]!,
      payout = MINING_STEPS[3]!;
    expect(dependencyReading(null, shares)).toBe('unknown');
    expect(dependencyReading(health(), worker)).toBe('none');
    expect(dependencyReading(health(), shares)).toBe('configured');
    expect(dependencyReading(health({ ledger: { status: 'absent', code: 'x' } }), payout)).toBe('absent');
  });
});
