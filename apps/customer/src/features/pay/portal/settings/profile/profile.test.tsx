import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { PortalApi } from '../../api';
import { parsePortalRoute } from '../../routes';
import { profilePatch, sensitiveChanges, toForm, validateProfile } from '../account/model';
import type { BusinessProfile, ProfileChange } from '../account/schemas';
import { failed, list, noop, plain, ready } from '../account/testing';
import { BusinessSettingsView } from './BusinessSettings';

const profile: BusinessProfile = {
  merchantId: '11111111-1111-4111-8111-111111111111',
  version: '3',
  displayName: 'TEST Shop',
  legalName: 'TEST Shop Ltd',
  address: { line1: '1 Test Street', line2: null, city: 'Testville', region: null, postalCode: 'T3ST', country: 'GB' },
  website: null,
  supportEmail: null,
  supportPhone: null,
  statementDescriptor: 'TEST SHOP',
  industry: null,
};
const change = (patch: Partial<ProfileChange>): ProfileChange => ({
  requestId: '33333333-3333-4333-8333-333333333333',
  seq: '1',
  status: 'applied',
  before: {},
  after: { website: 'https://shop.test' },
  sensitiveKeys: [],
  changeHash: 'sha256:aa',
  makerId: 'TEST-owner',
  checkerId: null,
  secondApproverId: null,
  reason: 'Add our website',
  checkerReason: null,
  createdAt: '2026-10-10T10:00:00.000Z',
  decidedAt: '2026-10-10T10:00:00.000Z',
  ...patch,
});
const base = {
  portal: {} as PortalApi,
  who: {
    merchantId: profile.merchantId,
    accountStatus: 'active',
    mode: 'gateway',
    kybStatus: 'approved',
    displayName: 'TEST Shop',
    legalName: 'TEST Shop Ltd',
  },
  profile: ready(profile),
  history: list([change({})]),
  me: 'TEST-owner',
  names: new Map<string, string>(),
  mayEdit: true,
  interactive: true,
  loadMoreHistory: noop,
  reload: noop,
};
const html = (props: Partial<Parameters<typeof BusinessSettingsView>[0]> = {}) =>
  renderToString(<BusinessSettingsView {...base} {...props} />);

describe('business details', () => {
  it('routes the business page', () => {
    expect(parsePortalRoute('/pay/settings')).toEqual({ room: 'settings' });
    expect(parsePortalRoute('/pay/settings/profile')).toEqual({ room: 'settings' });
  });
  it('groups the form and says legal details are reviewed by INTAFACED', () => {
    const out = html();
    expect(out).toContain('What customers see');
    expect(out).toContain('Legal identity');
    expect(out).toContain('Changes are reviewed by INTAFACED.');
    expect(out).toContain('Legal business name');
    expect(out).toContain('Reason *');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    plain(out);
  });
  it('shows who last changed it, with "You" for the signed-in person and no raw ids', () => {
    const out = html();
    expect(out).toContain('Last changed by You');
    expect(out).not.toContain('TEST-owner');
  });
  it('lists the change history with plain outcome words', () => {
    const out = html({
      history: list([
        change({
          status: 'pending',
          requestId: '44444444-4444-4444-8444-444444444444',
          makerId: 'TEST-finance',
          after: { statementDescriptor: 'X' },
        }),
        change({ status: 'pending_review', requestId: '55555555-5555-4555-8555-555555555555', after: { legalName: 'Y' } }),
        change({ status: 'rejected', requestId: '66666666-6666-4666-8666-666666666666' }),
      ]),
      names: new Map([['TEST-finance', 'Accounts']]),
    });
    expect(out).toContain('Waiting for a second approval from your team');
    expect(out).toContain('Waiting for INTAFACED review');
    expect(out).toContain('Not approved');
    expect(out).toContain('By Accounts');
    expect(out).toContain('A change is waiting.');
    // Someone else's pending change can be confirmed; your own can only be withdrawn.
    expect(out).toContain('Confirm change');
    expect(out).toContain('Withdraw change');
  });
  it('turns the form off with a reason for someone who may not edit, or without two-step sign-in', () => {
    expect(html({ mayEdit: false })).toContain('Only the account owner or an admin can change business details.');
    expect(html({ interactive: false })).toContain('Sign in with two-step verification to change business details.');
  });
  it('locks legal fields while verification is in review', () => {
    const out = html({ who: { ...base.who, kybStatus: 'pending' } });
    expect(out).toContain('Locked while your verification is in review.');
  });
  it('names the blocker when the details read is not switched on, and keeps the facts', () => {
    const out = html({ profile: failed('pay.not_built', 501, 'not_supported') });
    expect(out).toContain('Profile changes are not connected here');
    expect(out).toContain('TEST Shop');
    expect(out).not.toContain('Coming soon');
  });
  it('has loading and failure states for the history', () => {
    expect(html({ history: { status: 'loading' } })).toContain('aria-busy="true"');
    expect(html({ history: list([]) })).toContain('No changes yet');
  });
});

describe('business details model', () => {
  it('sends only what changed, and clears with null', () => {
    const form = { ...toForm(profile), displayName: 'TEST Shop 2', statementDescriptor: '' };
    expect(profilePatch(profile, form)).toEqual({ displayName: 'TEST Shop 2', statementDescriptor: null });
    expect(profilePatch(profile, toForm(profile))).toEqual({});
  });
  it('treats an address edit as one sensitive change', () => {
    const form = { ...toForm(profile), city: 'Otherville' };
    const patch = profilePatch(profile, form);
    expect(Object.keys(patch)).toEqual(['address']);
    expect(sensitiveChanges(patch)).toEqual(['address']);
    expect(sensitiveChanges({ displayName: 'x', website: 'https://a.test' })).toEqual([]);
  });
  it('validates web address, email, phone, country and half-filled addresses', () => {
    const form = { ...toForm(profile), website: 'http://x.test', supportEmail: 'nope', supportPhone: 'abc', country: 'gbr', line1: '' };
    const errors = validateProfile(form);
    expect(errors).toMatchObject({
      website: 'website',
      supportEmail: 'email',
      supportPhone: 'phone',
      country: 'country',
      line1: 'address',
    });
    expect(validateProfile(toForm(profile))).toEqual({});
    const blank = { ...toForm(profile), line1: '', line2: '', city: '', region: '', postalCode: '', country: '' };
    expect(validateProfile(blank)).toEqual({});
  });
});

describe('second approval and the name', () => {
  it('offers one control, never both turn-on and turn-off', () => {
    const out = html();
    // nothing tells it whether the setting is on: the page says so and offers no toggle that would guess
    expect(out).not.toContain('Turn on second approval');
    expect(out).not.toContain('Turn off second approval');
    expect(out).toContain('We can’t read this setting');
    expect(out).toContain('It can’t be changed until we can read it');
  });
  it('shows the state, and the opposite action, when the service reports it', () => {
    const on = html({ profile: ready({ ...profile, secondApprovalEnabled: true }) });
    expect(on).toContain('Second approval is on.');
    expect(on).toContain('Turn off second approval');
    expect(on).not.toContain('Turn on second approval');
    const off = html({ profile: ready({ ...profile, secondApprovalEnabled: false }) });
    expect(off).toContain('Second approval is off.');
    expect(off).toContain('Turn on second approval');
  });
  it('says nothing about the setting while the profile is still loading', () => {
    const out = html({ profile: { status: 'loading' } });
    expect(out).not.toContain('We can’t read this setting');
    expect(out).not.toContain('Second approval is');
    expect(out).not.toContain('Turn on second approval');
  });
  it('shows the name from the details on the page, not "Not set up yet"', () => {
    const out = html({ who: { ...base.who, displayName: null, legalName: null } });
    expect(out).toContain('TEST Shop');
    expect(out).not.toContain('Not set up yet');
  });
  it('says 1 change, not "1 change(s)"', () => {
    const waiting = change({ status: 'pending_review' });
    const one = html({ history: list([waiting]) });
    expect(one).toContain('1 change to your details hasn’t taken effect yet');
    expect(one).not.toMatch(/change\(s\)/);
    const two = html({ history: list([waiting, change({ status: 'pending', requestId: '44444444-4444-4444-8444-444444444444' })]) });
    expect(two).toContain('2 changes to your details haven’t taken effect yet');
  });
});
