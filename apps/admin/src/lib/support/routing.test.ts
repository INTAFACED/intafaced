import { describe, expect, it } from 'vitest';
import { recordReads } from './record-reply';
import {
  SUPPORT_DESK_AVAILABILITY_LOG,
  SUPPORT_DESK_GROUPS_LOG,
  SUPPORT_DESK_ROUTING_OVERVIEW,
  SUPPORT_DESK_ROUTING_SET_MODE,
  SUPPORT_DESK_ROUTING_WAITING,
  SUPPORT_DESK_TICKET_ROUTING,
  SUPPORT_DESK_TICKET_SET_SKILL,
} from '@intafaced/contracts/support-desk-procedures';
import { readActionRequest } from './model';
import { groupLogRows, modeWords, parseCapacity, parseSkills, requiredSkillResult, staffRoutingGate } from './routing';
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
    expect(recordReads(SUPPORT_DESK_ROUTING_OVERVIEW, good)).toEqual(good);
    expect(recordReads(SUPPORT_DESK_ROUTING_OVERVIEW, { ...good, groups: [{ ...good.groups[0], mode: 'random' }] })).toBeNull();
    expect(recordReads(SUPPORT_DESK_ROUTING_OVERVIEW, { ...good, staff: [{ userId: A, capacity: 1.5, skills: [] }] })).toBeNull();
    expect(recordReads(SUPPORT_DESK_ROUTING_OVERVIEW, { ...good, sweepSeconds: 0 })).toBeNull();
  });
  it('a request’s routing carries the code exactly when no agent could take it', () => {
    expect(
      recordReads(SUPPORT_DESK_TICKET_ROUTING, {
        ticketId: T,
        requiredSkill: 'kyc',
        state: 'no_agent',
        code: 'support.no_agent_available',
        stateAt: at,
      }),
    ).not.toBeNull();
    expect(
      recordReads(SUPPORT_DESK_TICKET_ROUTING, { ticketId: T, requiredSkill: null, state: 'no_agent', code: null, stateAt: at }),
    ).toBeNull();
    expect(
      recordReads(SUPPORT_DESK_TICKET_ROUTING, {
        ticketId: T,
        requiredSkill: null,
        state: 'assigned',
        code: 'support.no_agent_available',
        stateAt: at,
      }),
    ).toBeNull();
  });
  it('reads the waiting list, the availability log and the group log strictly', () => {
    expect(recordReads(SUPPORT_DESK_ROUTING_WAITING, [{ ticketId: T, code: 'support.no_agent_available', since: null }])).toHaveLength(1);
    expect(recordReads(SUPPORT_DESK_ROUTING_WAITING, [{ ticketId: T, code: 'other', since: null }])).toBeNull();
    expect(recordReads(SUPPORT_DESK_AVAILABILITY_LOG, [{ userId: A, availability: 'busy', by: A, reason: null, at }])).toHaveLength(1);
    expect(recordReads(SUPPORT_DESK_AVAILABILITY_LOG, [{ userId: A, availability: 'away', by: A, reason: null, at }])).toBeNull();
    const groupLog = (action: string) => {
      const rows = recordReads(SUPPORT_DESK_GROUPS_LOG, [{ groupId: G, action, subject: null, by: A, at }]);
      return rows === null ? null : groupLogRows(rows);
    };
    expect(groupLog('created')).toHaveLength(1);
    // An action this console has no words for is the desk's own refusal: the whole log is unread.
    expect(groupLog('deleted')).toBeNull();
  });
  it('reads write answers strictly: an unknown outcome is not read as done', () => {
    const routing = { groupId: G, mode: 'round_robin', cursorUserId: null, revision: 1, setBy: A, setAt: at };
    expect(
      recordReads(SUPPORT_DESK_ROUTING_SET_MODE, {
        routing,
        routed: [{ status: 'queued', ticketId: T, groupId: G, code: 'support.no_agent_available' }],
      }),
    ).not.toBeNull();
    expect(recordReads(SUPPORT_DESK_ROUTING_SET_MODE, { routing, routed: [{ status: 'maybe', ticketId: T }] })).toBeNull();
    const skillReply = recordReads(SUPPORT_DESK_TICKET_SET_SKILL, {
      routing: { ticketId: T, requiredSkill: 'kyc', state: 'assigned', stateAt: at },
      outcome: { status: 'assigned', ticketId: T, assigneeId: A, groupId: G, mode: 'load_balanced' },
    });
    expect(skillReply && requiredSkillResult(skillReply)).toMatchObject({ requiredSkill: 'kyc' });
    expect(
      recordReads(SUPPORT_DESK_TICKET_SET_SKILL, { routing: { ticketId: T, requiredSkill: 'kyc', state: 'assigned', stateAt: at } }),
    ).toBeNull();
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
