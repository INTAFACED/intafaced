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

  it('lets finance request a payout with step-up and keeps refund and send off for the role', () => {
    expect(action('finance', 'payout-new', 'payout.request')).toEqual({ action: 'payout.request', allowed: true, reason: 'step_up' });
    expect(action('finance', 'payout-new', 'payout.send')).toEqual({ action: 'payout.send', allowed: false, reason: 'role' });
    expect(action('finance', 'refund-new', 'refund')).toEqual({ action: 'refund', allowed: false, reason: 'role' });
    expect(action('viewer', 'payout-new', 'payout.request')).toEqual({ action: 'payout.request', allowed: false, reason: 'role' });
    expect(action('viewer', 'payout-new', 'payout.send')).toEqual({ action: 'payout.send', allowed: false, reason: 'role' });
    expect(action('viewer', 'refund-new', 'refund')).toEqual({ action: 'refund', allowed: false, reason: 'role' });
  });

  it('refuses writes while KYB is not approved and still opens the room', () => {
    expect(action('owner', 'refund-new', 'open', { kybStatus: 'none' })).toEqual({ action: 'open', allowed: true, reason: null });
    expect(action('owner', 'refund-new', 'refund', { kybStatus: 'none' })).toEqual({ action: 'refund', allowed: false, reason: 'kyb' });
    expect(action('owner', 'payout-new', 'payout.request', { kybStatus: 'pending' })).toEqual({
      action: 'payout.request',
      allowed: false,
      reason: 'kyb',
    });
    expect(action('owner', 'settings', 'profile.manage', { kybStatus: 'none' })).toEqual({
      action: 'profile.manage',
      allowed: true,
      reason: null,
    });
    expect(action('owner', 'settings', 'profile.manage', { kybStatus: 'pending' })).toEqual({
      action: 'profile.manage',
      allowed: true,
      reason: null,
    });
    expect(action('owner', 'settings', 'profile.manage', { kybStatus: 'rejected' })).toEqual({
      action: 'profile.manage',
      allowed: true,
      reason: null,
    });
    expect(action('admin', 'settings', 'profile.manage', { kybStatus: 'none' })).toEqual({
      action: 'profile.manage',
      allowed: false,
      reason: 'kyb',
    });
    const writes = [
      ['team', 'team.manage'],
      ['links', 'link.create'],
      ['invoices', 'invoice.create'],
      ['developer-webhooks', 'webhook.manage'],
      ['approvals', 'payout.approve'],
      ['checkout-settings', 'checkout.save'],
    ] as const;
    for (const [room, id] of writes) {
      expect(action('owner', room, id, { kybStatus: 'none' })).toEqual({ action: id, allowed: false, reason: 'kyb' });
    }
  });

  it('keeps a pending account in onboarding and names a suspended or closed account inactive', () => {
    expect(action('owner', 'settings', 'profile.manage', { accountStatus: 'pending', kybStatus: 'none' })).toEqual({
      action: 'profile.manage',
      allowed: true,
      reason: null,
    });
    expect(action('owner', 'settings', 'profile.manage', { accountStatus: 'pending' })).toEqual({
      action: 'profile.manage',
      allowed: true,
      reason: null,
    });
    expect(action('owner', 'settings', 'profile.manage', { accountStatus: 'closed', kybStatus: 'none' })).toEqual({
      action: 'profile.manage',
      allowed: false,
      reason: 'inactive',
    });
    const writes = [
      ['team', 'team.manage'],
      ['invoices', 'invoice.create'],
      ['developer-webhooks', 'webhook.manage'],
      ['approvals', 'payout.approve'],
      ['checkout-settings', 'checkout.save'],
    ] as const;
    for (const [room, id] of writes) {
      expect(action('owner', room, id, { accountStatus: 'pending', kybStatus: 'none' })).toEqual({
        action: id,
        allowed: false,
        reason: 'kyb',
      });
      expect(action('owner', room, id, { accountStatus: 'pending' })).toEqual({ action: id, allowed: true, reason: null });
      expect(action('owner', room, id, { accountStatus: 'suspended' })).toEqual({ action: id, allowed: false, reason: 'inactive' });
      expect(action('owner', room, id, { accountStatus: 'closed' })).toEqual({ action: id, allowed: false, reason: 'inactive' });
    }
    for (const room of ['links', 'link-new', 'link'] as const) {
      expect(action('owner', room, 'link.create', { accountStatus: 'pending', kybStatus: 'none' })).toEqual({
        action: 'link.create',
        allowed: false,
        reason: 'inactive',
      });
      expect(action('owner', room, 'link.create', { accountStatus: 'pending' })).toEqual({
        action: 'link.create',
        allowed: false,
        reason: 'inactive',
      });
      expect(action('owner', room, 'link.create', { accountStatus: 'suspended' })).toEqual({
        action: 'link.create',
        allowed: false,
        reason: 'inactive',
      });
      expect(action('owner', room, 'link.create', { accountStatus: 'closed' })).toEqual({
        action: 'link.create',
        allowed: false,
        reason: 'inactive',
      });
    }
    for (const room of ['subscriptions', 'subscription', 'subscription-new'] as const) {
      expect(action('owner', room, 'subscription.manage', { accountStatus: 'pending' })).toEqual({
        action: 'subscription.manage',
        allowed: false,
        reason: 'inactive',
      });
      expect(action('owner', room, 'subscription.manage', { accountStatus: 'suspended' })).toEqual({
        action: 'subscription.manage',
        allowed: false,
        reason: 'inactive',
      });
    }
    expect(action('owner', 'settings', 'profile.manage', { accountStatus: 'suspended', kybStatus: 'none' })).toEqual({
      action: 'profile.manage',
      allowed: false,
      reason: 'inactive',
    });
    expect(action('owner', 'payments', 'refund', { accountStatus: 'pending' })).toEqual({
      action: 'refund',
      allowed: true,
      reason: 'step_up',
    });
    expect(action('owner', 'refund-new', 'refund', { accountStatus: 'suspended' })).toEqual({
      action: 'refund',
      allowed: true,
      reason: 'step_up',
    });
    expect(action('owner', 'refund-new', 'refund', { accountStatus: 'closed' })).toEqual({
      action: 'refund',
      allowed: true,
      reason: 'step_up',
    });
    expect(action('owner', 'payout-new', 'payout.request', { accountStatus: 'suspended' })).toEqual({
      action: 'payout.request',
      allowed: true,
      reason: 'step_up',
    });
    expect(action('owner', 'payout-new', 'payout.request', { accountStatus: 'closed' })).toEqual({
      action: 'payout.request',
      allowed: true,
      reason: 'step_up',
    });
    expect(action('owner', 'payout-new', 'payout.request', { accountStatus: 'pending', kybStatus: 'none' })).toEqual({
      action: 'payout.request',
      allowed: false,
      reason: 'kyb',
    });
    expect(action('owner', 'payout-new', 'payout.request', { accountStatus: 'pending' })).toEqual({
      action: 'payout.request',
      allowed: true,
      reason: 'step_up',
    });
    expect(action('owner', 'payout-new', 'payout.send', { accountStatus: 'pending' })).toEqual({
      action: 'payout.send',
      allowed: false,
      reason: 'inactive',
    });
  });

  it('names step-up on an allowed refund or payout and session when the caller is not interactive', () => {
    expect(action('owner', 'payments', 'refund')).toEqual({ action: 'refund', allowed: true, reason: 'step_up' });
    expect(action('owner', 'payout-new', 'payout.request')).toEqual({ action: 'payout.request', allowed: true, reason: 'step_up' });
    expect(action('owner', 'payout-new', 'payout.send')).toEqual({ action: 'payout.send', allowed: true, reason: 'step_up' });
    expect(action('owner', 'payments', 'refund', { sessionInteractive: false })).toEqual({
      action: 'refund',
      allowed: false,
      reason: 'session',
    });
    expect(
      action('owner', 'settings', 'profile.manage', { sessionInteractive: false, accountStatus: 'suspended', kybStatus: 'none' }),
    ).toEqual({
      action: 'profile.manage',
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
