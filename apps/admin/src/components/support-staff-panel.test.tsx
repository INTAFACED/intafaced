import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffMemberView } from '@/lib/support/staff';
import type { SupportStaffView } from '@/lib/support/types';
import { StaffPanelView, emptyStaffForm, type StaffPanelViewProps } from './support-staff-panel';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const m = (userId: string, over: Partial<StaffMemberView> = {}): StaffMemberView => ({
  userId,
  role: 'agent',
  appointedBy: B,
  appointedAt: '2026-10-20T01:00:00.000Z',
  availability: 'offline',
  availabilitySetAt: null,
  lastHeartbeatAt: null,
  ...over,
});
const view = (over: Partial<SupportStaffView> = {}): SupportStaffView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  meId: A,
  roster: { kind: 'ok', data: [m(A, { availability: 'online' }), m(B)] } as SupportStaffView['roster'],
  policy: { kind: 'ok', data: { automaticOffline: 'not_set', heartbeatWindowSeconds: null } } as SupportStaffView['policy'],
  ...over,
});
const base = (over: Partial<StaffPanelViewProps> = {}): StaffPanelViewProps => ({
  view: view(),
  loading: false,
  form: emptyStaffForm,
  armed: false,
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
    expect(html(base({ form: { ...emptyStaffForm, availability: 'busy' }, armed: true }))).toContain('Yes, set busy');
  });
});
