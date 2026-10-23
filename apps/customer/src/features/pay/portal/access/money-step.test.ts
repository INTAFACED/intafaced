import { describe, expect, it } from 'vitest';
import { moneyReason, moneyReasonFor } from './money-step';
import type { Access } from './resolve';
import { scopesOfAccessToken } from './session-scopes';

// TEST data only. A token shaped like identity's: header.payload.signature, the payload carrying `scopes`.
const token = (payload: unknown) =>
  `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

describe('the scopes a session carries', () => {
  it('reads them from the access token', () => {
    expect([...scopesOfAccessToken(token({ sub: 'u', scopes: ['pay:read', 'pay:write'] }))!]).toEqual(['pay:read', 'pay:write']);
  });
  it('holds nothing when the token cannot be read', () => {
    for (const bad of [undefined, null, '', 'portal-test-only', 'a.b.c', token({ sub: 'u' }), token({ scopes: 'pay:refund' })])
      expect(scopesOfAccessToken(bad as string | null | undefined), String(bad)).toBeNull();
  });
});

describe('the reason a money control is off', () => {
  const owner = new Set(['pay:read', 'pay:write', 'pay:onboard']);
  it('says who can, in the present tense, when the scope-only check has no scope; null when it has it', () => {
    expect(moneyReason('refund', owner)).toBe('Only the account owner can refund payments.');
    expect(moneyReason('payout', owner)).toBe('Only the account owner can send payouts.');
    expect(moneyReason('refund', new Set([...owner, 'pay:refund']))).toBeNull();
    expect(moneyReason('payout', new Set([...owner, 'pay:refund']))).not.toBeNull();
    expect(moneyReason('payout', ['pay:payout'])).toBeNull();
  });
  it('fails closed when the scopes are unknown', () => {
    expect(moneyReason('refund', null)).not.toBeNull();
    expect(moneyReason('payout', undefined)).not.toBeNull();
  });
});

describe('who may begin a refund or a payout', () => {
  const ready = (patch: Partial<Extract<Access, { status: 'ready' }>> = {}): Access => ({
    status: 'ready',
    source: 'my-access',
    merchantId: '11111111-1111-4111-8111-111111111111',
    role: 'owner',
    accountStatus: 'active',
    kybStatus: 'approved',
    mode: 'gateway',
    sessionInteractive: true,
    displayName: null,
    legalName: null,
    pricingVisibility: null,
    capabilities: new Set(),
    ...patch,
  });
  it('is on for the owner of an active account: the confirmation is asked when the action opens', () => {
    expect(moneyReasonFor('refund', ready())).toBeNull();
    expect(moneyReasonFor('payout', ready({ sessionInteractive: null }))).toBeNull();
  });
  it('names who can when the role cannot', () => {
    for (const role of ['admin', 'finance', 'developer', 'viewer'] as const) {
      expect(moneyReasonFor('refund', ready({ role }))).toBe('Only the account owner can refund payments.');
      expect(moneyReasonFor('payout', ready({ role }))).toBe('Only the account owner can send payouts.');
    }
  });
  it('splits the payout actions: sending is the owner’s, asking, taking back and converting follow the role’s permission', () => {
    const financeCaps = new Set(['payout.request', 'payout.approve'] as const);
    const finance = ready({ role: 'finance', capabilities: financeCaps });
    const requestOnly = ready({ role: 'developer', capabilities: new Set(['payout.request'] as const) });
    const viewer = ready({ role: 'viewer', capabilities: new Set() });
    expect(moneyReasonFor('payout', finance, 'send')).toBe('Only the account owner can send payouts.');
    expect(moneyReasonFor('payout', finance, 'request')).toBeNull();
    expect(moneyReasonFor('payout', finance, 'cancel')).toBeNull();
    expect(moneyReasonFor('payout', finance, 'convert')).toBeNull();
    // asking needs payout.request or payout.approve; converting needs payout.approve
    expect(moneyReasonFor('payout', requestOnly, 'request')).toBeNull();
    expect(moneyReasonFor('payout', requestOnly, 'convert')).toBe('Only the account owner, admins and finance can convert a settlement.');
    expect(moneyReasonFor('payout', viewer, 'request')).toBe(
      'Only the account owner, admins and finance can ask for a payout or take a request back.',
    );
    expect(moneyReasonFor('payout', viewer, 'cancel')).toBe(
      'Only the account owner, admins and finance can ask for a payout or take a request back.',
    );
    // the owner can do all of them, and refunds stay the owner's
    for (const act of ['send', 'request', 'cancel', 'convert'] as const) expect(moneyReasonFor('payout', ready(), act)).toBeNull();
    expect(moneyReasonFor('refund', finance)).toBe('Only the account owner can refund payments.');
    // the account and session checks still apply to every action
    expect(moneyReasonFor('payout', ready({ role: 'finance', capabilities: financeCaps, accountStatus: 'suspended' }), 'request')).toBe(
      'Refunds and payouts open once your business account is active.',
    );
    expect(moneyReasonFor('payout', ready({ role: 'finance', capabilities: financeCaps, sessionInteractive: false }), 'convert')).toBe(
      'API keys and sub-accounts cannot confirm a payment.',
    );
  });
  it('says why an owner cannot: an account that is not active, an API key', () => {
    expect(moneyReasonFor('refund', ready({ accountStatus: 'suspended' }))).toBe(
      'Refunds and payouts open once your business account is active.',
    );
    expect(moneyReasonFor('payout', ready({ sessionInteractive: false }))).toBe('API keys and sub-accounts cannot confirm a payment.');
  });
  it('is off until the account is known', () => {
    expect(moneyReasonFor('refund', { status: 'loading' })).not.toBeNull();
    expect(moneyReasonFor('payout', { status: 'none' })).not.toBeNull();
  });
});
