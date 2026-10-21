import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffMemberView } from '@/lib/support/staff';
import type { SupportGroupsView } from '@/lib/support/types';
import { GroupsPanelView, emptyGroupsForm, type GroupsPanelViewProps } from './support-groups-panel';

const A = '11111111-1111-4111-8111-111111111111';
const G = '33333333-3333-4333-8333-333333333333';
const staff = (userId: string, role: 'agent' | 'lead'): StaffMemberView => ({
  userId,
  role,
  appointedBy: A,
  appointedAt: '2026-10-20T01:00:00.000Z',
  availability: 'online',
  availabilitySetAt: null,
  lastHeartbeatAt: null,
});
const view = (over: Partial<SupportGroupsView> = {}, role: 'agent' | 'lead' = 'lead'): SupportGroupsView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  meId: A,
  groups: {
    kind: 'ok',
    data: [{ id: G, name: 'Payments', createdBy: A, createdAt: '2026-10-20T01:00:00.000Z', memberIds: [A] }],
  } as SupportGroupsView['groups'],
  scope: {
    kind: 'ok',
    data: { restricted: true, groups: [{ id: G, name: 'Payments' }], seesAllGroups: false },
  } as SupportGroupsView['scope'],
  roster: { kind: 'ok', data: [staff(A, role)] } as SupportGroupsView['roster'],
  ...over,
});
const base = (over: Partial<GroupsPanelViewProps> = {}): GroupsPanelViewProps => ({
  view: view(),
  loading: false,
  form: emptyGroupsForm,
  armed: null,
  busy: false,
  outcome: null,
  onField: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  onRefresh: () => undefined,
  ...over,
});
const html = (p: GroupsPanelViewProps) => renderToStaticMarkup(<GroupsPanelView {...p} />);
const failed = { kind: 'failed', forbidden: true, message: 'denied', code: null };

describe('the groups panel', () => {
  it('lists groups and says what this person sees', () => {
    const out = html(base());
    expect(out).toContain(`data-testid="group-${G}"`);
    expect(out).toContain('You see the tickets in Payments');
  });
  it('no groups is said once, with what making the first one does', () => {
    const out = html(base({ view: view({ groups: { kind: 'ok', data: [] } as SupportGroupsView['groups'] }) }));
    expect(out).toContain('data-testid="groups-none"');
    expect(out).toContain('starts restricting');
  });
  it('a refused read is a refusal, never "no groups"', () => {
    const out = html(base({ view: view({ groups: failed as SupportGroupsView['groups'] }) }));
    expect(out).toContain('Groups unavailable');
    expect(out).not.toContain('data-testid="groups-none"');
    expect(out).toContain('could not be read');
  });
  it('a failed read outright says so', () => {
    expect(html(base({ view: null }))).toContain('could not be read');
  });
  it('an agent can read but is told only a lead changes groups', () => {
    const out = html(base({ view: view({}, 'agent'), form: { ...emptyGroupsForm, name: 'KYC' } }));
    expect(out).toContain('data-testid="groups-not-lead"');
    expect(out).toContain('Only a lead can make or change groups.');
  });
  it('asks a second click before anything is sent', () => {
    expect(html(base({ form: { ...emptyGroupsForm, name: 'KYC' }, armed: 'save' }))).toContain('Make the group KYC?');
    expect(html(base({ form: { ...emptyGroupsForm, memberGroup: G, memberUser: A, op: 'remove' }, armed: 'member' }))).toContain(
      'Yes, remove them',
    );
  });
});
