import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '../session/session';
import { LaunchDistributionView, scheduleSchema, type ScheduleRead } from './LaunchDistribution';

const html = (data: ScheduleRead) =>
  renderToStaticMarkup(
    <SessionProvider>
      <LaunchDistributionView eventId="test-launch" read={{ resource: { status: 'ready', data }, reload: () => undefined }} />
    </SessionProvider>,
  );
const base = {
  eventId: 'test-launch',
  readAt: '2026-12-16T00:00:00.000Z',
  awarded: null,
  awardedReason: 'launch.allocation_unwired',
} as const;
const vesting = { startAt: '2026-12-01T00:00:00.000Z', cliffAt: null, endAt: '2026-12-31T00:00:00.000Z' };

describe('launch distribution panel (MC-launch-05)', () => {
  it('with no schedule says "schedule not set" and shows no date or share', () => {
    const out = html({ ...base, vesting: null, reason: 'launch.schedule_unset', phase: null, vestedShare: null });
    expect(out).toContain('Schedule not set');
    expect(out).not.toContain('<time');
    expect(out).not.toContain('% of any allocation');
    expect(out).toContain('Your allocation: none awarded.');
    expect(out).toContain('Sign in to claim.');
  });

  it.each([
    ['0', 'Not started', '0%'],
    ['0.5', 'Vesting', '50%'],
    ['0.333333333333333333', 'Vesting', '33.33%'],
    ['1', 'Fully vested', '100%'],
  ])('a set schedule shows the service share %s as %s and %s', (share, stage, pct) => {
    const phase = share === '0' ? 'before_start' : share === '1' ? 'vested' : 'vesting';
    const out = html({ ...base, vesting, reason: null, phase, vestedShare: share });
    expect(out).toContain(`${pct} of any allocation`);
    expect(out).toContain(stage);
    expect(out).toContain('No cliff');
    expect(out).toContain('2026-12-01 00:00 UTC');
  });

  it('refuses a read that is neither set nor unset', () => {
    expect(scheduleSchema.safeParse({ ...base, vesting: null, reason: null, phase: null, vestedShare: null }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, vesting, reason: null, phase: 'vesting', vestedShare: null }).success).toBe(false);
  });
});
