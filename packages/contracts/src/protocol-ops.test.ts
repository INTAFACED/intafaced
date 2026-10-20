import { describe, expect, it } from 'vitest';
import {
  labelVerdict,
  marketTargetId,
  poolTargetId,
  protocolOpsActionResultSchema,
  protocolOpsIdempotencyKey,
  protocolOpsHiddenOutputSchema,
  PROTOCOL_OPS_TARGET_SERVICE,
  protocolOpsMetricsOutputSchema,
  protocolOpsPoolHideInputSchema,
  protocolOpsPoolsListOutputSchema,
} from './protocol-ops.js';

const pool = '0x' + 'aB'.repeat(20);
const now = '2026-10-20T12:00:00.000Z';

describe('target ids and idempotency keys', () => {
  it('names one pool one way, whatever the address case, and keys a retry by approval', () => {
    expect(poolTargetId(84532, pool)).toBe(poolTargetId(84532, pool.toUpperCase().replace('0X', '0x')));
    expect(protocolOpsIdempotencyKey('protocol.pool.hide', poolTargetId(84532, pool), 'ap_1')).toBe(
      `protocol.pool.hide:84532:${pool.toLowerCase()}:ap_1`,
    );
    expect(marketTargetId(' btc-usdt ')).toBe('BTC-USDT');
  });
});

describe('metrics', () => {
  const ok = { status: 'ok', value: 3 } as const;
  const base = {
    asOf: now,
    window: { from: now, to: now },
    quotes: ok,
    wallets: ok,
    refusalsByCode: { status: 'ok', value: { 'dex.quote.no_venue': 2 } },
    indexerLagBlocks: { status: 'ok', value: null },
    sections: [{ section: 'chain', health: 'ok', checkedAt: now }],
  };
  it('carries a failed source as could_not_load with the time tried, never as a zero', () => {
    expect(protocolOpsMetricsOutputSchema.safeParse(base).success).toBe(true);
    const failed = { ...base, quotes: { status: 'could_not_load', triedAt: now, code: 'edge.upstream_unavailable' } };
    expect(protocolOpsMetricsOutputSchema.safeParse(failed).success).toBe(true);
    expect(protocolOpsMetricsOutputSchema.safeParse({ ...base, quotes: { status: 'could_not_load', value: 0 } }).success).toBe(false);
    expect(protocolOpsMetricsOutputSchema.safeParse({ ...base, quotes: { status: 'ok', value: -1 } }).success).toBe(false);
  });
});

describe('label verdict', () => {
  const entry = (label: string, audited = false) => ({
    surface: 'service' as const,
    where: `svc-protocol:${label.length}`,
    label,
    audited,
  });
  it('passes honest labels and fails a planted mainnet claim or audited true', () => {
    expect(labelVerdict([entry('Base Sepolia test network. Not INTACHAIN.'), entry('Local test chain')])).toEqual({
      pass: true,
      violations: [],
    });
    for (const label of ['INTACHAIN mainnet', 'The mainnet of INTACHAIN', 'intachain   Mainnet']) {
      const verdict = labelVerdict([entry(label)]);
      expect(verdict.pass, label).toBe(false);
      expect(verdict.violations[0]?.reason).toBe('claims_mainnet');
    }
    expect(labelVerdict([entry('Base Sepolia test network', true)]).violations[0]?.reason).toBe('audited_true');
  });
});

describe('pool control', () => {
  it('needs a reason, a code and an approval, and refuses any extra field', () => {
    const input = { chainId: 84532, poolAddress: pool, reasonCode: 'scam_report', reason: 'reported', approvalId: 'ap_1' };
    expect(protocolOpsPoolHideInputSchema.safeParse(input).success).toBe(true);
    for (const patch of [{ reason: '' }, { reasonCode: '' }, { approvalId: '' }, { poolAddress: '0x1' }, { extra: 1 }]) {
      expect(protocolOpsPoolHideInputSchema.safeParse({ ...input, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
  it('lists a hidden pool with who hid it and under which policy, and returns a noop with a note', () => {
    const hiddenPool = {
      chainId: 84532,
      poolAddress: pool,
      state: 'hidden',
      hidden: { reasonCode: 'scam_report', reason: 'reported', approvalId: 'ap_1', policyVersion: 'p1', at: now },
    };
    expect(protocolOpsPoolsListOutputSchema.safeParse({ asOf: now, pools: [hiddenPool] }).success).toBe(true);
    expect(
      protocolOpsActionResultSchema.safeParse({
        action: 'protocol.pool.hide',
        targetId: poolTargetId(84532, pool),
        state: 'hidden',
        outcome: 'noop',
        note: 'Already hidden by an earlier approval.',
        idempotencyKey: 'k',
      }).success,
    ).toBe(true);
  });
});

describe('hide list read', () => {
  it('is hosted by svc-ops and carries only what a reader needs to drop a listing', () => {
    expect(PROTOCOL_OPS_TARGET_SERVICE).toBe('svc-ops');
    expect(
      protocolOpsHiddenOutputSchema.safeParse({
        asOf: now,
        pools: [{ chainId: 84532, poolAddress: pool }],
        markets: [{ symbol: 'BTC-USDT' }],
      }).success,
    ).toBe(true);
    expect(
      protocolOpsHiddenOutputSchema.safeParse({ asOf: now, pools: [{ chainId: 84532, poolAddress: pool, reason: 'x' }], markets: [] })
        .success,
    ).toBe(false);
    expect(protocolOpsHiddenOutputSchema.safeParse({ asOf: now, pools: [], markets: [], extra: 1 }).success).toBe(false);
    expect(protocolOpsHiddenOutputSchema.safeParse({ pools: [], markets: [] }).success).toBe(false);
  });
});
