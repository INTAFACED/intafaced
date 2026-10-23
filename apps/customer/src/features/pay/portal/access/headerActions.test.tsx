import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { ApiClient } from '../../../../shared/api';
import { createBusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { PortalFrame } from '../MerchantPortal';
import { allows, type Access } from './resolve';
import { ROLE_CAPABILITIES } from './capabilities';
import { headerActionReason } from './headerActions';

// TEST data only: nobody here is real.
const ME = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const authority = (scopes: string[]): PayBusinessAuthority => ({
  verified: true,
  companyId: MERCHANT,
  companyName: 'TEST Coffee',
  userId: ME,
  merchantId: MERCHANT,
  scopes,
});
const payFor = (a: PayBusinessAuthority | null) => createBusinessPayApi({} as ApiClient, ME, a);
const ready = (role: 'owner' | 'viewer' | 'admin'): Access => ({
  status: 'ready',
  source: 'my-access',
  merchantId: MERCHANT,
  role,
  accountStatus: 'active',
  kybStatus: 'approved',
  mode: 'gateway',
  sessionInteractive: true,
  displayName: null,
  legalName: null,
  pricingVisibility: null,
  capabilities: ROLE_CAPABILITIES[role],
});
const value = (access: Access) => ({ access, can: (need: Parameters<typeof allows>[1]) => allows(access, need) });
const OWNER_SCOPES = ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'];

describe('header actions follow the same scope check as the page buttons', () => {
  it('lets the owner issue a refund, request a payout and create a link', () => {
    const pay = payFor(authority(OWNER_SCOPES));
    for (const room of ['refunds', 'payouts', 'money', 'settlements', 'payout-destinations', 'links', 'payments', 'dashboard'] as const)
      expect(headerActionReason(room, value(ready('owner')), pay), room).toBeNull();
  });
  it('lets an owner open every refund and payout action: the confirmation is asked when it is opened', () => {
    // An owner session as identity mints it today: read and write, no refund and no payout. The money scopes come from
    // confirming it's them, so the owner's controls are on.
    const pay = payFor({ ...authority(['pay:read', 'pay:write']), confirmable: ['pay:refund', 'pay:payout'] });
    for (const room of ['refunds', 'payouts', 'money', 'settlements', 'payout-destinations', 'links', 'payments', 'dashboard'] as const)
      expect(headerActionReason(room, value(ready('owner')), pay), room).toBeNull();
  });
  it('says who can when the person cannot confirm a payment, in the present tense', () => {
    const pay = payFor(authority(['pay:read', 'pay:write']));
    // Refunds and sending a payout are the owner's alone.
    expect(headerActionReason('refunds', value(ready('admin')), pay)).toBe('Only the account owner can refund payments.');
    expect(headerActionReason('payout-destinations', value(ready('admin')), pay)).toBe('Only the account owner can send payouts.');
    // The pages that ask for a payout follow the role's permission: admins (and finance) may, a viewer may not.
    for (const room of ['payouts', 'money', 'settlements'] as const) {
      expect(headerActionReason(room, value(ready('admin')), pay), room).toBeNull();
      expect(headerActionReason(room, value(ready('viewer')), pay), room).toBe(
        'Only the account owner, admins and finance can ask for a payout or take a request back.',
      );
    }
    // Making a link and the other ordinary writes stay on.
    for (const room of ['links', 'payments', 'dashboard'] as const)
      expect(headerActionReason(room, value(ready('owner')), pay), room).toBeNull();
  });
  it('says why an owner cannot, when the account is not active or the session is an API key', () => {
    const pay = payFor(authority(['pay:read']));
    expect(
      headerActionReason(
        'refunds',
        value({ ...(ready('owner') as Extract<Access, { status: 'ready' }>), accountStatus: 'suspended' }),
        pay,
      ),
    ).toBe('Refunds and payouts open once your business account is active.');
    expect(
      headerActionReason('payouts', value({ ...(ready('owner') as Extract<Access, { status: 'ready' }>), sessionInteractive: false }), pay),
    ).toBe('API keys and sub-accounts cannot confirm a payment.');
  });
  it('switches the action off when there is no authority at all (a team member) or no pay api', () => {
    expect(headerActionReason('refunds', value(ready('viewer')), payFor(null))).toBeTruthy();
    expect(headerActionReason('links', value(ready('owner')), null)).toBeTruthy();
  });
  it('gates "Invite" on the team permission', () => {
    expect(headerActionReason('team', value(ready('viewer')), payFor(null))).toMatch(/role/);
    expect(headerActionReason('team', value(ready('admin')), payFor(null))).toBeNull();
  });
  it('switches the action off while access is not ready, and leaves plain links alone', () => {
    expect(headerActionReason('refunds', value({ status: 'loading' }), payFor(authority(OWNER_SCOPES)))).toBeTruthy();
    expect(headerActionReason('conversion-new', value({ status: 'loading' }), null)).toBeNull();
    expect(headerActionReason('refund-new', value(ready('viewer')), null)).toBeNull();
  });
});

describe('the page header', () => {
  const draw = (actionReason?: string | null) =>
    renderToStaticMarkup(
      <PortalFrame route={{ room: 'refunds' }} actionReason={actionReason}>
        <p>body</p>
      </PortalFrame>,
    );
  it('shows the action as a disabled button with its reason when it is off', () => {
    const out = draw('This Business account does not hold pay:refund permission.');
    expect(out).toContain('does not hold pay:refund permission');
    expect(out).toContain('Issue a refund');
    expect(out).not.toContain('href="/pay/refunds/new"');
    expect(out).toMatch(/<button\b[^>]*\bdisabled\b/);
  });
  it('shows the working link when nothing blocks it', () => {
    expect(draw(null)).toContain('href="/pay/refunds/new"');
  });
});
