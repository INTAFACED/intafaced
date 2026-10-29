import { describe, expect, it } from 'vitest';
import { activationOf } from './activation.js';

describe('activationOf', () => {
  const at = new Date('2026-10-29T10:00:00.000Z');

  it('confirms only when the newest status row moves to active and the business is active now', () => {
    expect(activationOf('active', 'active', at)).toEqual({ activation: 'confirmed', status: 'active', activatedAt: at.toISOString() });
  });

  it('an active business with no status history is unconfirmed: the opening default is not an activation', () => {
    expect(activationOf('active', null, null)).toEqual({
      activation: 'unconfirmed',
      status: 'active',
      activatedAt: null,
      reason: 'no_activation_record',
    });
  });

  it('a newest row that is not a move to active confirms nothing, even if the column reads active', () => {
    expect(activationOf('active', 'suspended', at)).toMatchObject({ activation: 'unconfirmed', reason: 'no_activation_record' });
  });

  it.each(['pending', 'suspended', 'closed'] as const)('a %s business is unconfirmed, whatever its history', (status) => {
    expect(activationOf(status, 'active', at)).toEqual({ activation: 'unconfirmed', status, activatedAt: null, reason: 'not_active' });
  });
});
