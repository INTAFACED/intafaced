import { MERCHANT_PORTAL_ROOMS } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { decideRoomAction, projectRoomAccess, type RoomAccessContext } from './room-access.js';

const base = (over: Partial<RoomAccessContext> = {}): RoomAccessContext => ({
  role: 'owner',
  sessionInteractive: true,
  accountStatus: 'active',
  kybStatus: 'approved',
  ...over,
});

const action = (role: RoomAccessContext['role'], room: string, id: string, over: Partial<RoomAccessContext> = {}) => {
  const view = projectRoomAccess({ ...base({ role, ...over }), merchantId: '11111111-1111-4111-8111-111111111111' });
  const found = view.rooms.find((row) => row.room === room)?.actions.find((row) => row.action === id);
  if (!found) throw new Error(`missing ${room} ${id}`);
  return found;
};

describe('merchant room access (M-adv-phantom-order-01)', () => {
  it('lists every portal room once for each role', () => {
    for (const role of ['owner', 'admin', 'finance', 'developer', 'viewer'] as const) {
      const view = projectRoomAccess({ ...base({ role }), merchantId: '11111111-1111-4111-8111-111111111111' });
      expect(view.rooms.map((row) => row.room)).toEqual([...MERCHANT_PORTAL_ROOMS]);
      for (const room of view.rooms) {
        expect(room.actions[0]).toEqual({ action: 'open', allowed: true, reason: null });
      }
    }
  });

  it('lets finance request a payout and refuses a refund for the role', () => {
    expect(action('finance', 'payout-new', 'payout.request')).toEqual({ action: 'payout.request', allowed: true, reason: null });
    expect(action('finance', 'refund-new', 'refund')).toEqual({ action: 'refund', allowed: false, reason: 'role' });
    expect(action('viewer', 'payout-new', 'payout.request')).toEqual({ action: 'payout.request', allowed: false, reason: 'role' });
  });

  it('refuses money while KYB is not approved and still opens the room', () => {
    expect(action('owner', 'refund-new', 'open', { kybStatus: 'none' })).toEqual({ action: 'open', allowed: true, reason: null });
    expect(action('owner', 'refund-new', 'refund', { kybStatus: 'none' })).toEqual({ action: 'refund', allowed: false, reason: 'kyb' });
    expect(action('owner', 'payout-new', 'payout.request', { kybStatus: 'pending' })).toEqual({
      action: 'payout.request',
      allowed: false,
      reason: 'kyb',
    });
  });

  it('names step-up on an allowed refund and session when the caller is not interactive', () => {
    expect(action('owner', 'payments', 'refund')).toEqual({ action: 'refund', allowed: true, reason: 'step_up' });
    expect(action('owner', 'payments', 'refund', { sessionInteractive: false })).toEqual({
      action: 'refund',
      allowed: false,
      reason: 'session',
    });
    expect(decideRoomAction(base({ accountStatus: 'suspended' }), { kind: 'money', money: 'payout', act: 'send' })).toEqual({
      allowed: false,
      reason: 'inactive',
    });
  });

  it('does not allow a control that is off to omit its reason', () => {
    const view = projectRoomAccess({ ...base({ role: 'viewer' }), merchantId: '11111111-1111-4111-8111-111111111111' });
    for (const room of view.rooms) {
      for (const row of room.actions) {
        if (row.allowed) expect(row.reason === null || row.reason === 'step_up').toBe(true);
        else expect(row.reason).not.toBeNull();
      }
    }
  });
});
