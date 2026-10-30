import { opsAlertDetailSchema, type OpsAlertDetail } from '@intafaced/contracts/ops-reconciliation-alerts';

/** One finance alert as svc-ops answers it, for route and hash tests. TEST figures only. */
export const FOUNDER = '11111111-1111-4111-8111-111111111111';
export const ALERT = '22222222-2222-4222-8222-222222222222';
export const T = '2026-10-29T12:00:00.000Z';

export const founderCtx = {
  session: {
    userId: FOUNDER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};

/** A treasury credential shaped like a signed token naming its holder (the console reads only the middle part). */
export const treasuryToken = (holder: string): string => `h.${Buffer.from(JSON.stringify({ userId: holder })).toString('base64url')}.s`;

export function alertDetail(alert: Record<string, unknown> = {}): OpsAlertDetail {
  return opsAlertDetailSchema.parse({
    source: { status: 'ok', readAt: T },
    alert: {
      id: ALERT,
      kind: 'reconciliation',
      state: 'acknowledged',
      cause: 'fail',
      team: 'finance',
      error: null,
      controlId: '33333333-3333-4333-8333-333333333333',
      assetId: 'USDC',
      periodStart: T,
      periodEnd: T,
      severity: { status: 'set', value: 'critical' },
      occurrences: 1,
      firstSeen: T,
      lastSeen: T,
      evidence: {
        run: {
          id: '44444444-4444-4444-8444-444444444444',
          status: 'FAIL',
          asOf: T,
          readAt: T,
          sources: { ledger: { asOf: T }, outside: { asOf: 'unset' }, parity: { asOf: 'unset' } },
          outsideSide: 'unset',
          periodStart: T,
          periodEnd: T,
        },
        finishedAt: T,
        asset: { assetId: 'USDC', observed: '5', expected: '0', difference: '5', tolerance: '0' },
      },
      acknowledged: { by: FOUNDER, at: T, note: 'looking' },
      snooze: null,
      resolved: null,
      accepted: null,
      notices: {
        sent: 1,
        lastSentAt: T,
        repeat: { status: 'unset', code: 'ops.alert_repeat_unset' },
        outside: { email: 'vendor.email', push: 'vendor.push' },
      },
      version: 2,
      ...alert,
    },
    timeline: [],
    snoozes: [],
  });
}
