import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffMemberView } from '@/lib/support/staff';
import type { TicketRoutingView as Routing } from '@/lib/support/routing';
import type { SupportTicketRoutingView } from '@/lib/support/types';
import { TicketRoutingView, type TicketRoutingViewProps } from './support-ticket-routing';

const A = '11111111-1111-4111-8111-111111111111';
const T = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-20T04:00:00.000Z';
const staff = (role: 'agent' | 'lead'): StaffMemberView => ({
  userId: A,
  role,
  appointedBy: A,
  appointedAt: at,
  availability: 'online',
  availabilitySetAt: null,
  lastHeartbeatAt: null,
});
const routing = (over: Partial<Routing> = {}): Routing => ({
  ticketId: T,
  requiredSkill: null,
  state: null,
  code: null,
  stateAt: null,
  ...over,
});
const view = (r: Routing = routing(), role: 'agent' | 'lead' = 'lead'): SupportTicketRoutingView => ({
  asOf: at,
  meId: A,
  routing: { kind: 'ok', data: r },
  roster: { kind: 'ok', data: [staff(role)] },
});
const base = (over: Partial<TicketRoutingViewProps> = {}): TicketRoutingViewProps => ({
  view: view(),
  loading: false,
  skill: '',
  armed: false,
  busy: false,
  outcome: null,
  onSkill: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  ...over,
});
const html = (p: TicketRoutingViewProps) => renderToStaticMarkup(<TicketRoutingView {...p} />);

describe('a request’s routing card', () => {
  it('says no skill is needed and the request is not routed', () => {
    const out = html(base());
    expect(out).toContain('data-testid="ticket-routing"');
    expect(out).toContain('No skill needed');
    expect(out).toContain('Not routed');
  });
  it('says when it was assigned automatically', () => {
    expect(html(base({ view: view(routing({ requiredSkill: 'kyc', state: 'assigned', stateAt: at })) }))).toContain(
      'Assigned automatically',
    );
  });
  it('shows svc-support’s code when no agent can take it', () => {
    const out = html(
      base({ view: view(routing({ requiredSkill: 'kyc', state: 'no_agent', code: 'support.no_agent_available', stateAt: at })) }),
    );
    expect(out).toContain('No agent available');
    expect(out).toContain('support.no_agent_available');
    expect(out).toContain('>kyc<');
  });
  it('a lead reviews the skill, then confirms it', () => {
    expect(html(base({ skill: 'kyc' }))).toContain('Review skill');
    const armed = html(base({ skill: 'kyc', armed: true }));
    expect(armed).toContain('Make this request need kyc?');
    expect(armed).toContain('Yes, set skill');
  });
  it('clearing a set skill is its own question; the same skill again is refused before the click', () => {
    expect(html(base({ view: view(routing({ requiredSkill: 'kyc' })), skill: '', armed: true }))).toContain('Clear the required skill?');
    expect(html(base({ view: view(routing({ requiredSkill: 'kyc' })), skill: 'kyc' }))).toContain('It already needs kyc.');
  });
  it('an agent is told only a lead changes routing', () => {
    const out = html(base({ view: view(routing(), 'agent'), skill: 'kyc' }));
    expect(out).toContain('data-testid="routing-not-lead"');
  });
  it('a refused read is a refusal, never "not routed"', () => {
    const failed = { kind: 'failed', forbidden: false, message: 'down', code: null, notBuilt: false } as const;
    const out = html(base({ view: { ...view(), routing: failed } }));
    expect(out).toContain('Routing unavailable');
    expect(out).not.toContain('Not routed');
  });
});
