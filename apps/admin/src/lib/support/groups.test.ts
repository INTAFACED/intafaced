import { describe, expect, it } from 'vitest';
import { memberGate, readDeskScope, readGroupActionRequest, readGroups, saveGate, scopeSentence, type DeskGroupView } from './groups';
import { readActionRequest } from './model';
import type { StaffMemberView } from './staff';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const G = '33333333-3333-4333-8333-333333333333';
const group = (over: Partial<DeskGroupView> = {}): DeskGroupView => ({
  id: G,
  name: 'Payments',
  createdBy: A,
  createdAt: '2026-10-20T01:00:00.000Z',
  memberIds: [A],
  ...over,
});
const staff = (userId: string, role: 'agent' | 'lead'): StaffMemberView => ({
  userId,
  role,
  appointedBy: A,
  appointedAt: '2026-10-20T01:00:00.000Z',
  availability: 'online',
  availabilitySetAt: null,
  lastHeartbeatAt: null,
});

describe('readers', () => {
  it('reads groups only when every one reads', () => {
    expect(readGroups([group(), group({ id: B, name: 'KYC' })])).toHaveLength(2);
    expect(readGroups([group(), { id: B }])).toBeNull();
    expect(readGroups([])).toEqual([]);
    expect(readGroups({})).toBeNull();
  });
  it('reads the scope strictly', () => {
    expect(readDeskScope({ restricted: false, groups: [], seesAllGroups: false })).toMatchObject({ restricted: false });
    expect(readDeskScope({ restricted: true, groups: [{ id: G }], seesAllGroups: false })).toBeNull();
    expect(readDeskScope({ restricted: 'yes', groups: [], seesAllGroups: false })).toBeNull();
  });
  it('says what the scope means in plain words', () => {
    expect(scopeSentence({ restricted: false, groups: [], seesAllGroups: false })).toContain('No groups are set up');
    expect(scopeSentence({ restricted: true, groups: [{ id: G, name: 'Payments' }], seesAllGroups: false })).toContain('Payments');
    expect(scopeSentence({ restricted: true, groups: [], seesAllGroups: true })).toContain('every group');
    expect(scopeSentence({ restricted: true, groups: [], seesAllGroups: false })).toContain('you are in none');
  });
});

describe('the request reader', () => {
  it('reads a save, trimmed, with the key', () => {
    expect(readGroupActionRequest({ action: 'group_save', name: ' Payments ', idempotencyKey: 'group:abcdef12' })).toEqual({
      action: 'group_save',
      name: 'Payments',
      idempotencyKey: 'group:abcdef12',
    });
    expect(readActionRequest({ action: 'group_member', op: 'remove', groupId: G, userId: A })).toMatchObject({ op: 'remove' });
  });
  it('refuses anything else before the network', () => {
    for (const bad of [
      { action: 'group_save', name: '  ', idempotencyKey: 'group:abcdef12' },
      { action: 'group_save', name: 'x', idempotencyKey: 'short' },
      { action: 'group_save', name: 'x'.repeat(81), idempotencyKey: 'group:abcdef12' },
      { action: 'group_save', name: 'x', idempotencyKey: 'group:abcdef12', groupId: 'nope' },
      { action: 'group_member', op: 'toggle', groupId: G, userId: A },
      { action: 'group_member', op: 'add', groupId: G },
    ])
      expect(readGroupActionRequest(bad)).toBeNull();
  });
});

describe('the gates', () => {
  const lead = staff(A, 'lead');
  const agent = staff(B, 'agent');
  it('only a lead can make or change', () => {
    expect(saveGate(lead, 'KYC', [group()], null, false).ok).toBe(true);
    expect(saveGate(agent, 'KYC', [group()], null, false)).toMatchObject({ ok: false, why: 'Only a lead can make or change groups.' });
    expect(saveGate(null, 'KYC', [], null, false).ok).toBe(false);
  });
  it('names a taken name, a blank, an unchanged rename and a busy step', () => {
    expect(saveGate(lead, 'payments', [group()], null, false)).toMatchObject({ why: 'A group with that name exists.' });
    expect(saveGate(lead, ' ', [], null, false)).toMatchObject({ why: 'Give the group a name first.' });
    expect(saveGate(lead, 'Payments', [group()], G, false)).toMatchObject({ why: 'That is already its name.' });
    expect(saveGate(lead, 'Payments', [group()], G, true).ok).toBe(false);
  });
  it('a rename to a new name is allowed even when it differs only by case from itself', () => {
    expect(saveGate(lead, 'PAYMENTS', [group()], G, false).ok).toBe(true);
  });
  it('membership: add needs a staff member not in it, remove needs a member', () => {
    const roster = [lead, agent];
    expect(memberGate(lead, group(), B, 'add', roster, false).ok).toBe(true);
    expect(memberGate(lead, group(), A, 'add', roster, false)).toMatchObject({ why: 'Already in this group.' });
    expect(memberGate(lead, group(), B, 'remove', roster, false)).toMatchObject({ why: 'Not in this group.' });
    expect(memberGate(lead, group(), A, 'remove', roster, false).ok).toBe(true);
    expect(memberGate(lead, group(), '33333333-3333-4333-8333-999999999999', 'add', roster, false).ok).toBe(false);
    expect(memberGate(agent, group(), A, 'remove', roster, false).ok).toBe(false);
    expect(memberGate(lead, null, A, 'add', roster, false)).toMatchObject({ why: 'Pick a group first.' });
  });
});
