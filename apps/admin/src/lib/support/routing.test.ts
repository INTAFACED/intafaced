import { describe, expect, it } from 'vitest';
import { readActionRequest } from './model';
import {
  modeWords,
  parseCapacity,
  parseSkills,
  readAvailabilityLog,
  readGroupLog,
  readRequiredSkillResult,
  readRoutingOverview,
  readRoutingWaiting,
  readSetModeResult,
  readTicketRouting,
  staffRoutingGate,
} from './routing';
import type { StaffMemberView } from './staff';

const A = '11111111-1111-4111-8111-111111111111';
const G = '33333333-3333-4333-8333-333333333333';
const T = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-20T04:00:00.000Z';
const lead: StaffMemberView = {
  userId: A,
  role: 'lead',
  appointedBy: A,
  appointedAt: at,
  availability: 'online',
  availabilitySetAt: null,
  lastHeartbeatAt: null,
};

describe('routing readers', () => {
  it('reads the overview only when every row reads', () => {
    const good = {
      groups: [{ groupId: G, name: 'Payments', mode: null, cursorUserId: null, setBy: null, setAt: null }],
      staff: [{ userId: A, capacity: null, skills: [] }],
      sweepSeconds: null,
    };
    expect(readRoutingOverview(good)).toEqual(good);
    expect(readRoutingOverview({ ...good, groups: [{ ...good.groups[0], mode: 'random' }] })).toBeNull();
    expect(readRoutingOverview({ ...good, staff: [{ userId: A, capacity: 1.5, skills: [] }] })).toBeNull();
    expect(readRoutingOverview({ ...good, sweepSeconds: 0 })).toBeNull();
  });
  it('a request’s routing carries the code exactly when no agent could take it', () => {
    expect(
      readTicketRouting({ ticketId: T, requiredSkill: 'kyc', state: 'no_agent', code: 'support.no_agent_available', stateAt: at }),
    ).not.toBeNull();
    expect(readTicketRouting({ ticketId: T, requiredSkill: null, state: 'no_agent', code: null, stateAt: at })).toBeNull();
    expect(
      readTicketRouting({ ticketId: T, requiredSkill: null, state: 'assigned', code: 'support.no_agent_available', stateAt: at }),
    ).toBeNull();
  });
  it('reads the waiting list, the availability log and the group log strictly', () => {
    expect(readRoutingWaiting([{ ticketId: T, code: 'support.no_agent_available', since: null }])).toHaveLength(1);
    expect(readRoutingWaiting([{ ticketId: T, code: 'other', since: null }])).toBeNull();
    expect(readAvailabilityLog([{ userId: A, availability: 'busy', by: A, reason: null, at }])).toHaveLength(1);
    expect(readAvailabilityLog([{ userId: A, availability: 'away', by: A, reason: null, at }])).toBeNull();
    expect(readGroupLog([{ groupId: G, action: 'created', subject: null, by: A, at }])).toHaveLength(1);
    expect(readGroupLog([{ groupId: G, action: 'deleted', subject: null, by: A, at }])).toBeNull();
  });
  it('reads write answers strictly: an unknown outcome is not read as done', () => {
    const routing = { groupId: G, mode: 'round_robin', cursorUserId: null, revision: 1, setBy: A, setAt: at };
    expect(
      readSetModeResult({ routing, routed: [{ status: 'queued', ticketId: T, groupId: G, code: 'support.no_agent_available' }] }),
    ).not.toBeNull();
    expect(readSetModeResult({ routing, routed: [{ status: 'maybe', ticketId: T }] })).toBeNull();
    expect(
      readRequiredSkillResult({
        routing: { ticketId: T, requiredSkill: 'kyc', state: 'assigned', stateAt: at },
        outcome: { status: 'assigned', ticketId: T, assigneeId: A, groupId: G, mode: 'load_balanced' },
      }),
    ).toMatchObject({ requiredSkill: 'kyc' });
    expect(readRequiredSkillResult({ routing: { ticketId: T, requiredSkill: 'kyc', state: 'assigned', stateAt: at } })).toBeNull();
  });
});

describe('routing words and inputs', () => {
  it('names each mode in plain words', () => {
    expect([null, 'off', 'round_robin', 'load_balanced'].map((m) => modeWords(m as never))).toEqual([
      'Not set',
      'Off',
      'In turn',
      'Least loaded',
    ]);
  });
  it('blank capacity is not set; only whole numbers are taken', () => {
    expect(parseCapacity(' ')).toEqual({ ok: true, value: null });
    expect(parseCapacity('3')).toEqual({ ok: true, value: 3 });
    expect(parseCapacity('-1').ok).toBe(false);
    expect(parseCapacity('1.5').ok).toBe(false);
  });
  it('skills are comma-separated short tags, lowercased, each kept once', () => {
    expect(parseSkills('Billing, kyc ,billing,')).toEqual({ ok: true, value: ['billing', 'kyc'] });
    expect(parseSkills('two words').ok).toBe(false);
  });
  it('the same routing again is refused before the click', () => {
    expect(staffRoutingGate(lead, A, '', '', null, false)).toMatchObject({ ok: false, why: 'That is already their routing.' });
    expect(staffRoutingGate(lead, A, '2', 'kyc', null, false)).toEqual({ ok: true });
    expect(staffRoutingGate({ ...lead, role: 'agent' }, A, '2', '', null, false)).toMatchObject({ ok: false });
  });
});

describe('the browser’s routing requests', () => {
  it('takes exactly the three shapes and nothing else', () => {
    expect(readActionRequest({ action: 'routing_mode', groupId: G, mode: 'load_balanced' })).toEqual({
      action: 'routing_mode',
      groupId: G,
      mode: 'load_balanced',
    });
    expect(readActionRequest({ action: 'routing_mode', groupId: G, mode: 'fast' })).toBeNull();
    expect(readActionRequest({ action: 'staff_routing', userId: A, capacity: null, skills: ['kyc'] })).not.toBeNull();
    expect(readActionRequest({ action: 'staff_routing', userId: A, capacity: -1, skills: [] })).toBeNull();
    expect(readActionRequest({ action: 'staff_routing', userId: A, capacity: 1, skills: ['Two Words'] })).toBeNull();
    expect(readActionRequest({ action: 'staff_routing', userId: A, capacity: 1, skills: ['a', 'a'] })).toBeNull();
    expect(
      readActionRequest({ action: 'staff_routing', userId: A, capacity: 1, skills: Array.from({ length: 21 }, (_, i) => `s${i}`) }),
    ).toBeNull();
    expect(readActionRequest({ action: 'ticket_skill', ticketId: T, skill: null })).toEqual({
      action: 'ticket_skill',
      ticketId: T,
      skill: null,
    });
    expect(readActionRequest({ action: 'ticket_skill', ticketId: 'x', skill: 'kyc' })).toBeNull();
  });
});
