import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffDirectoryRow } from '@/lib/support/staff';
import type { SupportStaffView } from '@/lib/support/types';
import { StaffPanelView, emptyStaffForm, type StaffPanelViewProps } from './support-staff-panel';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const m = (userId: string, over: Partial<StaffDirectoryRow> = {}): StaffDirectoryRow => ({
  userId,
  role: 'agent',
  appointedBy: B,
  appointedAt: '2026-10-20T01:00:00.000Z',
  availability: 'offline',
  availabilitySetAt: null,
  lastHeartbeatAt: null,
  groups: [],
  ...over,
});
const view = (over: Partial<SupportStaffView> = {}): SupportStaffView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  meId: A,
  roster: { kind: 'ok', data: [m(A, { availability: 'online' }), m(B)] } as SupportStaffView['roster'],
  policy: { kind: 'ok', data: { automaticOffline: 'not_set', heartbeatWindowSeconds: null } } as SupportStaffView['policy'],
  routing: { kind: 'ok', data: { groups: [], staff: [], sweepSeconds: null } } as SupportStaffView['routing'],
  log: { kind: 'ok', data: [] } as SupportStaffView['log'],
  ...over,
});
const base = (over: Partial<StaffPanelViewProps> = {}): StaffPanelViewProps => ({
  view: view(),
  loading: false,
  form: emptyStaffForm,
  armed: null,
  busy: false,
  outcome: null,
  onField: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  onRefresh: () => undefined,
  ...over,
});
const html = (p: StaffPanelViewProps) => renderToStaticMarkup(<StaffPanelView {...p} />);

describe('the staff panel', () => {
  it('lists the roster, marks the signed-in person and says automatic offline is unset', () => {
    const out = html(base());
    expect(out).toContain(`data-testid="staff-${A}"`);
    expect(out).toContain('(you)');
    expect(out).toContain('Automatic offline is not set');
  });
  it('an empty roster is said once, not drawn as a table', () => {
    const out = html(base({ view: view({ roster: { kind: 'ok', data: [] } as SupportStaffView['roster'] }) }));
    expect(out).toContain('data-testid="staff-none"');
    expect(out).not.toContain('<table');
  });
  it('a refused roster is shown as a refusal, never as no staff', () => {
    const failed = { kind: 'failed', forbidden: true, message: 'denied', code: null } as SupportStaffView['roster'];
    const out = html(base({ view: view({ roster: failed }) }));
    expect(out).toContain('Staff list unavailable');
    expect(out).not.toContain('data-testid="staff-none"');
  });
  it('a read that failed outright says so', () => {
    expect(html(base({ view: null }))).toContain('could not be read');
  });
  it('someone not on the list can read but is told they cannot set', () => {
    const out = html(base({ view: view({ meId: '33333333-3333-4333-8333-333333333333' }) }));
    expect(out).toContain('data-testid="staff-not-me"');
  });
  it('asks a second click before anything is sent', () => {
    expect(html(base({ form: { ...emptyStaffForm, availability: 'busy' }, armed: 'availability' }))).toContain('Yes, set busy');
  });
  it('lists each person’s groups (teams), or None', () => {
    const roster = {
      kind: 'ok',
      data: [
        m(A, {
          groups: [
            { id: 'g1', name: 'Billing' },
            { id: 'g2', name: 'Payments' },
          ],
        }),
        m(B),
      ],
    } as SupportStaffView['roster'];
    const out = html(base({ view: view({ roster }) }));
    expect(out).toContain('Groups (teams)');
    expect(out).toContain('Billing, Payments');
    expect(out).toMatch(new RegExp(`data-testid="staff-groups-${B}">None<`));
  });
  it('shows capacity and skills, and a blank capacity as never assigned automatically', () => {
    const routing = {
      kind: 'ok',
      data: { groups: [], staff: [{ userId: A, capacity: 3, skills: ['billing', 'kyc'] }], sweepSeconds: null },
    } as SupportStaffView['routing'];
    const out = html(base({ view: view({ routing }) }));
    expect(out).toMatch(new RegExp(`data-testid="staff-capacity-${A}">3<`));
    expect(out).toContain('billing, kyc');
    expect(out).toMatch(new RegExp(`data-testid="staff-capacity-${B}">Capacity not set: never assigned automatically<`));
  });
  it('a refused routing read is a refusal, never "not set"', () => {
    const failed = { kind: 'failed', forbidden: false, message: 'down', code: null } as SupportStaffView['routing'];
    const out = html(base({ view: view({ routing: failed }) }));
    expect(out).toContain('Routing (capacity and skills) unavailable');
    expect(out).not.toContain('Capacity not set');
  });
  it('a lead reviews routing, then confirms it', () => {
    const lead = { kind: 'ok', data: [m(A, { role: 'lead' }), m(B)] } as SupportStaffView['roster'];
    const form = { ...emptyStaffForm, routingTarget: B, capacity: '2', skills: 'billing' };
    const ready = html(base({ view: view({ roster: lead }), form }));
    expect(ready).toContain('Review routing');
    expect(ready).not.toContain('Only a lead can change routing.');
    const armed = html(base({ view: view({ roster: lead }), form, armed: 'routing' }));
    expect(armed).toContain('Yes, save routing');
    expect(armed).toContain('Capacity: 2. Skills: billing.');
  });
  it('an agent is told only a lead sets routing', () => {
    const out = html(base({ form: { ...emptyStaffForm, routingTarget: B, capacity: '2' } }));
    expect(out).toContain('data-testid="staff-routing-not-lead"');
    expect(out).toContain('Only a lead can change routing.');
  });
  it('shows the availability log with who set it and the reason, or that none was given', () => {
    const log = {
      kind: 'ok',
      data: [
        { userId: B, availability: 'busy', by: A, reason: 'lunch cover', at: '2026-10-20T02:00:00.000Z' },
        { userId: B, availability: 'online', by: B, reason: null, at: '2026-10-20T03:00:00.000Z' },
      ],
    } as SupportStaffView['log'];
    const out = html(base({ view: view({ log }) }));
    expect(out).toContain('data-testid="staff-log"');
    expect(out).toContain('lunch cover');
    expect(out).toContain('No reason given');
  });
  it('a refused log is a refusal, never an empty log', () => {
    const log = { kind: 'failed', forbidden: false, message: 'down', code: null } as SupportStaffView['log'];
    const out = html(base({ view: view({ log }) }));
    expect(out).toContain('Availability log unavailable');
    expect(out).not.toContain('data-testid="staff-log-none"');
  });
});
