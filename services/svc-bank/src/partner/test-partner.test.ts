import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { BankError } from '../errors.js';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import {
  SWITCHES_OFF,
  TestPartnerRefusedError,
  assertPartnerOffers,
  assertRampFeeKnown,
  partnerFeeKnown,
  partnerReserve,
  rampQuoteExpired,
  testPartner,
  testPartnerFor,
} from './test-partner.js';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SECRET = 'bank-test-partner-edge-secret-long-enough';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as BankError).code;
  }
  return null;
};

describe('the TEST partner is refused outside dev and test (production refusal, planted)', () => {
  it.each([
    ['prod', undefined],
    ['staging', undefined],
    ['production', undefined],
    [undefined, undefined],
    ['', undefined],
    ['dev', 'production'],
    ['test', 'production'],
  ])('APP_ENV=%s NODE_ENV=%s with BANK_TEST_PARTNER=test refuses to start', (APP_ENV, NODE_ENV) => {
    expect(() => testPartnerFor('test', { APP_ENV, NODE_ENV })).toThrow(TestPartnerRefusedError);
    try {
      testPartnerFor('test', { APP_ENV, NODE_ENV });
    } catch (err) {
      expect((err as TestPartnerRefusedError).code).toBe('bank.test_partner_outside_dev_test');
    }
  });

  it('off is no adapter anywhere, and on dev or test it is the TEST partner bank', () => {
    expect(testPartnerFor('off', { APP_ENV: 'prod', NODE_ENV: 'production' })).toBeNull();
    expect(testPartnerFor('test', { APP_ENV: 'dev' })?.label).toBe('TEST partner bank');
    expect(testPartnerFor('test', { APP_ENV: 'test', NODE_ENV: 'test' })?.label).toMatch(/^TEST\b/);
  });
});

describe('the switches are per person and start off', () => {
  it('a switch set for one person never reaches another, and unnamed switches keep their value', () => {
    const partner = testPartner();
    expect(partner.switches(ADA)).toEqual(SWITCHES_OFF);
    partner.set(ADA, { notOffered: ['spaces', 'spaces'], fee: 'unknown' });
    const later = partner.set(ADA, { down: true });
    expect(later).toEqual({ ...SWITCHES_OFF, notOffered: ['spaces'], fee: 'unknown', down: true });
    expect(partner.switches(BOB)).toEqual(SWITCHES_OFF);
    expect(partner.set(ADA, { notOffered: [], fee: 'known', down: false })).toEqual(SWITCHES_OFF);
  });
});

describe('bank: a feature not offered by the partner, and the partner down', () => {
  it('each feature refuses bank.not_offered_by_partner only while switched, and only for that feature', () => {
    const partner = testPartner();
    for (const feature of ['currencies', 'spaces', 'pots', 'joint'] as const) {
      expect(codeOf(() => assertPartnerOffers(partner, ADA, feature))).toBeNull();
      partner.set(ADA, { notOffered: [feature] });
      expect(codeOf(() => assertPartnerOffers(partner, ADA, feature))).toBe('bank.not_offered_by_partner');
      for (const other of ['currencies', 'spaces', 'pots', 'joint'] as const) {
        if (other !== feature) expect(codeOf(() => assertPartnerOffers(partner, ADA, other))).toBeNull();
      }
      expect(codeOf(() => assertPartnerOffers(partner, BOB, feature))).toBeNull();
    }
  });

  it('the partner down refuses bank.partner_unavailable on every partner-held door, before "not offered"', () => {
    const partner = testPartner();
    partner.set(ADA, { down: true, notOffered: ['spaces'] });
    for (const feature of ['currencies', 'spaces', 'pots', 'joint'] as const) {
      expect(codeOf(() => assertPartnerOffers(partner, ADA, feature))).toBe('bank.partner_unavailable');
    }
  });

  it('without the adapter nothing is refused and nothing is claimed', () => {
    expect(codeOf(() => assertPartnerOffers(null, ADA, 'spaces'))).toBeNull();
    expect(partnerFeeKnown(null, ADA)).toBe(true);
    expect(partnerReserve(null, ADA)).toBeNull();
    expect(rampQuoteExpired(null, ADA)).toBe(false);
    expect(codeOf(() => assertRampFeeKnown(null, ADA))).toBeNull();
  });
});

describe('bank: unknown fee and reserve required read "not known", never 0', () => {
  it('fee unknown', () => {
    const partner = testPartner();
    expect(partnerFeeKnown(partner, ADA)).toBe(true);
    partner.set(ADA, { fee: 'unknown' });
    expect(partnerFeeKnown(partner, ADA)).toBe(false);
  });

  it('a reserve the partner requires carries no amount: null, not 0', () => {
    const partner = testPartner();
    expect(partnerReserve(partner, ADA)).toEqual({ required: false });
    partner.set(ADA, { reserve: 'required' });
    expect(partnerReserve(partner, ADA)).toEqual({ required: true, amount: null });
  });
});

describe('ramp: quote expired and fee not known', () => {
  it('the quote reads expired only while switched', () => {
    const partner = testPartner();
    expect(rampQuoteExpired(partner, ADA)).toBe(false);
    partner.set(ADA, { rampQuote: 'expired' });
    expect(rampQuoteExpired(partner, ADA)).toBe(true);
    expect(rampQuoteExpired(partner, BOB)).toBe(false);
  });

  it('a ramp that gives no fee refuses the quote bank.onramp_fee_not_known', () => {
    const partner = testPartner();
    expect(codeOf(() => assertRampFeeKnown(partner, ADA))).toBeNull();
    partner.set(ADA, { rampFee: 'unknown' });
    expect(codeOf(() => assertRampFeeKnown(partner, ADA))).toBe('bank.onramp_fee_not_known');
  });
});

/** The bank with every service replaced by one that fails the test if it is reached: a refusal must come first. */
function unreachableBank(partner: ReturnType<typeof testPartner> | null): BankServices {
  const reached = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_t, key) => (key === 'then' ? undefined : reached(`${path}.${String(key)}`)),
      apply: () => {
        throw new Error(`reached ${path} before the partner's refusal`);
      },
    });
  return new Proxy({} as BankServices, {
    get: (_t, key) => (key === 'testPartner' ? partner : key === 'then' ? undefined : reached(String(key))),
  });
}

function as(bank: BankServices, userId = ADA) {
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: randomUUID(),
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return createBankRouter(bank).createCaller(
    edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

const refusal = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (err) {
    return { code: (err as { code?: string }).code, bank: (err as { cause?: { code?: string } }).cause?.code };
  }
  throw new Error('expected a refusal');
};

describe('the partner-held doors refuse before any service is reached', () => {
  const SPACE = '33333333-3333-4333-8333-333333333333';
  const doors = (caller: ReturnType<typeof as>) =>
    [
      ['currencies', () => caller.currencies.add({ assetId: 'USDC' })],
      ['spaces', () => caller.spaces.create({ assetId: 'USDT', name: 'Trip TEST' })],
      ['spaces', () => caller.transfers.create({ transferId: 'jb01-transfer-1', fromSpaceId: SPACE, toSpaceId: SPACE, amount: '1' })],
      ['pots', () => caller.spaces.setGoal({ spaceId: SPACE, goalTarget: '10' })],
      ['pots', () => caller.spaces.setLock({ spaceId: SPACE, lockedUntil: new Date(Date.now() + 86_400_000).toISOString() })],
      ['pots', () => caller.spaces.requestUnlock({ spaceId: SPACE })],
      ['pots', () => caller.spaces.setBillsPot({ spaceId: SPACE, fallback: false })],
      ['pots', () => caller.sorter.create({ sorterId: SPACE, assetId: 'USDT', legs: [{ spaceId: SPACE, shareBp: 10_000 }] })],
      ['joint', () => caller.sharedPots.invite({ inviteId: SPACE, spaceId: SPACE, handle: 'bob', role: 'viewer' })],
      ['joint', () => caller.sharedPots.accept({ inviteId: SPACE })],
      ['currencies', () => caller.currencies.remove({ assetId: 'USDC' })],
      ['spaces', () => caller.spaces.archive({ spaceId: SPACE })],
      ['spaces', () => caller.spaces.unarchive({ spaceId: SPACE })],
      ['pots', () => caller.spaces.cancelUnlock({ spaceId: SPACE })],
      ['pots', () => caller.spaces.clearBillsPot({ spaceId: SPACE })],
      ['pots', () => caller.sorter.cancel({ sorterId: SPACE })],
      ['joint', () => caller.sharedPots.cancelInvite({ inviteId: SPACE })],
      ['joint', () => caller.sharedPots.decline({ inviteId: SPACE })],
      ['joint', () => caller.sharedPots.leave({ spaceId: SPACE })],
      ['joint', () => caller.sharedPots.remove({ spaceId: SPACE, userId: BOB })],
      ['joint', () => caller.sharedPots.linkCard({ spaceId: SPACE, cardId: SPACE })],
      ['joint', () => caller.sharedPots.unlinkCard({ spaceId: SPACE })],
    ] as const;

  it('each door refuses bank.not_offered_by_partner when its feature is switched off', async () => {
    const partner = testPartner();
    for (const [feature, door] of doors(as(unreachableBank(partner)))) {
      // Only this door's own feature is switched, so a door wired to the wrong feature fails here.
      partner.set(ADA, { notOffered: [feature] });
      expect(await refusal(door()), feature).toEqual({ code: 'PRECONDITION_FAILED', bank: 'bank.not_offered_by_partner' });
    }
  });

  it('each door refuses bank.partner_unavailable while the partner is down', async () => {
    const partner = testPartner();
    partner.set(ADA, { down: true });
    for (const [, door] of doors(as(unreachableBank(partner)))) {
      expect(await refusal(door())).toEqual({ code: 'SERVICE_UNAVAILABLE', bank: 'bank.partner_unavailable' });
    }
  });

  it('a send to a person and a standing order refuse while the partner is down, and still go through when it is up', async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const moves = (caller: ReturnType<typeof as>) => [
      () => caller.transfers.toUser({ transferId: 'jb-send-down-1', fromSpaceId: SPACE, toUserId: 'bob', amount: '1' }),
      () =>
        caller.transfers.scheduleToUser({
          fromSpaceId: SPACE,
          toUserId: 'bob',
          amount: '1',
          cadence: 'once',
          startsAt: at,
          scheduleId: SPACE,
        }),
      () =>
        caller.transfers.schedule({ fromSpaceId: SPACE, toSpaceId: SPACE, amount: '1', cadence: 'once', startsAt: at, scheduleId: SPACE }),
      () => caller.transfers.updateSchedule({ scheduleId: SPACE, revision: 1, amount: '2', endsAt: null }),
      () => caller.transfers.resume({ scheduleId: SPACE }),
    ];
    const partner = testPartner();
    partner.set(ADA, { down: true });
    for (const move of moves(as(unreachableBank(partner)))) {
      expect(await refusal(move())).toEqual({ code: 'SERVICE_UNAVAILABLE', bank: 'bank.partner_unavailable' });
    }
    // Up again: the door goes on to the service (here the unreachable test bank), so the refusal is not the partner's.
    partner.set(ADA, { down: false });
    for (const move of moves(as(unreachableBank(partner)))) {
      expect((await refusal(move())).bank).not.toBe('bank.partner_unavailable');
    }
  });

  it('the switches themselves: refused off the TEST stack, and the person sets only their own', async () => {
    expect(await refusal(as(unreachableBank(null)).testPartner.set({ down: true }))).toEqual({
      code: 'PRECONDITION_FAILED',
      bank: 'bank.test_partner_off',
    });
    const partner = testPartner();
    const set = await as(unreachableBank(partner)).testPartner.set({ reserve: 'required', notOffered: ['pots'] });
    expect(set).toMatchObject({ label: 'TEST partner bank', notOffered: ['pots'], partnerReserve: { required: true, amount: null } });
    expect(partner.switches(BOB)).toEqual(SWITCHES_OFF);
    expect(await as(unreachableBank(partner), BOB).testPartner.switches()).toMatchObject({
      notOffered: [],
      partnerReserve: { required: false },
    });
  });
});

describe('the TEST partner issues TEST account details only to a person who switched them on (J-bank-01 #6)', () => {
  it('answers no partner by default, and TEST-labelled details once issued, for that person only', async () => {
    const { AccountDetailsService } = await import('../account-details/account-details.js');
    const { testPartner: make, testPartnerAccountDetails } = await import('./test-partner.js');
    const partner = make();
    const service = new AccountDetailsService({ currencies: 'EUR,GBP', partnerFor: testPartnerAccountDetails(partner) });
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect((await service.list(a)).currencies).toEqual([
      { currency: 'EUR', state: 'unavailable', blocker: 'rail.bank', sets: [] },
      { currency: 'GBP', state: 'unavailable', blocker: 'rail.bank', sets: [] },
    ]);
    await expect(service.get(a, 'EUR')).rejects.toMatchObject({ code: 'rail.bank' });
    partner.set(a, { accountDetails: 'issued' });
    const issued = (await service.list(a)).currencies;
    expect(issued.map((c) => [c.currency, c.state, c.blocker])).toEqual([
      ['EUR', 'done', null],
      ['GBP', 'done', null],
    ]);
    for (const c of issued) {
      expect(c.sets).toHaveLength(1);
      expect(c.sets[0]!.partnerBank).toBe('TEST partner bank');
      expect(c.sets[0]!.accountNumber).toMatch(new RegExp(`^TEST-${c.currency}-`));
      expect([c.sets[0]!.iban, c.sets[0]!.sortCode, c.sets[0]!.routingNumber]).toEqual([null, null, null]);
    }
    // Another person still has no partner.
    expect((await service.list(b)).currencies.every((c) => c.blocker === 'rail.bank')).toBe(true);
    partner.set(a, { accountDetails: 'none' });
    expect((await service.list(a)).currencies.every((c) => c.blocker === 'rail.bank')).toBe(true);
  });
});
