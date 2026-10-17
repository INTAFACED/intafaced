import { describe, expect, it } from 'vitest';
import { stakeRows, summariseStakes, unlockCalendar, validStakeAmount, type StakeRow } from './token-holdings';

const now = Date.parse('2026-10-17T00:00:00.000Z');
const row = (id: string, amount: string, tier: StakeRow['tier'], status: StakeRow['status'], unlocksAt: string | null): StakeRow => ({
  id,
  amount,
  tier,
  status,
  startedAt: '2026-08-01T00:00:00.000Z',
  unlocksAt,
});
const rows = [
  row('a', '100.5', 'm3', 'active', '2026-11-01T00:00:00.000Z'),
  row('b', '10', 'flex', 'active', null),
  row('c', '0.25', 'm12', 'active', '2026-09-01T00:00:00.000Z'),
  row('d', '7', 'm3', 'pending', '2026-12-25T00:00:00.000Z'),
  row('e', '3', 'flex', 'closed', null),
  row('f', '2', 'm12', 'unstaking', '2027-01-01T00:00:00.000Z'),
];

describe('stake holdings', () => {
  it('adds exact amounts by status and splits active stake into locked and free', () => {
    expect(summariseStakes(rows, now)).toEqual({
      active: '110.75',
      pending: '7',
      unstaking: '2',
      closed: '3',
      locked: '100.5',
      free: '10.25',
      count: 6,
    });
  });
  it('has no rounding loss on small amounts', () => {
    const s = summariseStakes([row('x', '0.1', 'flex', 'active', null), row('y', '0.2', 'flex', 'active', null)], now);
    expect(s.active).toBe('0.3');
  });
  it('lists only future unlocks of open stakes, soonest first', () => {
    const calendar = unlockCalendar(rows, now);
    expect(calendar.map((u) => u.id)).toEqual(['a', 'd', 'f']);
    expect(calendar[0]).toMatchObject({ daysLeft: 15, tier: 'm3' });
  });
  it('exports every row with an empty unlock for flexible stakes', () => {
    expect(stakeRows(rows)[1]).toEqual(['b', '10', 'flex', 'active', '2026-08-01T00:00:00.000Z', '']);
  });
  it('accepts only a positive exact decimal as a stake amount', () => {
    expect(validStakeAmount('1')).toBe(true);
    expect(validStakeAmount('0.000001')).toBe(true);
    expect(validStakeAmount('0')).toBe(false);
    expect(validStakeAmount('-1')).toBe(false);
    expect(validStakeAmount('1e3')).toBe(false);
    expect(validStakeAmount('')).toBe(false);
  });
});
