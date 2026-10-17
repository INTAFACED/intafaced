import { describe, expect, it } from 'vitest';
import type { Resource } from '../../../../shared/resource';
import { authorityFromAccess } from './authority';
import { allows, canOwnerWrite, resolveAccess, type AccessInputs } from './resolve';
import type { MerchantRecord } from '../schemas';
import type { Membership, MyAccess } from './schemas';

// TEST DATA: none of these people, businesses or ids is real.
const ME = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const record = (patch: Partial<MerchantRecord> = {}): MerchantRecord => ({
  id: MERCHANT,
  userId: ME,
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: null,
  feeBps: null,
  ...patch,
});
const ready = <T>(data: T): Resource<T> => ({ status: 'ready', data });
const loading: Resource<never> = { status: 'loading' };
const failure = (reason: 'not_mounted' | 'forbidden' | 'unreachable', code?: string) =>
  ({ status: 'failed', failure: { ok: false, reason, message: 'x', ...(code ? { code } : {}) } }) as Resource<never>;
const notLive = failure('not_mounted');
const membership = (patch: Partial<Membership> = {}): Membership => ({
  merchantId: MERCHANT,
  role: 'owner',
  status: 'active',
  kybStatus: 'approved',
  verified: true,
  sessionInteractive: true,
  mode: 'gateway',
  displayName: 'TEST Coffee',
  legalName: 'TEST Coffee Ltd',
  capabilities: { 'payments.read': true, 'payout.request': true },
  pricingVisibility: 'full',
  ...patch,
});
const inputs = (patch: Partial<AccessInputs> = {}): AccessInputs => ({
  sessionUserId: ME,
  myAccess: notLive as Resource<MyAccess>,
  merchant: ready<MerchantRecord | null>(null),
  team: failure('forbidden', 'pay.merchant_ops_not_merchant') as AccessInputs['team'],
  ...patch,
});

describe('business access: the service answers', () => {
  it('takes the first membership as the business, with only the flags that are true', () => {
    const access = resolveAccess(inputs({ myAccess: ready({ memberships: [membership(), membership({ merchantId: 'other' })] }) }));
    expect(access).toMatchObject({ status: 'ready', source: 'my-access', merchantId: MERCHANT, role: 'owner', displayName: 'TEST Coffee' });
    expect(allows(access, 'payments.read')).toBe(true);
    // A key the service did not send, or sent false, is false. An unknown key is ignored.
    expect(allows(access, 'disputes.read')).toBe(false);
  });
  it('says there is no business when the list is empty', () => {
    expect(resolveAccess(inputs({ myAccess: ready({ memberships: [] }), merchant: ready(record()) })).status).toBe('none');
  });
  it('never falls back when the service refuses or cannot be reached', () => {
    for (const myAccess of [failure('forbidden'), failure('unreachable')]) {
      const access = resolveAccess(inputs({ myAccess: myAccess as Resource<MyAccess>, merchant: ready(record()) }));
      expect(access.status).toBe('failed');
      expect(allows(access, 'owner')).toBe(false);
    }
  });
  it('waits while anything it needs is still loading', () => {
    expect(resolveAccess(inputs({ myAccess: loading })).status).toBe('loading');
    expect(resolveAccess(inputs({ merchant: loading })).status).toBe('loading');
  });
});

describe('business access: a person who may only start a business (pay:onboard, no pay:read)', () => {
  // merchant.myAccess answers 403, merchant.me answers null, the team read is refused or says "not a member".
  const onboardOnly = (patch: Partial<AccessInputs> = {}) =>
    inputs({ myAccess: failure('forbidden') as Resource<MyAccess>, merchant: ready<MerchantRecord | null>(null), ...patch });
  it('has no business account, not a refusal', () => {
    for (const team of [failure('forbidden'), failure('forbidden', 'pay.merchant_ops_not_merchant'), failure('forbidden', 'pay.team_member_not_found')]) {
      expect(resolveAccess(onboardOnly({ team: team as AccessInputs['team'] })).status).toBe('none');
    }
  });
  it('has no business account when the owner record read is refused too', () => {
    expect(resolveAccess(onboardOnly({ merchant: failure('forbidden') as AccessInputs['merchant'] })).status).toBe('none');
  });
  it('waits while the other reads load', () => {
    expect(resolveAccess(onboardOnly({ team: loading })).status).toBe('loading');
    expect(resolveAccess(onboardOnly({ merchant: loading })).status).toBe('loading');
  });
  it('fails closed when the other reads cannot be reached, because that proves nothing', () => {
    expect(resolveAccess(onboardOnly({ merchant: failure('unreachable') as AccessInputs['merchant'] })).status).toBe('failed');
  });
  it('keeps the refusal for someone who does hold a business', () => {
    expect(resolveAccess(onboardOnly({ merchant: ready(record()) })).status).toBe('failed');
    const seat = ready({ merchantId: MERCHANT, userId: ME, role: 'viewer' as const });
    expect(resolveAccess(onboardOnly({ team: seat as AccessInputs['team'] })).status).toBe('failed');
  });
});

describe('business access: the owner fallback (merchant.myAccess not live)', () => {
  it('makes the owner only from a record that names the signed-in user', () => {
    const access = resolveAccess(inputs({ merchant: ready(record()) }));
    expect(access).toMatchObject({ status: 'ready', source: 'owner-record', role: 'owner', merchantId: MERCHANT });
    expect(allows(access, 'owner')).toBe(true);
    expect(canOwnerWrite(access)).toBe(true);
  });
  it('gives nothing for a record that names someone else', () => {
    const access = resolveAccess(inputs({ merchant: ready(record({ userId: 'someone-else' })) }));
    expect(access.status).toBe('none');
    expect(allows(access, 'owner')).toBe(false);
    expect(allows(access, 'payments.read')).toBe(false);
  });
  it('gives nothing when nobody is signed in', () => {
    expect(resolveAccess(inputs({ sessionUserId: null, merchant: ready(record()) })).status).toBe('none');
  });
  it('does not let a team read claim ownership', () => {
    const team = ready({ merchantId: MERCHANT, userId: ME, role: 'owner' as const });
    expect(resolveAccess(inputs({ team })).status).toBe('none');
  });
  it('does not accept a team read about another user', () => {
    const team = ready({ merchantId: MERCHANT, userId: 'someone-else', role: 'admin' as const });
    expect(resolveAccess(inputs({ team })).status).toBe('none');
  });
  it('lets an owner who is not on an active account read, but not write', () => {
    const access = resolveAccess(inputs({ merchant: ready(record({ status: 'pending' })) }));
    expect(access.status).toBe('ready');
    expect(canOwnerWrite(access)).toBe(false);
  });
});

describe('business access: a team lookup that did not answer fails closed', () => {
  it('says "failed", not "none", when the team read was refused or unreachable', () => {
    for (const team of [failure('unreachable'), failure('forbidden'), failure('forbidden', 'pay.merchant_ops_unavailable')]) {
      const access = resolveAccess(inputs({ team: team as AccessInputs['team'] }));
      expect(access.status).toBe('failed');
      expect(allows(access, 'payments.read')).toBe(false);
    }
  });
  it('says "none" only when the service says this person is not in a business, or the team read is not live', () => {
    for (const team of [
      failure('forbidden', 'pay.merchant_ops_not_merchant'),
      failure('forbidden', 'pay.team_member_not_found'),
      failure('not_mounted'),
    ])
      expect(resolveAccess(inputs({ team: team as AccessInputs['team'] })).status).toBe('none');
  });
  it('fails closed when the merchant read failed and the team read finds no seat', () => {
    const team = ready({ merchantId: MERCHANT, userId: 'someone-else', role: 'admin' as const });
    expect(resolveAccess(inputs({ merchant: failure('unreachable') as AccessInputs['merchant'], team })).status).toBe('failed');
  });
});

describe('business access: the team fallback', () => {
  const asMember = (role: 'admin' | 'finance' | 'developer' | 'viewer') =>
    resolveAccess(inputs({ team: ready({ merchantId: MERCHANT, userId: ME, role }) }));
  it('gives finance the reads and the payout request, not the owner writes', () => {
    const finance = asMember('finance');
    expect(finance).toMatchObject({ status: 'ready', source: 'team-member', role: 'finance' });
    for (const need of ['payments.read', 'settlements.read', 'halts.read', 'payout.request', 'payout.approve'] as const)
      expect(allows(finance, need), need).toBe(true);
    expect(allows(finance, 'owner')).toBe(false);
    expect(allows(finance, 'team.manage')).toBe(false);
    expect(canOwnerWrite(finance)).toBe(false);
  });
  it('gives a viewer the reads only', () => {
    const viewer = asMember('viewer');
    expect(allows(viewer, 'payments.read')).toBe(true);
    expect(allows(viewer, 'payout.request')).toBe(false);
    expect(allows(viewer, 'disputes.respond')).toBe(false);
  });
});

describe('what an unreadable session is allowed to do', () => {
  it('treats an API key or a session without MFA as read only', () => {
    const access = resolveAccess(inputs({ myAccess: ready({ memberships: [membership({ sessionInteractive: false })] }) }));
    expect(canOwnerWrite(access)).toBe(false);
    expect(allows(access, 'owner')).toBe(true);
  });
  it('grants nothing before the answer is in', () => {
    for (const status of [{ status: 'loading' }, { status: 'none' }] as const) {
      expect(allows(status, 'owner')).toBe(false);
      expect(canOwnerWrite(status)).toBe(false);
    }
  });
});

describe('the authority the older tools need', () => {
  it('is made only for the account owner, with write scopes only when the session can write', () => {
    const owner = resolveAccess(inputs({ merchant: ready(record()) }));
    expect(authorityFromAccess(owner, ME)).toMatchObject({
      merchantId: MERCHANT,
      userId: ME,
      scopes: ['pay:read', 'pay:write', 'pay:refund', 'pay:payout'],
    });
    const readOnly = resolveAccess(inputs({ myAccess: ready({ memberships: [membership({ sessionInteractive: false })] }) }));
    expect(authorityFromAccess(readOnly, ME)?.scopes).toEqual(['pay:read']);
  });
  it('is never made for a team member, a stranger or a missing session', () => {
    const finance = resolveAccess(inputs({ team: ready({ merchantId: MERCHANT, userId: ME, role: 'finance' as const }) }));
    expect(authorityFromAccess(finance, ME)).toBeNull();
    expect(authorityFromAccess(resolveAccess(inputs()), ME)).toBeNull();
    expect(authorityFromAccess(resolveAccess(inputs({ merchant: ready(record()) })), null)).toBeNull();
  });
});
