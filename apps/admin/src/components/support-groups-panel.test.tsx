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
  routing: {
    kind: 'ok',
    data: {
      groups: [{ groupId: G, name: 'Payments', mode: null, cursorUserId: null, setBy: null, setAt: null }],
      staff: [],
      sweepSeconds: null,
    },
  } as SupportGroupsView['routing'],
  ...over,
});
const routed = (mode: 'off' | 'round_robin' | 'load_balanced' | null, cursorUserId: string | null = null) =>
  ({
    kind: 'ok',
    data: {
      groups: [
        { groupId: G, name: 'Payments', mode, cursorUserId, setBy: mode ? A : null, setAt: mode ? '2026-10-20T02:00:00.000Z' : null },
      ],
      staff: [],
      sweepSeconds: null,
    },
  }) as SupportGroupsView['routing'];
const base = (over: Partial<GroupsPanelViewProps> = {}): GroupsPanelViewProps => ({
  view: view(),
  loading: false,
  form: emptyGroupsForm,
  armed: null,
  busy: false,
  outcome: null,
  log: null,
  loadingLog: false,
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
  it('with no groups, says visibility is not restricted in exactly these words', () => {
    const out = html(
      base({
        view: view({
          groups: { kind: 'ok', data: [] } as SupportGroupsView['groups'],
          scope: { kind: 'ok', data: { restricted: false, groups: [], seesAllGroups: false } } as SupportGroupsView['scope'],
        }),
      }),
    );
    expect(out).toContain('Visibility is not restricted: no groups are set up, so the whole desk sees every ticket.');
  });
  it('shows each group’s routing in words, and who was last given a request', () => {
    expect(html(base())).toContain('Not set');
    expect(html(base({ view: view({ routing: routed('off') }) }))).toContain('>Off<');
    expect(html(base({ view: view({ routing: routed('load_balanced') }) }))).toContain('Least loaded');
    const out = html(base({ view: view({ routing: routed('round_robin', A) }) }));
    expect(out).toContain('In turn');
    expect(out).toContain(`Last assigned to ${A}`);
  });
  it('a refused routing read is a refusal, never "not set"', () => {
    const out = html(base({ view: view({ routing: failed as SupportGroupsView['routing'] }) }));
    expect(out).toContain('Routing unavailable');
    expect(out).toContain('Not read');
    expect(out).not.toContain('Not set');
  });
  it('a lead sets routing with a second click; the same mode again is refused before the click', () => {
    const armed = html(base({ form: { ...emptyGroupsForm, routingGroup: G, routingMode: 'round_robin' }, armed: 'routing' }));
    expect(armed).toContain('Set Payments’s routing to In turn?');
    expect(armed).toContain('Yes, set routing');
    const same = html(base({ view: view({ routing: routed('round_robin') }), form: { ...emptyGroupsForm, routingGroup: G } }));
    expect(same).toContain('Routing is already In turn.');
  });
  it('an agent is told only a lead changes routing', () => {
    const out = html(base({ view: view({}, 'agent'), form: { ...emptyGroupsForm, routingGroup: G } }));
    expect(out).toContain('data-testid="groups-routing-not-lead"');
    expect(out).toContain('Only a lead can change routing.');
  });
  it('shows the picked group’s log in words, oldest first', () => {
    const out = html(
      base({
        form: { ...emptyGroupsForm, logGroup: G },
        log: {
          asOf: '2026-10-20T04:00:00.000Z',
          groupId: G,
          log: {
            kind: 'ok',
            data: [
              { groupId: G, action: 'created', subject: null, by: A, at: '2026-10-20T01:00:00.000Z' },
              { groupId: G, action: 'member_added', subject: A, by: A, at: '2026-10-20T01:01:00.000Z' },
              { groupId: G, action: 'ticket_grouped', subject: 'T-1', by: A, at: '2026-10-20T01:02:00.000Z' },
              { groupId: G, action: 'ticket_ungrouped', subject: 'T-1', by: A, at: '2026-10-20T01:03:00.000Z' },
            ],
          },
        },
      }),
    );
    expect(out).toContain('data-testid="groups-log"');
    for (const w of ['Created', 'Member added', 'Request placed', 'Request taken out']) expect(out).toContain(w);
    expect(out.indexOf('Created')).toBeLessThan(out.indexOf('Request taken out'));
  });
  it('a refused group log is a refusal, never an empty log', () => {
    const out = html(
      base({
        form: { ...emptyGroupsForm, logGroup: G },
        log: { asOf: '2026-10-20T04:00:00.000Z', groupId: G, log: failed as never },
      }),
    );
    expect(out).toContain('Group log unavailable');
    expect(out).not.toContain('data-testid="groups-log-none"');
  });
});
