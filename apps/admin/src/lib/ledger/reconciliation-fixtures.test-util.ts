import type { ReconciliationControlRunView, ReconciliationControlView } from './reconciliation';

/** LOCAL TEST shapes as svc-ledger answers them. No figure here is a real balance. */
export const CONTROL_ID = '0b4f6c2e-1111-4222-8333-444455556666';

export function controlView(extra: Partial<ReconciliationControlView> = {}): ReconciliationControlView {
  return {
    id: CONTROL_ID,
    builtin: false,
    template: 'threshold',
    checkKind: { status: 'unset' },
    state: 'active',
    explanation: 'TEST USDT float floor',
    labels: ['test'],
    schedule: { status: 'set', value: { cadence: 'daily', hour: 6, minute: 30 }, period: 'day' },
    severity: { status: 'set', value: 'warning' },
    tolerance: { status: 'set', default: '0', byAsset: {} },
    margin: { status: 'unset' },
    accountSet: { mode: 'query', assetId: 'USDT' },
    threshold: { status: 'set', bound: 'min', byAsset: { USDT: '1' } },
    version: 3,
    ...extra,
  };
}

export function runView(extra: Partial<ReconciliationControlRunView> = {}): ReconciliationControlRunView {
  return {
    id: '9a1b2c3d-1111-4222-8333-444455556666',
    controlId: CONTROL_ID,
    status: 'PASS',
    phase: { status: 'unset' },
    errorCode: { status: 'unset' },
    asOf: '2026-10-24T06:00:00.000Z',
    readAt: '2026-10-24T06:00:00.000Z',
    margin: { status: 'unset' },
    sources: { ledger: { asOf: '2026-10-24T06:00:00.000Z' }, outside: { asOf: 'unset' }, parity: { asOf: 'unset' } },
    outsideSide: 'not_applicable',
    periodStart: '2026-10-24T00:00:00.000Z',
    periodEnd: '2026-10-25T00:00:00.000Z',
    accounts: ['7c1d2e3f-1111-4222-8333-444455556666'],
    assets: [{ assetId: 'USDT', observed: '5', expected: 'unset', difference: 'unset', tolerance: '0' }],
    ...extra,
  };
}
