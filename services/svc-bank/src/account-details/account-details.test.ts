import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { AccountDetailsService, requestKey, type AccountDetailsPartner, type AccountDetailSet } from './account-details.js';

/**
 * Account details and the eligibility statement through the real router and edge context. No banking partner is wired in this
 * build, so details refuse `rail.bank` and no number is shown or made up; the partner in these tests is a labelled TEST fixture.
 */

const SECRET = 'a-bank-account-details-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signed(userId: string, scopes: string[], region = 'DE') {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
      'x-intafaced-region': region,
    },
    id: 'req-details',
  });
}

const anonymous = () => edgeContext({ headers: {}, id: 'req-eligibility' });

/** TEST fixture details. Not a real account. */
const TEST_SET = (id: string): AccountDetailSet => ({
  id,
  accountNumber: 'TEST-00000001',
  sortCode: 'TEST-00-00-00',
  routingNumber: null,
  bsb: null,
  iban: null,
  bic: null,
  partnerBank: 'TEST partner bank',
  restrictions: ['TEST: cannot receive Swift'],
});

function testPartner() {
  const requests: string[] = [];
  const partner: AccountDetailsPartner = {
    detailsFor: async (_userId, currency) =>
      currency === 'GBP' ? { state: 'done', sets: [TEST_SET('a'), TEST_SET('b')] } : { state: 'pending_user', sets: [] },
    request: async (_userId, _currency, key) => {
      requests.push(key);
      return { state: 'pending_user', sets: [] };
    },
  };
  return { partner, requests };
}

function build(options: ConstructorParameters<typeof AccountDetailsService>[0]) {
  const accountDetails = new AccountDetailsService(options);
  const router = createBankRouter({ accountDetails } as unknown as BankServices);
  return {
    as: (scopes: string[], region?: string) => router.createCaller(signed(USER, scopes, region)),
    anonymous: () => router.createCaller(anonymous()),
  };
}

const READ = ['bank:read'];
const WRITE = ['bank:read', 'bank:write'];

describe('account details', () => {
  it('lists nothing and says why while the owner has published no currencies', async () => {
    const { as } = build({});
    await expect(as(READ).accountDetails.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'bank.account_details_currencies_unset' }),
    });
    const { as: asBad } = build({ currencies: 'GBP,EURO' });
    await expect(asBad(READ).accountDetails.list()).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'bank.account_details_currencies_unset' }),
    });
  });

  it('with no banking partner every currency is unavailable with the blocker rail.bank, and no number is shown', async () => {
    const { as } = build({ currencies: 'gbp, EUR,GBP' });
    const out = await as(READ).accountDetails.list();
    expect(out.currencies).toEqual([
      { currency: 'GBP', state: 'unavailable', blocker: 'rail.bank', sets: [] },
      { currency: 'EUR', state: 'unavailable', blocker: 'rail.bank', sets: [] },
    ]);
  });

  it('get and request refuse rail.bank without a partner and change nothing', async () => {
    const { as } = build({ currencies: 'GBP' });
    const refuses = { code: 'PRECONDITION_FAILED', cause: expect.objectContaining({ code: 'rail.bank' }) };
    await expect(as(READ).accountDetails.get({ currency: 'GBP' })).rejects.toMatchObject(refuses);
    await expect(as(WRITE).accountDetails.request({ currency: 'GBP' })).rejects.toMatchObject(refuses);
  });

  it('a currency the owner does not publish is a bad request, not a rail problem', async () => {
    const { as } = build({ currencies: 'GBP' });
    await expect(as(READ).accountDetails.get({ currency: 'JPY' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: expect.objectContaining({ code: 'bank.account_details_currency_unknown' }),
    });
  });

  it('with a TEST partner it shows both GBP sets exactly as issued and a pending state for the rest', async () => {
    const { partner } = testPartner();
    const { as } = build({ currencies: 'GBP,EUR', partner });
    const list = await as(READ).accountDetails.list();
    expect(list.currencies[0]).toMatchObject({ currency: 'GBP', state: 'done', blocker: null });
    expect(list.currencies[0]!.sets.map((s) => s.accountNumber)).toEqual(['TEST-00000001', 'TEST-00000001']);
    expect(list.currencies[1]).toEqual({ currency: 'EUR', state: 'pending_user', blocker: null, sets: [] });
    const one = await as(READ).accountDetails.get({ currency: 'GBP' });
    expect(one.sets).toHaveLength(2);
  });

  it('asking twice for the same currency sends the same business key', async () => {
    const { partner, requests } = testPartner();
    const { as } = build({ currencies: 'GBP', partner });
    await as(WRITE).accountDetails.request({ currency: 'GBP' });
    await as(WRITE).accountDetails.request({ currency: 'gbp' });
    expect(requests).toEqual([requestKey(USER, 'GBP'), requestKey(USER, 'GBP')]);
    expect(requestKey(USER, 'GBP')).toBe(`accountDetails:request:${USER}:GBP`);
  });

  it('a partner that does not answer is a typed 503 and nothing else', async () => {
    const partner: AccountDetailsPartner = {
      detailsFor: async () => {
        throw new Error('socket hang up');
      },
      request: async () => {
        throw new Error('timeout');
      },
    };
    const { as } = build({ currencies: 'GBP', partner });
    const unavailable = { code: 'SERVICE_UNAVAILABLE', cause: expect.objectContaining({ code: 'bank.account_details_unavailable' }) };
    await expect(as(READ).accountDetails.list()).rejects.toMatchObject(unavailable);
    await expect(as(WRITE).accountDetails.request({ currency: 'GBP' })).rejects.toMatchObject(unavailable);
  });

  it('a request needs the write scope, a read needs the read scope', async () => {
    const { partner } = testPartner();
    const { as } = build({ currencies: 'GBP', partner });
    await expect(as(READ).accountDetails.request({ currency: 'GBP' })).rejects.toBeDefined();
    await expect(as([]).accountDetails.list()).rejects.toBeDefined();
    await expect(as(READ).accountDetails.get({ currency: 'GBP', extra: 1 } as never)).rejects.toBeDefined();
  });

  it('a US-region session is refused by the bank module rule before anything is read', async () => {
    const { partner } = testPartner();
    const spy = vi.spyOn(partner, 'detailsFor');
    const { as } = build({ currencies: 'GBP', partner });
    await expect(as(READ, 'US').accountDetails.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the eligibility statement', () => {
  const RULES = JSON.stringify({
    countries: ['GB', 'DE'],
    entityTypes: ['individual', 'company'],
    productRestrictions: [{ product: 'crypto', restriction: 'TEST: held as crypto, not as cash' }],
  });

  it('refuses while the owner has published no rule set, or one that is not in shape', async () => {
    for (const eligibilityJson of [
      undefined,
      '',
      '   ',
      'not json',
      '{}',
      '{"countries":["gb"],"entityTypes":["x"],"productRestrictions":[]}',
    ]) {
      const { anonymous: call } = build({ eligibilityJson });
      await expect(call().eligibility.get()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: expect.objectContaining({ code: 'bank.eligibility_unset' }),
      });
    }
  });

  it('is readable before sign-up, and returns the owner’s rules as published', async () => {
    const { anonymous: call } = build({ eligibilityJson: RULES });
    const out = await call().eligibility.get();
    expect(out.verdict).toBeNull();
    expect(out.rules.countries).toEqual(['GB', 'DE']);
    expect(out.rules.productRestrictions[0]!.product).toBe('crypto');
  });

  it('a US region is told the bank is not available there and which rule says so', async () => {
    const { anonymous: call } = build({ eligibilityJson: RULES });
    const out = await call().eligibility.get({ region: 'us' });
    expect(out.verdict).toEqual({
      region: 'US',
      status: 'blocked',
      minTier: expect.any(String),
      notes: null,
      source: 'JURISDICTION_MATRIX',
      listed: false,
    });
  });

  it('a listed, open region is open and listed; an unlisted open region is open but not listed', async () => {
    const { anonymous: call } = build({ eligibilityJson: RULES });
    expect((await call().eligibility.get({ region: 'DE' })).verdict).toMatchObject({ status: 'open', listed: true });
    expect((await call().eligibility.get({ region: 'FR' })).verdict).toMatchObject({ status: 'open', listed: false });
  });

  it('refuses a region that is not two letters', async () => {
    const { anonymous: call } = build({ eligibilityJson: RULES });
    await expect(call().eligibility.get({ region: 'USA' })).rejects.toBeDefined();
  });
});
