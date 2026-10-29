import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TicketAssignmentView, type TicketAssignmentViewProps } from './support-ticket-assignment';

const T = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const member = (userId: string, role: 'agent' | 'lead') => ({
  userId,
  role,
  appointedBy: ME,
  appointedAt: '2026-10-29T12:00:00.000Z',
  availability: 'online' as const,
  availabilitySetAt: null,
  lastHeartbeatAt: null,
});
const base = (over: Partial<TicketAssignmentViewProps> = {}): TicketAssignmentViewProps => ({
  ticket: { id: T, assigneeId: null, status: 'open' },
  userId: ME,
  staff: {
    asOf: 'x',
    meId: ME,
    roster: { kind: 'ok', data: [member(ME, 'lead'), member(AGENT, 'agent')] },
    policy: { kind: 'ok', data: { automaticOffline: 'not_set', heartbeatWindowSeconds: null } },
  },
  target: '',
  busy: false,
  outcome: null,
  onTarget: () => undefined,
  onUnclaim: () => undefined,
  onReassign: () => undefined,
  ...over,
});
const html = (over: Partial<TicketAssignmentViewProps> = {}) => renderToStaticMarkup(<TicketAssignmentView {...base(over)} />);

describe('who holds a request', () => {
  it('offers Unclaim only to the person who holds it', () => {
    expect(html()).not.toContain('>Unclaim</button>');
    expect(html({ ticket: { id: T, assigneeId: AGENT, status: 'open' } })).not.toContain('>Unclaim</button>');
    expect(html({ ticket: { id: T, assigneeId: AGENT, status: 'open' } })).toContain('only they can unclaim it');
    expect(html({ ticket: { id: T, assigneeId: ME.toUpperCase(), status: 'open' } })).toMatch(/<button[^>]*>Unclaim<\/button>/);
  });
  it('lists the staff roster by user id, and waits for a choice before Reassign', () => {
    const out = html();
    expect(out).toContain(`<option value="${AGENT}">`);
    expect(out).toContain('(you)');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Reassign<\/button>/);
    expect(html({ target: AGENT })).toMatch(/<button type="button" class="adm-btn">Reassign<\/button>/);
  });
  it('will not reassign to the person who already holds it', () => {
    const out = html({ ticket: { id: T, assigneeId: AGENT, status: 'open' }, target: AGENT });
    expect(out).toContain('That person already holds it.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Reassign<\/button>/);
  });
  it('says when the roster could not be read, and shows the service’s answer', () => {
    expect(html({ staff: null })).toContain('The staff roster could not be read');
    const done = html({ outcome: { ok: true, action: 'assign', summary: 'svc-support says the ticket is now held by x.' } });
    expect(done).toContain('data-testid="assignment-outcome"');
  });
});
