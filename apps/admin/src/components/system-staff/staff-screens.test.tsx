import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { staffAccessSchema, staffGetSchema, staffListSchema, staffRolesListSchema } from '@intafaced/contracts/identity-staff';
import type { Part } from '@/lib/desk/part';
import { identityPart, type RolesView, type RosterView, type StaffMemberView } from '@/lib/system-staff/model';
import { T_FOUNDER, T_STAFF_ID, T_STAFF_USER, tAccess, tGet, tList, tRoles, tStaff } from '@/testing/staff-fixtures';

vi.mock('next/navigation', () => ({ usePathname: () => '/system/users', useRouter: () => ({ refresh: vi.fn() }) }));

import { StaffMemberPageView } from './member';
import { StaffRolesPageView } from './roles';
import { StaffRosterView } from './roster';

const AS_OF = '2026-10-31T05:00:00.000Z';
const notBuilt = identityPart<never>({ kind: 'not_built', procedure: 'staff.list', requestId: null });
const down: Part<never> = identityPart<never>({ kind: 'unavailable', uncertain: false, requestId: null });
const ok = <T,>(data: T): Part<T> => ({ kind: 'ok', data });
const noop = () => undefined;

const rosterOk: RosterView = {
  asOf: AS_OF,
  roster: ok(staffListSchema.parse(tList())),
  roles: ok(staffRolesListSchema.parse(tRoles())),
  enrolment: ok({ open: false }),
};
const memberOk: StaffMemberView = {
  asOf: AS_OF,
  staffId: T_STAFF_ID,
  record: ok(staffGetSchema.parse(tGet())),
  access: ok(staffAccessSchema.parse(tAccess())),
  roles: ok(staffRolesListSchema.parse(tRoles())),
};

const roster = (view: RosterView | null, over: { loading?: boolean; lostReply?: boolean } = {}) =>
  renderToStaticMarkup(
    <StaffRosterView
      view={view}
      loading={over.loading ?? false}
      lostReply={over.lostReply ?? false}
      userId={T_FOUNDER}
      expiresAt="2030-01-01T00:00:00.000Z"
      onRefresh={noop}
    />,
  );
const member = (view: StaffMemberView | null, userId = T_FOUNDER) =>
  renderToStaticMarkup(<StaffMemberPageView view={view} loading={false} lostReply={false} userId={userId} onRefresh={noop} />);
const roles = (view: RolesView | null) =>
  renderToStaticMarkup(<StaffRolesPageView view={view} loading={false} lostReply={false} userId={T_FOUNDER} onRefresh={noop} />);

/** True when the button with this text is rendered and disabled. */
const disabledButton = (html: string, label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`).test(html);

describe('/system/users', () => {
  it('without identity’s roster: the refusal names svc-identity and the code, and every control is drawn switched off', () => {
    const html = roster({ asOf: AS_OF, roster: notBuilt, roles: notBuilt, enrolment: ok({ open: true }) });
    expect(html).toContain('svc-identity has no staff roster yet (OPS-admin-access-03 step 2)');
    expect(html).toContain('Owning service: svc-identity. Code: admin.staff_roster_not_built');
    expect(disabledButton(html, 'Invite unavailable')).toBe(true);
    expect(html).toMatch(/id="staff-invite-email"[^>]*disabled=""/);
    expect(html).toMatch(/id="staff-invite-name"[^>]*disabled=""/);
    expect(html).not.toContain('roster-table');
    expect(html).not.toContain('roster-empty');
    // The founder screen this page replaces still shows who is signed in and the enrolment door.
    expect(html).toContain(T_FOUNDER);
    expect(html).toContain('Enrolment door open · invite required');
  });

  it('identity down is an error naming svc-identity, never an empty roster', () => {
    const html = roster({ asOf: AS_OF, roster: down, roles: down, enrolment: down });
    expect(html).toContain('The staff roster unavailable');
    expect(html).toContain('svc-identity did not answer.');
    expect(html).not.toContain('roster-empty');
  });

  it('an empty roster is said in words, and the invite form is open', () => {
    const html = roster({ ...rosterOk, roster: ok(staffListSchema.parse(tList([]))) });
    expect(html).toContain('svc-identity holds no staff members');
    expect(html).not.toContain('Invite unavailable');
    expect(html).toContain('Write the person’s email and display name first.');
    expect(html).not.toMatch(/invite link|share link|copy link/i);
  });

  it('the roster shows each row svc-identity stores, linked to its page; built-in roles cannot be picked', () => {
    const html = roster(rosterOk);
    expect(html).toContain('TEST Staff One');
    expect(html).toContain(`href="/system/users/${T_STAFF_ID}"`);
    expect(html).toContain('TEST ops reader');
    expect(html).toContain('never signed in');
    expect(html).toContain('compliance (builtin) · mapping not set by the owner (identity.role_mapping_unset)');
    expect(html).toMatch(/<input type="checkbox" disabled=""[^>]*\/> compliance/);
  });

  it('loading and recovery say what they are', () => {
    expect(roster(rosterOk, { loading: true })).toContain('Reading svc-identity…');
    const html = roster(rosterOk, { lostReply: true });
    expect(html).toContain('The last reply was lost, so this page read svc-identity again');
    expect(html).toContain('same request id');
    expect(roster(null)).toContain('svc-identity could not be read');
  });
});

describe('/system/users/:userId', () => {
  it('without identity’s roster: refusals for the record and the access overview, and every change drawn off', () => {
    const html = member({ asOf: AS_OF, staffId: T_STAFF_ID, record: notBuilt, access: notBuilt, roles: notBuilt });
    expect(html.match(/admin\.staff_roster_not_built/g)?.length).toBeGreaterThanOrEqual(2);
    for (const label of ['Assign unavailable', 'Unassign unavailable', 'Disable unavailable'])
      expect(disabledButton(html, label)).toBe(true);
    expect(html).toContain('>Remove</button>');
    expect(html).not.toContain('access-table');
  });

  it('shows the record, the roles held and the access overview with each permission’s source', () => {
    const html = member(memberOk);
    expect(html).toContain('TEST Staff One');
    expect(html).toContain(T_STAFF_USER);
    expect(html).toContain('staff:ledger:read:production');
    expect(html).toContain('denied (explicit deny wins)');
    expect(html).toContain('Not offered for assignment: founder, compliance, mapping not set by the owner (identity.role_mapping_unset).');
    // The only defined role is held already, so assign has nothing to offer; built-in roles are never options.
    expect(disabledButton(html, 'Assign unavailable')).toBe(true);
    expect(html).not.toMatch(/<option value="builtin:/);
    expect(html).toContain('Take TEST ops reader away from TEST Staff One');
  });

  it('nobody changes their own roles or status', () => {
    const html = member(memberOk, T_STAFF_USER);
    expect(html).toContain('identity.staff_self_grant');
    expect(disabledButton(html, 'Unassign unavailable')).toBe(true);
    expect(disabledButton(html, 'Disable unavailable')).toBe(true);
  });

  it('a disabled member cannot be disabled again, and no permission is an honest empty overview', () => {
    const view: StaffMemberView = {
      ...memberOk,
      record: ok(staffGetSchema.parse({ ...tGet(), staff: tStaff({ status: 'disabled', disabledAt: AS_OF }) })),
      access: ok(staffAccessSchema.parse({ ...tAccess(), permissions: [] })),
    };
    const html = member(view);
    expect(html).toContain('This staff member is already disabled.');
    expect(html).toContain('No role gives this person any permission, so everything is denied.');
  });
});

describe('/system/roles', () => {
  it('without identity’s roster the editor is drawn and switched off with the reason', () => {
    const html = roles({ asOf: AS_OF, roles: notBuilt });
    expect(html).toContain('Code: admin.staff_roster_not_built');
    expect(disabledButton(html, 'Define role unavailable')).toBe(true);
    expect(html).toMatch(/<fieldset class="dk-stack" disabled="">/);
    expect(html).toContain('data-testid="role-grid-ledger"');
  });

  it('built-in roles show the unset mapping; custom roles show what they allow and deny', () => {
    const html = roles({ asOf: AS_OF, roles: ok(staffRolesListSchema.parse(tRoles())) });
    expect(html.match(/data-testid="role-mapping-unset"/g)).toHaveLength(2);
    expect(html).toContain('mapping not set by the owner (identity.role_mapping_unset)');
    expect(html).toContain('staff:ledger:write:production');
    expect(html).toContain('Redefine TEST ops reader (version 2)');
    expect(html).toContain('Name the role first.');
  });

  it('no roles is said in words', () => {
    expect(roles({ asOf: AS_OF, roles: ok({ roles: [], asOf: AS_OF }) })).toContain('svc-identity holds no roles.');
  });
});
