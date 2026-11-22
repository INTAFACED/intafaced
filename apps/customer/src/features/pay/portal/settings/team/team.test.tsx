import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { PortalApi } from '../../api';
import type { Invitation, Member, MemberRole, PermissionCatalogue, TeamEvent } from '../../schemas';
import { pinOwner } from '../account/model';
import { failed, list, noop, plain, ready, refusal } from '../account/testing';
import { TeamView, InviteReview } from './Team';
import { inviteEmailOf, maskEmail, normaliseInviteEmail } from './email';

const member = (patch: Partial<Member>): Member => ({
  memberId: 'a1',
  userId: 'user-finance',
  role: 'finance',
  status: 'active',
  label: 'Accounts',
  invitedBy: 'owner-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  activatedAt: '2026-10-02T00:00:00.000Z',
  removedAt: null,
  cursor: 'c1',
  ...patch,
});
const owner = member({ memberId: null, userId: 'owner-1', role: 'owner', label: null, invitedBy: null, cursor: null });
const viewer = member({ memberId: 'a2', userId: 'user-viewer', role: 'viewer', label: 'Zed' });
const admin = member({ memberId: 'a3', userId: 'user-admin', role: 'admin', label: 'Ada' });

const props = (role: MemberRole, extra: Partial<Parameters<typeof TeamView>[0]> = {}): Parameters<typeof TeamView>[0] => ({
  portal: {} as PortalApi,
  me: ready({ merchantId: 'm', userId: 'owner-1', role }),
  myUserId: 'owner-1',
  names: new Map([['user-finance', 'Accounts']]),
  invitations: ready<Invitation[]>([]),
  catalogue: ready<PermissionCatalogue>({ roles: [], areas: [] }),
  retryCatalogue: noop,
  members: list([viewer, member({}), owner, admin]),
  history: list<TeamEvent>([
    {
      seq: '3',
      memberUserId: 'user-finance',
      action: 'role_changed',
      fromRole: 'viewer',
      toRole: 'finance',
      actorId: 'owner-1',
      createdAt: '2026-10-03T00:00:00.000Z',
    },
  ]),
  filters: { search: '', setSearch: noop, role: '', setRole: noop, status: '', setStatus: noop },
  selected: '',
  select: noop,
  loadMoreMembers: noop,
  loadMoreHistory: noop,
  refresh: noop,
  ...extra,
});
const html = (role: MemberRole, extra: Partial<Parameters<typeof TeamView>[0]> = {}) =>
  renderToString(<TeamView {...props(role, extra)} />);

describe('team', () => {
  it('pins the owner first and sorts the others by role then name', () => {
    const order = pinOwner([viewer, member({}), owner, admin], 'Team member').map((m) => m.userId);
    expect(order).toEqual(['owner-1', 'user-admin', 'user-finance', 'user-viewer']);
  });
  it('shows the owner row first in the page', () => {
    const out = html('owner');
    expect(out.indexOf('Account owner')).toBeGreaterThan(-1);
    expect(out.indexOf('You')).toBeLessThan(out.indexOf('Ada'));
    expect(out.indexOf('Ada')).toBeLessThan(out.indexOf('Accounts'));
  });
  it('has server filters (search, role, status) and no "loaded" tiles', () => {
    const out = html('owner');
    expect(out).toContain('role="search"');
    expect(out).toContain('Search');
    expect(out).toContain('>Role<');
    expect(out).not.toContain('Members loaded');
    expect(out).not.toContain('Read time is not a computation');
    plain(out);
  });
  it('never shows a raw user id as a name', () => {
    const out = html('owner');
    expect(out).not.toContain('user-viewer');
    expect(out).not.toContain('user-finance');
  });
  it('says plainly what an admin cannot do: refund, make links, send a payout, add a destination', () => {
    const out = html('owner');
    expect(out).toContain('Only the owner can refund payments, make payment links, send a payout or add a payout destination.');
    expect(out).not.toContain('Everything the owner can');
  });
  it('says role changes need a verified session', () => {
    expect(html('owner')).toContain('verified with two-step sign-in (MFA)');
  });
  it('opens a person to change their role or remove them, for someone who may', () => {
    const out = html('owner', { selected: 'a1' });
    expect(out).toContain('Manage Accounts');
    expect(out).toContain('Change role');
    expect(out).toContain('Remove');
    expect(out).toContain('Invited by');
  });
  it('locks the controls with a reason for someone who cannot manage the team', () => {
    const out = html('viewer', { selected: 'a1' });
    expect(out).not.toContain('>Change role<');
    expect(out).toContain('Only the owner or an admin can manage the team.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Send invitation<\/button>/);
  });
  it('offers pending invitations to accept or decline', () => {
    const out = html('viewer', {
      invitations: ready<Invitation[]>([{ memberId: 'i1', merchantId: 'm', role: 'developer', invitedAt: '2026-10-14T00:00:00.000Z' }]),
    });
    expect(out).toContain('Invitation to join a team as Developer');
    expect(out).toContain('>Accept<');
    expect(out).toContain('>Decline<');
  });
  it('shows team history with names, not ids', () => {
    const out = html('owner');
    expect(out).toContain('Accounts changed from Viewer to Finance');
    expect(out).toContain('By You');
  });
  it('has loading, empty, no-match and failure states', () => {
    expect(html('owner', { members: { status: 'loading' } })).toContain('aria-busy="true"');
    expect(html('owner', { members: list<Member>([]) })).toContain('No members match');
    expect(
      html('owner', {
        members: list<Member>([]),
        filters: { ...props('owner').filters, search: 'zzz' },
      }),
    ).toContain('No one matches these filters');
    expect(
      html('owner', { members: { status: 'failed', failure: refusal('pay.merchant_ops_unavailable', 503, 'unreachable') } }),
    ).toContain('Try again');
    expect(failed('x', 500).status).toBe('failed');
  });
  it('says how many rows are shown and whether more exist', () => {
    expect(html('owner', { members: list([owner, member({})], true) })).toMatch(/2 shown so far\. More are available\./);
  });
});

const pendingEmail = member({
  memberId: 'a9',
  userId: 'email:priya.n@example.com',
  role: 'viewer',
  status: 'invited',
  label: null,
  activatedAt: null,
});

describe('email invites', () => {
  it('normalises an address the way the service does, and refuses what is not one mailbox', () => {
    expect(normaliseInviteEmail('  Priya.N@Example.COM ')).toBe('priya.n@example.com');
    for (const bad of ['', 'priya', 'a@b', 'a b@example.com', 'a@@example.com', `${'x'.repeat(250)}@example.com`])
      expect(normaliseInviteEmail(bad), bad).toBeNull();
  });
  it('reads the address from a pending email member and masks it', () => {
    expect(inviteEmailOf('email:priya.n@example.com')).toBe('priya.n@example.com');
    expect(inviteEmailOf('user-viewer')).toBeNull();
    expect(maskEmail('priya.n@example.com')).toBe('p***@example.com');
  });
  it('lists a pending email invite as "Invited · masked address" and never shows the full address or the token', () => {
    const out = html('owner', { members: list([owner, pendingEmail]) });
    expect(out).toContain('Invited · p***@example.com');
    expect(out).not.toContain('priya.n@example.com');
    expect(out).not.toContain('email:');
  });
  it('opens a pending email invite with the masked address and what it waits for', () => {
    const out = html('owner', { members: list([owner, pendingEmail]), selected: 'a9' });
    expect(out).toContain('Invited email');
    expect(out).toContain('Waiting for this person to confirm that email address and accept.');
    expect(out).not.toContain('priya.n@example.com');
  });
  it('names a pending email member in the history by the masked address', () => {
    const out = html('owner', {
      history: list<TeamEvent>([
        {
          seq: '4',
          memberUserId: 'email:priya.n@example.com',
          action: 'invited',
          fromRole: null,
          toRole: 'viewer',
          actorId: 'owner-1',
          createdAt: '2026-10-03T00:00:00.000Z',
        },
      ]),
    });
    expect(out).toContain('Invited · p***@example.com was invited as Viewer');
    expect(out).not.toContain('priya.n@example.com');
  });
  it('asks for an email address first, with the account ID as the secondary way', () => {
    const out = html('owner');
    expect(out).toContain('Email address *');
    expect(out).toContain('Invite someone by email. They join after confirming that email and accepting.');
    expect(out).toContain('Invite by account ID instead');
    expect(out).not.toContain('Account ID *');
    expect(out).not.toContain('not supported');
  });
  it('lets only the owner grant admin, as the service does', () => {
    const owners = html('owner');
    const admins = html('admin');
    expect(owners.slice(owners.indexOf('id="invite"'))).toContain('<option value="admin">');
    expect(admins.slice(admins.indexOf('id="invite"'))).not.toContain('<option value="admin">');
  });
  it('shows the normalised address and the role in the review, with the wait stated', () => {
    const out = renderToString(<InviteReview email="  Priya.N@Example.com " label="" role="finance" />);
    expect(out).toContain('Invite priya.n@example.com as Finance. They join after confirming that email and accepting.');
    expect(out).toContain('<code class="pp-wrap">priya.n@example.com</code>');
    expect(out).not.toContain('Account ID');
    expect(out).not.toMatch(/has an account|no account|already/i);
  });
});

describe('invite review', () => {
  it('always shows the full account ID, with the label beside it and never instead of it', () => {
    const id = 'user-0123456789abcdef-full-account-id';
    const withLabel = renderToString(<InviteReview userId={` ${id} `} label="Sam from finance" role="developer" />);
    expect(withLabel).toContain(`<code class="pp-wrap">${id}</code>`);
    expect(withLabel).toContain('Sam from finance');
    const bare = renderToString(<InviteReview userId={id} label="" role="viewer" />);
    expect(bare).toContain(id);
    expect(bare).not.toContain('Label');
  });
});
