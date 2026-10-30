import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { Resource } from '../../../../shared/resource';
import { ReserveCard } from './Reserve';
import { reserveViewSchema, type ReserveView } from './schemas';

// TEST DATA written for these tests: no real merchant or amount.
const view = (patch: Partial<ReserveView> = {}): ReserveView => ({
  rule: { rollingReserveBps: 500, holdDays: 30 },
  holding: 'recorded_not_withheld',
  payoutsRefused: true,
  assets: [{ assetCode: 'USDT', recordedAmount: '4.25', entries: 1, nextReleaseAt: '2026-11-28T00:00:00.000Z', lastReleaseAt: null }],
  readAt: '2026-10-29T12:00:00.000Z',
  ...patch,
});
const draw = (resource: Resource<ReserveView>) => renderToString(<ReserveCard resource={resource} retry={() => undefined} test />);

describe('the reserve card on Money (J-merchant-07 #1)', () => {
  it('names the rule and the recorded amount, labelled recorded and not withheld', () => {
    const out = draw({ status: 'ready', data: view() });
    expect(out).toContain('Reserve');
    expect(out).toContain('recorded, not withheld');
    expect(out).toContain('5.00% of each settlement, for 30 days.');
    expect(out).toContain('4.25');
    expect(out).toContain('Payouts are refused while a reserve rule is set');
  });

  it('says when no rule is set and nothing is recorded, without a zero amount', () => {
    const out = draw({ status: 'ready', data: view({ rule: null, payoutsRefused: false, assets: [] }) });
    expect(out).toContain('No reserve rule is set for your account.');
    expect(out).toContain('Nothing is recorded against your reserve.');
    expect(out).not.toContain('Payouts are refused');
  });

  it('reads an unreadable reserve as a failure, never as zero', () => {
    const out = draw({ status: 'failed', failure: { ok: false, reason: 'error', code: 'pay.unavailable', message: 'pay.unavailable' } });
    expect(out).toContain('recorded, not withheld');
    expect(out).not.toContain('No reserve rule');
    expect(out).not.toMatch(/>0(\.0+)?</);
  });

  it('parses the service read and refuses any other holding', () => {
    const wire = { merchantId: 'TEST', ...view() };
    expect(reserveViewSchema.safeParse(wire).success).toBe(true);
    expect(reserveViewSchema.safeParse({ ...wire, holding: 'withheld' }).success).toBe(false);
  });
});
