import { describe, expect, it } from 'vitest';
import type { ReconciliationEvaluation } from '@intafaced/contracts/ledger-reconciliation';
import { assetFails, failingTargets, repeatNotice } from './decide.js';

const asset = (difference: string, tolerance: string) => ({ assetId: 'USDC', observed: '0', expected: '0', difference, tolerance });

function evaluation(status: ReconciliationEvaluation['run']['status'], assets: ReturnType<typeof asset>[]): ReconciliationEvaluation {
  return {
    run: {
      id: '00000000-0000-4000-8000-000000000001',
      controlId: '00000000-0000-4000-8000-000000000002',
      status,
      phase: { status: 'unset' },
      errorCode: { status: 'unset' },
      asOf: '2026-10-29T10:00:00.000Z',
      readAt: '2026-10-29T10:00:00.000Z',
      margin: { status: 'unset' },
      sources: { ledger: { asOf: '2026-10-29T10:00:00.000Z' }, outside: { asOf: 'unset' }, parity: { asOf: 'unset' } },
      outsideSide: 'not_applicable',
      periodStart: '2026-10-29T00:00:00.000Z',
      periodEnd: '2026-10-30T00:00:00.000Z',
      assets,
    },
    finishedAt: '2026-10-29T10:00:01.123456Z',
    severity: { status: 'unset' },
  };
}

describe('reconciliation alert decisions', () => {
  it('fails an asset by the ledger rule: set, non-zero, outside a set tolerance', () => {
    expect(assetFails(asset('0', '0'))).toBe(false);
    expect(assetFails(asset('0.000', '0'))).toBe(false);
    expect(assetFails(asset('-0.5', '0.5'))).toBe(false);
    expect(assetFails(asset('-0.50000001', '0.5'))).toBe(true);
    expect(assetFails(asset('1', 'unset'))).toBe(true);
    expect(assetFails({ ...asset('0', '0'), difference: 'unset' })).toBe(false);
  });

  it('raises one target per failing asset, a blank asset for a FAIL with none, and nothing for any other status', () => {
    const failing = evaluation('FAIL', [asset('2', '1'), { ...asset('0', '0'), assetId: 'BTC' }, { ...asset('-3', '1'), assetId: 'ETH' }]);
    expect(failingTargets(failing).map((target) => target?.assetId)).toEqual(['USDC', 'ETH']);
    expect(failingTargets(evaluation('FAIL', []))).toEqual([null]);
    for (const status of ['PASS', 'ERROR', 'UNSET', 'started'] as const) {
      expect(failingTargets(evaluation(status, [asset('2', '1')]))).toEqual([]);
    }
  });

  it('decides a repeat notice: blank interval, not yet due, snoozed, then sent', () => {
    const now = new Date('2026-10-29T10:10:00.000Z');
    const last = new Date('2026-10-29T10:09:00.000Z');
    expect(repeatNotice({ repeatSeconds: null, lastNoticeAt: last, now, snoozed: false })).toBe('repeat_unset');
    expect(repeatNotice({ repeatSeconds: 90, lastNoticeAt: last, now, snoozed: true })).toBe('not_due');
    expect(repeatNotice({ repeatSeconds: 60, lastNoticeAt: last, now, snoozed: true })).toBe('snoozed');
    expect(repeatNotice({ repeatSeconds: 60, lastNoticeAt: last, now, snoozed: false })).toBe('sent');
  });
});
