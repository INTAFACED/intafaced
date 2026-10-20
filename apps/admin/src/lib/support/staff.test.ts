import { describe, expect, it } from 'vitest';
import { explainSupportFailure } from './refusal';
import {
  availabilityGate,
  heartbeatNote,
  readStaffAvailabilityRequest,
  readStaffPolicy,
  readStaffRoster,
  type StaffMemberView,
} from './staff';
import { readActionRequest } from './model';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const member = (over: Partial<StaffMemberView> = {}): StaffMemberView => ({
  userId: A,
  role: 'agent',
  appointedBy: B,
  appointedAt: '2026-10-20T01:00:00.000Z',
  availability: 'offline',
  availabilitySetAt: null,
  lastHeartbeatAt: null,
  ...over,
});

describe('readers', () => {
  it('reads a roster only when every row reads', () => {
    expect(readStaffRoster([member(), member({ userId: B, role: 'lead' })])).toHaveLength(2);
    expect(readStaffRoster([member(), { ...member(), availability: 'away' }])).toBeNull();
    expect(readStaffRoster({})).toBeNull();
    expect(readStaffRoster([])).toEqual([]);
  });
  it('reads the policy and refuses one that contradicts itself', () => {
    expect(readStaffPolicy({ automaticOffline: 'not_set', heartbeatWindowSeconds: null })).toMatchObject({ automaticOffline: 'not_set' });
    expect(readStaffPolicy({ automaticOffline: 'set', heartbeatWindowSeconds: 90 })).toMatchObject({ heartbeatWindowSeconds: 90 });
    expect(readStaffPolicy({ automaticOffline: 'set', heartbeatWindowSeconds: null })).toBeNull();
    expect(readStaffPolicy({ automaticOffline: 'not_set', heartbeatWindowSeconds: 90 })).toBeNull();
    expect(readStaffPolicy({ automaticOffline: 'set', heartbeatWindowSeconds: 0 })).toBeNull();
  });
  it('says plainly that a blank window moves nobody', () => {
    expect(heartbeatNote({ automaticOffline: 'not_set', heartbeatWindowSeconds: null })).toContain('not set');
    expect(heartbeatNote({ automaticOffline: 'set', heartbeatWindowSeconds: 90 })).toContain('90 seconds');
  });
});

describe('the availability request', () => {
  it('reads a known shape and trims the reason', () => {
    expect(readStaffAvailabilityRequest({ action: 'staff_availability', availability: 'busy', reason: ' lunch ' })).toEqual({
      action: 'staff_availability',
      availability: 'busy',
      reason: 'lunch',
    });
    expect(readActionRequest({ action: 'staff_availability', availability: 'online', userId: B })).toMatchObject({ userId: B });
  });
  it('refuses anything else before the network', () => {
    for (const bad of [
      { availability: 'away' },
      { availability: 'online', userId: 'x' },
      { availability: 'online', reason: '  ' },
      { availability: 'online', reason: 'x'.repeat(501) },
      {},
    ])
      expect(readStaffAvailabilityRequest(bad)).toBeNull();
  });
});

describe('the gate', () => {
  const me = member({ userId: A });
  const lead = member({ userId: A, role: 'lead' });
  const other = member({ userId: B });
  it('lets a person set their own, and only a lead set another’s', () => {
    expect(availabilityGate(me, me, 'online', '', false).ok).toBe(true);
    expect(availabilityGate(me, other, 'online', '', false).ok).toBe(false);
    expect(availabilityGate(lead, other, 'online', '', false).ok).toBe(true);
  });
  it('says why when it is off', () => {
    expect(availabilityGate(null, other, 'online', '', false)).toMatchObject({
      ok: false,
      why: expect.stringContaining('not on the support staff'),
    });
    expect(availabilityGate(me, me, 'offline', '', false)).toMatchObject({ ok: false, why: 'Already offline.' });
    expect(availabilityGate(me, me, 'online', '', true).ok).toBe(false);
  });
});

describe('a 403 about staff is not a missing permission', () => {
  const forbidden = (message: string) =>
    explainSupportFailure({ kind: 'forbidden', refusal: { code: null, message, status: 403 } } as never);
  it('not_staff and not_lead get their own sentences and change nothing', () => {
    expect(forbidden('support.not_staff')).toMatchObject({ title: 'You are not on the support staff list', changed: 'no' });
    expect(forbidden('support.not_lead').title).toContain('Only a lead');
  });
  it('a plain 403 is still the missing permission', () => {
    expect(forbidden('scope').title).toContain('does not have support operations permission');
  });
});
