import { describe, expect, it, beforeEach } from 'vitest';
import { INTERACTIVE_ONLY_SCOPES, SESSION_SCOPES, assertKeyScopesAllowed, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { createPayRouter } from './router.js';
import { PayError, type PayService, type PaymentView, type SettlementRecord } from './payment-service.js';
import type { DepositRecord, UserMoneyService, WithdrawalRecord } from './user-money-service.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { PublicCheckoutUnavailable } from './rails/posture.js';

/**
 * The tRPC boundary.
 *
 * No database and no ledger: the service is a stub, because what this file is
 * about is the CONTRACT, not the payments maths. Three things cross this
 * boundary and every one of them is a way to lose money quietly:
 *
 *   1. Money, which is a decimal string in both directions. A JSON number that
 *      slips through is a float in a payments book.
 *   2. Errors, which a caller has to be able to tell apart — a declined card,
 *      a malformed request and an unavailable rail need three different
 *      responses from a merchant's integration, and collapsing them into
 *      "500" costs somebody a day.
 *   3. Authority. Taking a payment and sending money back out are not the same
 *      permission, and §22 says pay is custodial, so verification applies.
 */

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '66666666-6666-4666-8666-666666666666';
const MERCHANT = '55555555-5555-4555-8555-555555555555';
const PAYMENT = '44444444-4444-4444-8444-444444444444';
const SETTLEMENT = '33333333-3333-4333-8333-333333333333';

/**
 * `pay` is `OPEN_FULL` in the jurisdiction matrix — custodial Fiat Plane, so
 * `full` verification is the floor. Anything less is refused by the guard, not
 * by this service.
 */
async function ctx(
  scopes: string[],
  opts: { tier?: 'none' | 'basic' | 'full'; region?: string; mfa?: boolean; userId?: string } = {},
): Promise<Context> {
  const region = opts.region ?? 'DE';
  if (scopes.length === 0) return { principal: null, region, requestId: 'req-1' };

  const { token } = await issueAccessToken(
    {
      userId: opts.userId ?? USER,
      sessionId: '77777777-7777-4777-8777-777777777777',
      scopes,
      tier: opts.tier ?? 'full',
      mfa: opts.mfa ?? true,
    },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), region, requestId: 'req-1' };
}

// ── The stub ─────────────────────────────────────────────────────────────────

function paymentView(overrides: Partial<PaymentView> = {}): PaymentView {
  return {
    id: PAYMENT,
    merchantId: MERCHANT,
    profileId: null,
    amount: amt('100'),
    assetId: 'USDT',
    method: 'card',
    railAdapter: 'card-sandbox',
    railRef: 'ch_1',
    status: 'authorized',
    capturedAmount: 0n,
    refundedAmount: 0n,
    createdAt: new Date('2026-07-27T12:00:00.000Z'),
    ...overrides,
  };
}

const LINK = '88888888-8888-4888-8888-888888888888';
const SESSION = '99999999-9999-4999-8999-999999999999';

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    status: 'open' as const,
    label: 'Invoice',
    // A DECIMAL STRING, because that is what `CheckoutSessionView` carries.
    // A bigint here would be caught by the output schema, which is the point.
    amount: '19.99',
    currency: 'USDT',
    method: 'crypto',
    expiresAt: '2026-07-30T12:15:00.000Z',
    instruction: { reference: '0xacceptance01', amount: '19.99', currency: 'USDT' },
    ...overrides,
  };
}

function settlementRecord(overrides: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id: SETTLEMENT,
    merchantId: MERCHANT,
    window: '2026-07-27',
    assetId: 'USDT',
    gross: amt('100'),
    fees: amt('2.5'),
    net: amt('97.5'),
    payoutMethod: 'ledger',
    payoutRef: null,
    payoutAttempts: 0,
    status: 'posted',
    ...overrides,
  };
}

interface Stub {
  service: PayService;
  calls: Array<{ method: string; args: unknown[] }>;
  /** Make the next service call throw this. */
  fail(err: unknown): void;
  /** Whose merchant every payment and settlement in this stub belongs to. */
  ownedBy(userId: string): void;
}

function stubService(): Stub {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let nextError: unknown = null;
  let merchantOwner = USER;

  const record = <T>(method: string, result: (...args: never[]) => T) =>
    ((...args: never[]) => {
      calls.push({ method, args });
      if (nextError) {
        const err = nextError;
        nextError = null;
        return Promise.reject(err);
      }
      return Promise.resolve(result(...args));
    }) as never;

  const merchant = () => ({
    id: MERCHANT,
    userId: merchantOwner,
    mode: 'gateway' as const,
    tier: 0,
    kybStatus: 'none' as const,
    kybRef: null as string | null,
    status: 'active' as const,
    pricing: { feeBps: 250 },
    settlementPrefs: {},
  });

  const service = {
    createMerchant: record('createMerchant', merchant),
    getMerchant: record('getMerchant', merchant),
    getMerchantByUserId: record('getMerchantByUserId', merchant),
    submitKyb: record('submitKyb', () => ({ ...merchant(), kybStatus: 'pending' as const, kybRef: 'dossier-1' })),
    decideKybStub: record('decideKybStub', () => ({ ...merchant(), kybStatus: 'approved' as const, kybRef: 'dossier-1' })),
    listPayments: record('listPayments', () => [paymentView({ status: 'captured', capturedAmount: amt('100') })]),
    createProfile: record('createProfile', () => ({ id: SETTLEMENT, merchantId: MERCHANT })),
    clearingBalance: record('clearingBalance', () => amt('100.5')),
    merchantBalance: record('merchantBalance', () => amt('97.5')),
    createPayment: record('createPayment', () => paymentView({ status: 'created', railRef: null })),
    authorize: record('authorize', () => paymentView()),
    capture: record('capture', () => paymentView({ status: 'captured', capturedAmount: amt('100') })),
    refund: record('refund', () => paymentView({ status: 'refunded', capturedAmount: amt('100'), refundedAmount: amt('100') })),
    getPayment: record('getPayment', () => paymentView()),
    history: record('history', () => [
      { id: PAYMENT, event: 'created', payload: { amount: '100' }, railEventId: null, ts: new Date('2026-07-27T12:00:00.000Z') },
    ]),
    settleWindow: record('settleWindow', () => settlementRecord()),
    releasePendingSettlement: record('releasePendingSettlement', () => settlementRecord({ status: 'failed' })),
    payoutSettlement: record('payoutSettlement', () =>
      settlementRecord({ status: 'paid_out', payoutMethod: 'card-sandbox', payoutRef: 'po_1' }),
    ),
    getSettlement: record('getSettlement', () => settlementRecord()),
    listSettlements: record('listSettlements', () => [settlementRecord()]),
    createPaymentLink: record('createPaymentLink', () => ({
      id: LINK,
      token: 'pl_generated_token',
      prefix: 'pl_generat',
      label: 'Invoice',
      expiresAt: new Date('2026-08-29T00:00:00.000Z'),
      maxUses: null,
    })),
    resolvePaymentLink: record('resolvePaymentLink', () => ({
      id: LINK,
      merchantId: MERCHANT,
      profileId: null,
      label: 'Invoice',
      amount: '19.99',
      currency: 'USDT',
      expiresAt: '2026-08-29T00:00:00.000Z',
      remainingUses: null,
      checkoutConfig: {},
    })),
    openCheckoutSession: record('openCheckoutSession', () => ({
      sessionToken: 'cs_generated_session_token',
      session: checkoutSession(),
    })),
    getCheckoutSession: record('getCheckoutSession', () => checkoutSession()),
  } as unknown as PayService;

  return {
    service,
    calls,
    fail: (err) => {
      nextError = err;
    },
    ownedBy: (userId) => {
      merchantOwner = userId;
    },
  };
}

// ── The user-money stub ──────────────────────────────────────────────────────

const DEPOSIT = '12121212-1212-4212-8212-121212121212';
const WITHDRAWAL = '13131313-1313-4313-8313-131313131313';

interface MoneyStub {
  service: UserMoneyService;
  calls: Array<{ method: string; args: unknown[] }>;
  fail(err: unknown): void;
  /** Whose withdrawal `get` returns. */
  ownedBy(userId: string): void;
}

function stubUserMoney(): MoneyStub {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let nextError: unknown = null;
  let owner = USER;

  const record = <T>(method: string, result: (...args: never[]) => T) =>
    ((...args: never[]) => {
      calls.push({ method, args });
      if (nextError) {
        const err = nextError;
        nextError = null;
        return Promise.reject(err);
      }
      return Promise.resolve(result(...args));
    }) as never;

  const deposit = (): DepositRecord => ({
    id: DEPOSIT,
    userId: USER,
    assetId: 'USDT',
    amount: amt('100'),
    rail: 'card-sandbox',
    railRef: 'psp_1',
    creditedBy: 'operator-identity-that-must-not-leak',
    status: 'credited',
    createdAt: new Date('2026-07-27T12:00:00.000Z'),
  });

  const withdrawal = (): WithdrawalRecord => ({
    id: WITHDRAWAL,
    userId: owner,
    assetId: 'USDT',
    amount: amt('40'),
    rail: 'card-sandbox',
    destination: { kind: 'bank', ref: 'DE89370400440532013000' },
    clientRef: 'w-1',
    railRef: 'po_1',
    attempts: 0,
    failureCode: null,
    status: 'sent',
    createdAt: new Date('2026-07-27T12:00:00.000Z'),
  });

  const service = {
    credit: record('credit', deposit),
    withdraw: record('withdraw', withdrawal),
    getWithdrawal: record('getWithdrawal', withdrawal),
    listWithdrawals: record('listWithdrawals', () => [withdrawal()]),
    availableBalance: record('availableBalance', () => amt('60.5')),
  } as unknown as UserMoneyService;

  return {
    service,
    calls,
    fail: (err) => {
      nextError = err;
    },
    ownedBy: (userId) => {
      owner = userId;
    },
  };
}

const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'router-test-secret-at-least-32-characters' })]);

let stub: Stub;
let money: MoneyStub;
let router: ReturnType<typeof createPayRouter>;

beforeEach(() => {
  stub = stubService();
  money = stubUserMoney();
  router = createPayRouter(stub.service, rails, money.service);
});

const caller = async (scopes: string[], opts?: Parameters<typeof ctx>[1]) => router.createCaller(await ctx(scopes, opts));

// ── Money on the wire ────────────────────────────────────────────────────────

describe('money crosses this boundary as a decimal string', () => {
  it('accepts a decimal string and hands the service a scaled bigint', async () => {
    const api = await caller(['pay:write']);
    await api.payment.create({
      merchantId: MERCHANT,
      amount: '100.5',
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });

    const call = stub.calls.find((c) => c.method === 'createPayment')!;
    const input = call.args[0] as { amount: unknown };
    // Parsed at the boundary, so the service never sees a string it has to
    // remember to parse — the one place a float could get in.
    expect(typeof input.amount).toBe('bigint');
    expect(input.amount).toBe(amt('100.5'));
  });

  it('REJECTS A JSON NUMBER, which is how a float gets into a payments book', async () => {
    const api = await caller(['pay:write']);
    await expect(
      api.payment.create({
        merchantId: MERCHANT,
        // An untyped HTTP caller doing arithmetic in JavaScript sends this.
        amount: 100.5 as never,
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
      }),
    ).rejects.toThrow();

    expect(stub.calls.filter((c) => c.method === 'createPayment')).toHaveLength(0);
  });

  it('rejects more precision than the ledger carries', async () => {
    const api = await caller(['pay:write']);
    await expect(
      api.payment.create({
        merchantId: MERCHANT,
        // 19 decimal places. The ledger reconciles to 18; silently truncating
        // the last digit is a rounding decision nobody made.
        amount: '1.0000000000000000001',
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
      }),
    ).rejects.toThrow();
  });

  it('accepts exactly 18 decimal places', async () => {
    const api = await caller(['pay:write']);
    await expect(
      api.payment.create({
        merchantId: MERCHANT,
        amount: '1.000000000000000001',
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a negative amount, an empty string, and prose', async () => {
    const api = await caller(['pay:write']);
    for (const amount of ['-1', '', 'one hundred', '1e3', '0x10', ' 1 ']) {
      await expect(
        api.payment.create({ merchantId: MERCHANT, amount, assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' }),
      ).rejects.toThrow();
    }
    expect(stub.calls.filter((c) => c.method === 'createPayment')).toHaveLength(0);
  });

  it('returns every amount as a decimal string, never a bigint or a number', async () => {
    const api = await caller(['pay:write']);
    const payment = await api.payment.capture({ paymentId: PAYMENT });

    expect(payment.amount).toBe('100');
    expect(payment.capturedAmount).toBe('100');
    expect(payment.refundedAmount).toBe('0');
    for (const value of [payment.amount, payment.capturedAmount, payment.refundedAmount]) {
      expect(typeof value).toBe('string');
    }
    // And the whole response survives JSON, which a bigint would not.
    expect(() => JSON.stringify(payment)).not.toThrow();
  });

  it('returns settlement gross, fees and net as decimal strings that still add up', async () => {
    const api = await caller(['pay:write']);
    const settlement = await api.settlement.run({ merchantId: MERCHANT, window: '2026-07-27', assetId: 'USDT' });

    expect(settlement).toMatchObject({ gross: '100', fees: '2.5', net: '97.5' });
    expect(formatAmount(amt(settlement.fees) + amt(settlement.net))).toBe(settlement.gross);
  });

  it('reports merchant balances from the ledger as decimal strings', async () => {
    const api = await caller(['pay:read']);
    await expect(api.merchant.balances({ merchantId: MERCHANT, assetId: 'USDT' })).resolves.toEqual({
      clearing: '100.5',
      available: '97.5',
    });
  });

  it('passes an optional capture amount through as a bigint, and omits it when absent', async () => {
    const api = await caller(['pay:write']);

    await api.payment.capture({ paymentId: PAYMENT, amount: '60' });
    expect((stub.calls.at(-1)!.args[1] as { amount: unknown }).amount).toBe(amt('60'));

    await api.payment.capture({ paymentId: PAYMENT });
    // Not `{ amount: undefined }` — the service branches on the key's presence,
    // and an explicit undefined would read as "capture zero".
    expect(stub.calls.at(-1)!.args[1]).toEqual({});
  });
});

// ── Error mapping ────────────────────────────────────────────────────────────

describe('a caller can tell the failures apart', () => {
  const codeOf = async (err: unknown) => (err as { code?: string }).code;

  it('maps a declined card to BAD_REQUEST — the merchant retries with another instrument', async () => {
    stub.fail(new PayError('Issuer declined', 'pay.rail_declined', { failureCode: 'card.declined' }));
    const api = await caller(['pay:write']);

    const err = await api.payment.authorize({ paymentId: PAYMENT }).catch((e: unknown) => e);
    expect(await codeOf(err)).toBe('BAD_REQUEST');
    // The code travels in the message so a client branches on it rather than
    // parsing prose.
    expect((err as Error).message).toContain('pay.rail_declined');
  });

  it('maps an over-capture to CONFLICT — the integration is wrong, retrying will not help', async () => {
    stub.fail(new PayError('too much', 'pay.capture_exceeds_authorized'));
    const api = await caller(['pay:write']);

    const err = await api.payment.capture({ paymentId: PAYMENT }).catch((e: unknown) => e);
    expect(await codeOf(err)).toBe('CONFLICT');
  });

  it('maps an over-refund and a double-spend guard to CONFLICT', async () => {
    for (const code of [
      'pay.refund_exceeds_captured',
      'pay.nothing_captured',
      'pay.refund_in_flight',
      'pay.settlement_in_flight',
      'pay.settlement_desynced',
      'pay.invalid_transition',
    ] as const) {
      stub.fail(new PayError('nope', code));
      const api = await caller(['pay:refund']);
      const err = await api.payment.refund({ paymentId: PAYMENT, amount: '1' }).catch((e: unknown) => e);
      expect(await codeOf(err)).toBe('CONFLICT');
    }
  });

  it('maps an unavailable rail to BAD_REQUEST and keeps the rail code for the operator', async () => {
    stub.fail(new PayError('Acquirer unavailable', 'pay.rail_failed', { failureCode: 'acquirer.unavailable' }));
    const api = await caller(['pay:write']);

    const err = await api.payment.capture({ paymentId: PAYMENT }).catch((e: unknown) => e);
    expect(await codeOf(err)).toBe('BAD_REQUEST');
    expect((err as Error).message).toContain('pay.rail_failed');
  });

  it('maps a missing payment to NOT_FOUND', async () => {
    stub.fail(new PayError('gone', 'pay.payment_not_found'));
    const api = await caller(['pay:read']);
    expect(await codeOf(await api.payment.get({ paymentId: PAYMENT }).catch((e: unknown) => e))).toBe('NOT_FOUND');
  });

  it('maps a suspended merchant to FORBIDDEN, not to a validation error', async () => {
    stub.fail(new PayError('suspended', 'pay.merchant_inactive'));
    const api = await caller(['pay:write']);
    const err = await api.payment
      .create({ merchantId: MERCHANT, amount: '1', assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' })
      .catch((e: unknown) => e);
    expect(await codeOf(err)).toBe('FORBIDDEN');
  });

  it('maps a failed webhook verification to UNAUTHORIZED', async () => {
    stub.fail(new PayError('bad signature', 'pay.webhook_invalid'));
    const api = await caller(['pay:write']);
    const err = await api.settlement.run({ merchantId: MERCHANT, window: 'w', assetId: 'USDT' }).catch((e: unknown) => e);
    expect(await codeOf(err)).toBe('UNAUTHORIZED');
  });

  it('lets a non-PayError through untranslated rather than mislabelling it', async () => {
    // An InsufficientFundsError from the ledger is not a bad request; dressing
    // it up as one would tell a merchant to retry something that cannot succeed.
    stub.fail(new Error('ledger.insufficient_funds'));
    const api = await caller(['pay:refund']);
    const err = await api.payment.refund({ paymentId: PAYMENT, amount: '1' }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('ledger.insufficient_funds');
  });
});

// ── Authority ────────────────────────────────────────────────────────────────

describe('authority', () => {
  it('serves health to anyone, and names the registered rails', async () => {
    const api = await caller([]);
    await expect(api.health()).resolves.toEqual({ ok: true, service: 'svc-pay', rails: ['card-sandbox'] });
  });

  it('refuses an anonymous caller everywhere else', async () => {
    const api = await caller([]);
    await expect(api.payment.get({ paymentId: PAYMENT })).rejects.toThrow(/Authentication required/);
    await expect(api.railHealth()).rejects.toThrow(/Authentication required/);
  });

  it('TAKING A PAYMENT DOES NOT GRANT REFUNDING IT', async () => {
    const api = await caller(['pay:write']);
    // `pay:write` implies `pay:read` and nothing else. Money going back out is
    // its own authority.
    await expect(api.payment.refund({ paymentId: PAYMENT, amount: '1' })).rejects.toThrow(/pay:refund/);
    expect(stub.calls.filter((c) => c.method === 'refund')).toHaveLength(0);
  });

  it('does not let a refunder move a settlement out of the book', async () => {
    const api = await caller(['pay:refund']);
    await expect(
      api.settlement.payout({
        settlementId: SETTLEMENT,
        railId: 'card-sandbox',
        destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
      }),
    ).rejects.toThrow(/pay:payout/);
  });

  it('REQUIRES MFA on settlement.payout — pay:payout is INTERACTIVE_ONLY', async () => {
    // Engine C: the scope table marks pay:payout interactive-only; until this
    // endpoint is pinned, a stolen single-factor session could drain settlements.
    const api = await caller(['pay:payout'], { mfa: false });
    const err = await api.settlement
      .payout({
        settlementId: SETTLEMENT,
        railId: 'card-sandbox',
        destination: { kind: 'bank', ref: 'X' },
      })
      .catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('UNAUTHORIZED');
    expect((err as Error).message).toMatch(/two-factor/i);
    expect(stub.calls.filter((c) => c.method === 'payoutSettlement')).toHaveLength(0);
    expect(INTERACTIVE_ONLY_SCOPES).toContain('pay:payout');
    expect(() => assertKeyScopesAllowed(['pay:payout'])).toThrow(/interactive/i);
  });

  it('REFUSES default SESSION_SCOPES on merchant money procedures', async () => {
    // pay:* are WITHHELD_FROM_SESSION — a normal login must never capture/refund/payout.
    // Do not invent a grant path here; only lock the refuse.
    const sessionScopes = [...SESSION_SCOPES];
    expect(sessionScopes).not.toEqual(expect.arrayContaining(['pay:read', 'pay:write', 'pay:refund', 'pay:payout']));

    for (const scope of sessionScopes) {
      const api = await caller([scope]);
      await expect(
        api.payment.create({
          merchantId: MERCHANT,
          amount: '1',
          assetId: 'USDT',
          method: 'card',
          railAdapter: 'card-sandbox',
        }),
      ).rejects.toThrow(/pay:write/);
      await expect(api.payment.refund({ paymentId: PAYMENT, amount: '1' })).rejects.toThrow(/pay:refund/);
      await expect(
        api.settlement.payout({
          settlementId: SETTLEMENT,
          railId: 'card-sandbox',
          destination: { kind: 'bank', ref: 'X' },
        }),
      ).rejects.toThrow(/pay:payout/);
    }
    expect(stub.calls.filter((c) => c.method === 'createPayment')).toHaveLength(0);
    expect(stub.calls.filter((c) => c.method === 'refund')).toHaveLength(0);
    expect(stub.calls.filter((c) => c.method === 'payoutSettlement')).toHaveLength(0);
  });

  it('lets each write scope read, because seeing what you changed is implied', async () => {
    for (const scope of ['pay:write', 'pay:refund', 'pay:payout']) {
      const api = await caller([scope]);
      await expect(api.payment.get({ paymentId: PAYMENT })).resolves.toMatchObject({ id: PAYMENT });
    }
  });

  it('does not let a reader write', async () => {
    const api = await caller(['pay:read']);
    await expect(
      api.payment.create({ merchantId: MERCHANT, amount: '1', assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' }),
    ).rejects.toThrow(/pay:write/);
  });

  it('does not accept another module’s scope', async () => {
    const api = await caller(['trade:write']);
    await expect(api.payment.get({ paymentId: PAYMENT })).rejects.toThrow(/pay:read/);
  });

  it('applies the jurisdiction matrix: pay is custodial, so `full` verification is the floor', async () => {
    // §22 — the sovereignty law follows custody. Settlement lands in a ledger
    // account we control, so this is the Fiat Plane and tiering applies.
    for (const tier of ['none', 'basic'] as const) {
      const api = await caller(['pay:write'], { tier });
      await expect(
        api.payment.create({ merchantId: MERCHANT, amount: '1', assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' }),
      ).rejects.toThrow(/full/);
    }

    const verified = await caller(['pay:write'], { tier: 'full' });
    await expect(
      verified.payment.create({ merchantId: MERCHANT, amount: '1', assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' }),
    ).resolves.toBeDefined();
  });

  it('validates identifiers at the boundary before the service is touched', async () => {
    const api = await caller(['pay:read']);
    await expect(api.payment.get({ paymentId: 'not-a-uuid' })).rejects.toThrow();
    await expect(api.merchant.balances({ merchantId: MERCHANT, assetId: '' })).rejects.toThrow();
    expect(stub.calls).toHaveLength(0);
  });
});

// ── Ownership ────────────────────────────────────────────────────────────────

/**
 * A scope answers "may this principal do this KIND of thing". It has never
 * answered "may they do it to THIS row", and `pay:read` is held by every
 * merchant on the platform.
 *
 * Each procedure gets two tests, and the second is the one that catches the
 * worse bug: a check tight enough to lock the owner out of their own payments
 * is a self-inflicted outage, where the IDOR is at least only a breach of one
 * record at a time.
 */
describe('a merchant reaches their own rows and nobody else’s', () => {
  /** A second merchant, owned by a different user, with the same MERCHANT id. */
  const ANOTHER_USER = '88888888-8888-4888-8888-888888888888';

  const codeOf = (err: unknown) => (err as { code?: string }).code;

  it('refuses payment.get on another merchant’s payment', async () => {
    stub.ownedBy(ANOTHER_USER);
    const api = await caller(['pay:read']);

    const err = await api.payment.get({ paymentId: PAYMENT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('still serves payment.get to the merchant who owns it', async () => {
    const api = await caller(['pay:read']);
    await expect(api.payment.get({ paymentId: PAYMENT })).resolves.toMatchObject({ id: PAYMENT, merchantId: MERCHANT });
  });

  it('refuses payment.history on another merchant’s payment, and never reads the log', async () => {
    stub.ownedBy(ANOTHER_USER);
    const api = await caller(['pay:read']);

    const err = await api.payment.history({ paymentId: PAYMENT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    // Refused before the read, not after it. `payment_events` carries
    // instrument metadata and customer references; not returning it is not the
    // same as not fetching it.
    expect(stub.calls.filter((c) => c.method === 'history')).toHaveLength(0);
  });

  it('still serves payment.history to the merchant who owns it', async () => {
    const api = await caller(['pay:read']);
    const history = await api.payment.history({ paymentId: PAYMENT });
    expect(history).toHaveLength(1);
    expect(stub.calls.filter((c) => c.method === 'history')).toHaveLength(1);
  });

  it('refuses settlement.get on another merchant’s settlement', async () => {
    stub.ownedBy(ANOTHER_USER);
    const api = await caller(['pay:read']);

    const err = await api.settlement.get({ settlementId: SETTLEMENT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('still serves settlement.get to the merchant who owns it', async () => {
    const api = await caller(['pay:read']);
    await expect(api.settlement.get({ settlementId: SETTLEMENT })).resolves.toMatchObject({
      id: SETTLEMENT,
      gross: '100',
      net: '97.5',
    });
  });

  it('owner can list settlements for a merchant', async () => {
    const api = await caller(['pay:read']);
    const rows = await api.settlement.list({ merchantId: MERCHANT, status: 'posted' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.gross).toBe('100');
    expect(rows[0]!.net).toBe('97.5');
    expect(stub.calls.filter((c) => c.method === 'listSettlements')).toHaveLength(1);
  });

  it('refuses settlement.list on another merchant, and never lists', async () => {
    stub.ownedBy(ANOTHER_USER);
    const api = await caller(['pay:read']);
    const err = await api.settlement.list({ merchantId: MERCHANT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method === 'listSettlements')).toHaveLength(0);
  });

  it('routing.assertInputs refuses missing geo without inventing a country', async () => {
    const api = await caller([]);
    const err = await api.routing.assertInputs({ required: ['geo'], method: 'card', riskBand: 'low' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('BAD_REQUEST');
    expect(String((err as { message?: string }).message ?? err)).toMatch(/pay\.routing_input_missing/);
  });

  it('routing.assertInputs passes when required dimensions are present', async () => {
    const api = await caller([]);
    await expect(
      api.routing.assertInputs({
        required: ['geo', 'method', 'risk'],
        geoCountry: 'DE',
        method: 'crypto',
        riskBand: 'external:ok',
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('routing.select refuses missing geo/method/risk on the public door', async () => {
    const api = await caller([]);
    const err = await api.routing.select({ preference: ['card-sandbox'], method: 'card', riskBand: 'low' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('BAD_REQUEST');
    expect(String((err as { message?: string }).message ?? err)).toMatch(/pay\.routing_input_missing/);
  });

  it('routing.select chooses card-sandbox for card + eligible geo/risk', async () => {
    const api = await caller([]);
    const out = await api.routing.select({
      preference: ['crypto-native', 'card-sandbox'],
      geoCountry: 'DE',
      method: 'card',
      riskBand: 'low',
      policy: 'allow-sandbox',
    });
    expect(out.chosenRailId).toBe('card-sandbox');
    expect(out.inputs).toEqual({ geoCountry: 'DE', method: 'card', riskBand: 'low' });
    expect(out.decision.kind).toBe('pay.routing.decision');
    expect(out.decision).not.toHaveProperty('approvalRate');
    expect(out.decision).not.toHaveProperty('costBps');
    const cryptoSkip = out.considered.find((e: { railId: string }) => e.railId === 'crypto-native');
    expect(cryptoSkip).toMatchObject({ outcome: 'skipped', reason: 'method-mismatch' });
  });

  it('routing.select returns PRECONDITION_FAILED when no rail matches', async () => {
    const api = await caller([]);
    const err = await api.routing
      .select({
        preference: ['card-sandbox'],
        geoCountry: 'DE',
        method: 'card',
        riskBand: 'high',
        policy: 'allow-sandbox',
        profiles: [{ railId: 'card-sandbox', methods: ['card'], countries: ['*'], riskBands: ['low'] }],
      })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PRECONDITION_FAILED');
    expect(String((err as { message?: string }).message ?? err)).toMatch(/pay\.routing_no_rail/);
  });

  it('fraud.evaluate declines a blocklisted IP with a reason', async () => {
    const api = await caller([]);
    const d = await api.fraud.evaluate({
      merchantId: MERCHANT,
      amount: '10',
      assetId: 'USDT',
      ip: '203.0.113.9',
      blocklists: { ips: ['203.0.113.9'] },
    });
    expect(d.outcome).toBe('decline');
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons[0]!.ruleId).toBe('blocklist_ip');
  });

  it('plugins.publicBase exposes the public API path for integrators', async () => {
    const api = await caller([]);
    await expect(api.plugins.publicBase()).resolves.toEqual({ base: '/api/pay/v1' });
  });

  it('refuses with FORBIDDEN rather than NOT_FOUND, consistently, on all three', async () => {
    stub.ownedBy(ANOTHER_USER);
    const api = await caller(['pay:read']);

    // Stated as its own test because the value here is the CONSISTENCY: a
    // client that learns to branch on one of these must be able to branch on
    // all of them. See `assertMerchantOwner` for why this direction was chosen.
    const codes = await Promise.all(
      [
        api.payment.get({ paymentId: PAYMENT }),
        api.payment.history({ paymentId: PAYMENT }),
        api.settlement.get({ settlementId: SETTLEMENT }),
      ].map((p) => p.catch((e: unknown) => codeOf(e))),
    );
    expect(codes).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
  });

  it('refuses payment.capture on another merchant’s payment before the rail runs', async () => {
    stub.ownedBy(ANOTHER_USER);
    const api = await caller(['pay:write']);
    const err = await api.payment.capture({ paymentId: PAYMENT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method === 'capture')).toHaveLength(0);
  });

  it('refuses settlement.payout on another merchant’s settlement before the rail runs', async () => {
    stub.ownedBy(ANOTHER_USER);
    const api = await caller(['pay:payout'], { mfa: true });
    const err = await api.settlement
      .payout({ settlementId: SETTLEMENT, railId: 'card-sandbox', destination: { kind: 'bank', ref: 'GB82WEST12345698765432' } })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect(stub.calls.filter((c) => c.method === 'payoutSettlement')).toHaveLength(0);
  });

  it('binds merchant.create to the principal, not a body userId', async () => {
    const api = await caller(['pay:write']);
    await api.merchant.create({ mode: 'gateway', pricing: { feeBps: 250 } });
    const call = stub.calls.find((c) => c.method === 'createMerchant');
    expect(call).toBeDefined();
    expect((call!.args[0] as { userId: string }).userId).toBe(USER);
  });
});

// ── Read surfaces ────────────────────────────────────────────────────────────

describe('read surfaces', () => {
  it('serialises the append-only history with ISO timestamps', async () => {
    const api = await caller(['pay:read']);
    const history = await api.payment.history({ paymentId: PAYMENT });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ event: 'created', railEventId: null });
    expect(history[0]!.ts).toBe('2026-07-27T12:00:00.000Z');
  });

  it('reports rail capability and health for the operator console', async () => {
    const api = await caller(['pay:read']);
    const health = await api.railHealth();

    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ id: 'card-sandbox', healthy: true, usable: true });
    expect(health[0]!.capabilities).toContain('refund');
  });
});

// ── User money in: the operator deposit ──────────────────────────────────────

/**
 * `deposit.credit` credits a user's spendable balance. Every test here asks the
 * same question: could the BENEFICIARY have called this?
 */
describe('deposit.credit is operator-credentialed, never user-facing', () => {
  const codeOf = (err: unknown) => (err as { code?: string }).code;
  const body = { userId: USER, assetId: 'USDT', amount: '100', railId: 'card-sandbox', railRef: 'psp_1' };

  it('serves an operator holding admin:treasury with a second factor', async () => {
    const api = await caller(['admin:treasury']);
    await expect(api.deposit.credit(body)).resolves.toMatchObject({ id: DEPOSIT, status: 'credited' });
  });

  it('REFUSES EVERY SCOPE A USER SESSION ACTUALLY CARRIES', async () => {
    // Read from SESSION_SCOPES, not copied from it — so a scope added to a
    // session in a later PR is tested here on the day it is added rather than
    // whenever someone remembers this list exists. If any of these ever reaches
    // this procedure, a user can credit their own balance and the platform
    // mints money on request.
    const sessionScopes = [...SESSION_SCOPES];

    for (const scope of sessionScopes) {
      const api = await caller([scope]);
      expect(codeOf(await api.deposit.credit(body).catch((e: unknown) => e))).toBe('FORBIDDEN');
    }
    // Not even all of them at once.
    const everything = await caller(sessionScopes);
    expect(codeOf(await everything.deposit.credit(body).catch((e: unknown) => e))).toBe('FORBIDDEN');
    expect(money.calls.filter((c) => c.method === 'credit')).toHaveLength(0);
  });

  it('refuses the merchant scopes too — taking a payment is not minting a balance', async () => {
    for (const scope of ['pay:write', 'pay:refund', 'pay:payout']) {
      const api = await caller([scope]);
      expect(codeOf(await api.deposit.credit(body).catch((e: unknown) => e))).toBe('FORBIDDEN');
    }
  });

  it('refuses an anonymous caller', async () => {
    const api = await caller([]);
    await expect(api.deposit.credit(body)).rejects.toThrow(/Authentication required/);
  });

  it('REQUIRES A SECOND FACTOR — admin:treasury is INTERACTIVE_ONLY', async () => {
    const api = await caller(['admin:treasury'], { mfa: false });
    const err = await api.deposit.credit(body).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect((err as Error).message).toMatch(/two-factor/i);
    expect(money.calls.filter((c) => c.method === 'credit')).toHaveLength(0);
  });

  it('can never be granted to a long-lived API key', async () => {
    // The other half of the INTERACTIVE_ONLY protection, and the reason this
    // scope was chosen: a leaked bot key cannot reach this endpoint at all.
    expect(INTERACTIVE_ONLY_SCOPES).toContain('admin:treasury');
    expect(() => assertKeyScopesAllowed(['admin:treasury'])).toThrow(/interactive/i);
  });

  it('names the CALLER as the crediting operator, whatever the body says', async () => {
    const operator = '55555555-5555-4555-8555-555555555551';
    const api = await caller(['admin:treasury'], { userId: operator });
    await api.deposit.credit({ ...body, creditedBy: 'somebody-else' } as never);

    const call = money.calls.find((c) => c.method === 'credit')!;
    expect((call.args[0] as { creditedBy: string }).creditedBy).toBe(operator);
  });

  it('takes money as a decimal string and hands the service a scaled bigint', async () => {
    const api = await caller(['admin:treasury']);
    await api.deposit.credit({ ...body, amount: '100.000000000000000001' });

    const call = money.calls.find((c) => c.method === 'credit')!;
    expect((call.args[0] as { amount: unknown }).amount).toBe(amt('100.000000000000000001'));
  });

  it('rejects a JSON number, a negative amount, and more precision than the ledger carries', async () => {
    const api = await caller(['admin:treasury']);
    for (const amount of [100.5 as never, '-1', '', '1e3', '1.0000000000000000001']) {
      await expect(api.deposit.credit({ ...body, amount })).rejects.toThrow();
    }
    expect(money.calls).toHaveLength(0);
  });

  it('requires a rail reference — it is half the idempotency key', async () => {
    const api = await caller(['admin:treasury']);
    await expect(api.deposit.credit({ ...body, railRef: '' })).rejects.toThrow();
    expect(money.calls).toHaveLength(0);
  });

  it('maps a reused rail reference to CONFLICT, so a client does not retry it forever', async () => {
    money.fail(new PayError('already credited as 5', 'pay.deposit_conflict'));
    const api = await caller(['admin:treasury']);
    expect(codeOf(await api.deposit.credit(body).catch((e: unknown) => e))).toBe('CONFLICT');
  });

  it('maps a non-creditable rail to FORBIDDEN and an unknown one to BAD_REQUEST', async () => {
    money.fail(new PayError('not creditable', 'pay.rail_not_creditable'));
    const forbidden = await caller(['admin:treasury']);
    expect(codeOf(await forbidden.deposit.credit(body).catch((e: unknown) => e))).toBe('FORBIDDEN');

    money.fail(new PayError('no such rail', 'pay.rail_unknown'));
    const bad = await caller(['admin:treasury']);
    expect(codeOf(await bad.deposit.credit(body).catch((e: unknown) => e))).toBe('BAD_REQUEST');
  });

  it('never returns the crediting operator to the wire', async () => {
    const api = await caller(['admin:treasury']);
    const record = await api.deposit.credit(body);
    expect(JSON.stringify(record)).not.toContain('operator-identity-that-must-not-leak');
  });
});

// ── User money out: the withdrawal ───────────────────────────────────────────

describe('withdrawal.create is the interactive, 2FA-backed path off the platform', () => {
  const codeOf = (err: unknown) => (err as { code?: string }).code;
  const body = {
    assetId: 'USDT',
    amount: '40',
    railId: 'card-sandbox',
    destination: { kind: 'bank', ref: 'DE89370400440532013000' },
    clientRef: 'w-1',
  };

  it('serves an elevated session holding trade:withdraw', async () => {
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    await expect(api.withdrawal.create(body)).resolves.toMatchObject({ id: WITHDRAWAL, status: 'sent' });
  });

  it('REQUIRES MFA — the INTERACTIVE_ONLY guarantee, verified on THIS endpoint', async () => {
    // `trade:withdraw` is in INTERACTIVE_ONLY_SCOPES, so `requireScope` refuses
    // a session that has not passed 2FA even though the scope is present.
    // Asserted against the real procedure, not against the guard in isolation.
    const api = await caller(['trade:withdraw'], { tier: 'basic', mfa: false });
    const err = await api.withdrawal.create(body).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('UNAUTHORIZED');
    expect((err as Error).message).toMatch(/two-factor/i);
    expect(money.calls.filter((c) => c.method === 'withdraw')).toHaveLength(0);
  });

  it('can never be granted to a long-lived API key', async () => {
    expect(INTERACTIVE_ONLY_SCOPES).toContain('trade:withdraw');
    expect(() => assertKeyScopesAllowed(['trade:read', 'trade:withdraw'])).toThrow(/trade:withdraw/);
    // A bot key with everything else is still refused this one.
    expect(() => assertKeyScopesAllowed(['trade:read', 'trade:write'])).not.toThrow();
  });

  it('IS NOT REACHABLE FROM A NORMAL SESSION — trade:write does not imply it', async () => {
    // `defaultScopes()` withholds `trade:withdraw`; `auth.stepUp` is what adds
    // it. If `trade:write` ever implied it, an XSS-stolen access token would
    // drain accounts.
    const api = await caller(['trade:write', 'trade:read', 'ledger:read'], { tier: 'basic' });
    const err = await api.withdrawal.create(body).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as Error).message).toContain('trade:withdraw');
  });

  it('refuses an anonymous caller', async () => {
    const api = await caller([]);
    await expect(api.withdrawal.create(body)).rejects.toThrow(/Authentication required/);
  });

  it('applies the LEDGER matrix rule — `basic`, the tier that admitted the value', async () => {
    // `{ module: 'ledger' }`: the rule that governs moving a custodial balance
    // out is the rule for the module that holds it. Gating above the tier that
    // admitted the value would build a one-way door.
    const unverified = await caller(['trade:withdraw'], { tier: 'none' });
    const err = await unverified.withdrawal.create(body).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect((err as Error).message).toMatch(/basic/);

    const verified = await caller(['trade:withdraw'], { tier: 'basic' });
    await expect(verified.withdrawal.create(body)).resolves.toBeDefined();
  });

  it('takes the account from the token — there is no userId to tamper with', async () => {
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    await api.withdrawal.create({ ...body, userId: '66666666-6666-4666-8666-666666666667' } as never);

    const call = money.calls.find((c) => c.method === 'withdraw')!;
    expect((call.args[0] as { userId: string }).userId).toBe(USER);
  });

  it('REQUIRES clientRef — without one a retry is a second debit', async () => {
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    await expect(api.withdrawal.create({ ...body, clientRef: undefined } as never)).rejects.toThrow();
    await expect(api.withdrawal.create({ ...body, clientRef: '' })).rejects.toThrow();
    expect(money.calls).toHaveLength(0);
  });

  it('takes money as a decimal string and hands the service a scaled bigint', async () => {
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    await api.withdrawal.create({ ...body, amount: '40.000000000000000001' });

    const call = money.calls.find((c) => c.method === 'withdraw')!;
    expect((call.args[0] as { amount: unknown }).amount).toBe(amt('40.000000000000000001'));
  });

  it('rejects a JSON number and a negative amount at the boundary', async () => {
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    for (const amount of [40.5 as never, '-1', '', 'forty']) {
      await expect(api.withdrawal.create({ ...body, amount })).rejects.toThrow();
    }
    expect(money.calls).toHaveLength(0);
  });

  it('requires a destination with somewhere to send to', async () => {
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    await expect(api.withdrawal.create({ ...body, destination: { kind: 'bank', ref: '' } })).rejects.toThrow();
    await expect(api.withdrawal.create({ ...body, destination: { kind: '', ref: 'GB82WEST12345698765432' } })).rejects.toThrow();
    expect(money.calls).toHaveLength(0);
  });

  it('returns every amount as a decimal string that survives JSON', async () => {
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    const record = await api.withdrawal.create(body);

    expect(record.amount).toBe('40');
    expect(typeof record.amount).toBe('string');
    expect(() => JSON.stringify(record)).not.toThrow();
  });

  it('maps a rail refusal to BAD_REQUEST and keeps the rail code', async () => {
    money.fail(new PayError('Beneficiary account closed', 'pay.rail_failed', { failureCode: 'bank.rejected' }));
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    const err = await api.withdrawal.create(body).catch((e: unknown) => e);

    expect(codeOf(err)).toBe('BAD_REQUEST');
    expect((err as Error).message).toContain('pay.rail_failed');
  });

  it('maps a reused client reference to CONFLICT', async () => {
    money.fail(new PayError('already names a withdrawal', 'pay.withdrawal_conflict'));
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    expect(codeOf(await api.withdrawal.create(body).catch((e: unknown) => e))).toBe('CONFLICT');
  });

  it('lets an insufficient-funds error through untranslated', async () => {
    // Not a BAD_REQUEST dressed up: a client that retries a withdrawal it
    // cannot afford just fails again.
    money.fail(new Error('ledger.insufficient_funds'));
    const api = await caller(['trade:withdraw'], { tier: 'basic' });
    const err = await api.withdrawal.create(body).catch((e: unknown) => e);
    expect((err as Error).message).toContain('ledger.insufficient_funds');
  });
});

describe('withdrawal reads', () => {
  const codeOf = (err: unknown) => (err as { code?: string }).code;

  it('are served to an ordinary session, long after the elevation expires', async () => {
    // `trade:read`, not `trade:withdraw`. A user checking whether their money
    // arrived should not have to re-do 2FA five minutes later.
    const api = await caller(['trade:read'], { tier: 'basic' });
    await expect(api.withdrawal.get({ withdrawalId: WITHDRAWAL })).resolves.toMatchObject({ id: WITHDRAWAL });
    await expect(api.withdrawal.mine()).resolves.toHaveLength(1);
  });

  it('REFUSE ANOTHER ACCOUNT’S WITHDRAWAL — a scope is not an ownership check', async () => {
    money.ownedBy('88888888-8888-4888-8888-888888888888');
    const api = await caller(['trade:read'], { tier: 'basic' });

    const err = await api.withdrawal.get({ withdrawalId: WITHDRAWAL }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });

  it('still serve the owner their own withdrawal', async () => {
    const api = await caller(['trade:read'], { tier: 'basic' });
    await expect(api.withdrawal.get({ withdrawalId: WITHDRAWAL })).resolves.toMatchObject({ id: WITHDRAWAL, userId: USER });
  });

  it('map a missing withdrawal to NOT_FOUND', async () => {
    money.fail(new PayError('gone', 'pay.withdrawal_not_found'));
    const api = await caller(['trade:read'], { tier: 'basic' });
    expect(codeOf(await api.withdrawal.get({ withdrawalId: WITHDRAWAL }).catch((e: unknown) => e))).toBe('NOT_FOUND');
  });

  it('report the withdrawable balance from the ledger, as a decimal string', async () => {
    const api = await caller(['ledger:read'], { tier: 'basic' });
    await expect(api.withdrawal.balance({ assetId: 'USDT' })).resolves.toEqual({ available: '60.5' });
  });

  it('do not let a bare merchant scope read a user’s withdrawals', async () => {
    const api = await caller(['pay:read']);
    expect(codeOf(await api.withdrawal.get({ withdrawalId: WITHDRAWAL }).catch((e: unknown) => e))).toBe('FORBIDDEN');
    expect(codeOf(await api.withdrawal.balance({ assetId: 'USDT' }).catch((e: unknown) => e))).toBe('FORBIDDEN');
  });
});

// ── The public checkout contract ─────────────────────────────────────────────
//
// `checkout.open` is a `publicProcedure` that takes money from somebody who is
// not logged in. There is no principal, so there is no scope to protect it with
// — which means the CONTRACT is the protection, and these tests are what say so.

describe('hosted checkout is public, and safe because of its shape', () => {
  const codeOf = (err: unknown) => (err as { code?: string }).code;

  it('serves an anonymous caller with no principal at all', async () => {
    const api = await caller([]);
    await expect(api.checkout.open({ token: 'pl_a_link_token_value' })).resolves.toMatchObject({
      sessionToken: 'cs_generated_session_token',
    });
    await expect(api.checkout.status({ sessionToken: 'cs_generated_session_token' })).resolves.toMatchObject({ status: 'open' });
  });

  /**
   * THE INPUT THAT DOES NOT EXIST. There is no `railAdapter` on `checkout.open`
   * and there will not be one — a hosted checkout that can name a rail is the
   * route back to the sandbox-withdrawal P0, this time with a stranger's money.
   * zod strips it, and this test fails the day somebody adds it.
   */
  it('gives the caller no way to name a rail', async () => {
    const api = await caller([]);
    await api.checkout.open({ token: 'pl_a_link_token_value', railAdapter: 'card-sandbox' } as never);

    const call = stub.calls.find((c) => c.method === 'openCheckoutSession')!;
    expect(call.args[0]).toEqual({
      linkToken: 'pl_a_link_token_value',
      amount: undefined,
      assetId: undefined,
      geoCountry: undefined,
      method: undefined,
    });
    expect(JSON.stringify(call.args[0])).not.toContain('card-sandbox');
  });

  it('takes a payer amount as a decimal string and hands the service a scaled bigint', async () => {
    const api = await caller([]);
    await api.checkout.open({ token: 'pl_a_link_token_value', amount: '7.25', assetId: 'USDT' });

    const call = stub.calls.find((c) => c.method === 'openCheckoutSession')!;
    expect(call.args[0]).toMatchObject({ amount: amt('7.25'), assetId: 'USDT' });
  });

  it('D26-P1-P3: forwards payer country and never a risk band from the public door', async () => {
    const api = await caller([]);
    await api.checkout.open({ token: 'pl_a_link_token_value', geoCountry: 'DE', riskBand: 'low' } as never);
    const call = stub.calls.find((c) => c.method === 'openCheckoutSession')!;
    expect(call.args[0]).toMatchObject({ geoCountry: 'DE' });
    expect(JSON.stringify(call.args[0])).not.toContain('riskBand');
  });

  it('refuses a JSON number for an amount, on the public surface as everywhere else', async () => {
    const api = await caller([]);
    const err = await api.checkout.open({ token: 'pl_a_link_token_value', amount: 7.25 as never }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('BAD_REQUEST');
  });

  /** Nothing in the response identifies anything but this session. */
  it('returns no merchant, payment, link or rail identifier to an anonymous caller', async () => {
    const api = await caller([]);
    const { session } = await api.checkout.open({ token: 'pl_a_link_token_value' });

    const body = JSON.stringify(session);
    expect(body).not.toContain(MERCHANT);
    expect(body).not.toContain(PAYMENT);
    expect(body).not.toContain(LINK);
    expect(body).not.toContain('crypto-native');
    expect(body).not.toContain('card-sandbox');
  });

  /**
   * SERVICE_UNAVAILABLE, not BAD_REQUEST and not INTERNAL_SERVER_ERROR.
   *
   * The request was well-formed and the platform cannot serve it, because it has
   * no rail that would actually take the payer's money. BAD_REQUEST sends a
   * merchant's engineer hunting a bug that is not in their integration; a 500
   * reads as "retry", which is the one thing that can never fix this.
   */
  it('maps a posture refusal to SERVICE_UNAVAILABLE', async () => {
    stub.fail(new PublicCheckoutUnavailable(null, 'sandbox'));
    const api = await caller([]);
    const err = await api.checkout.open({ token: 'pl_a_link_token_value' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('SERVICE_UNAVAILABLE');
  });

  it('maps an exhausted link to CONFLICT and a busy one to TOO_MANY_REQUESTS', async () => {
    const api = await caller([]);

    stub.fail(new PayError('used up', 'pay.link_exhausted'));
    expect(codeOf(await api.checkout.open({ token: 'pl_a_link_token_value' }).catch((e: unknown) => e))).toBe('CONFLICT');

    stub.fail(new PayError('too many', 'pay.checkout_busy'));
    expect(codeOf(await api.checkout.open({ token: 'pl_a_link_token_value' }).catch((e: unknown) => e))).toBe('TOO_MANY_REQUESTS');
  });

  it('maps an unknown session token to NOT_FOUND', async () => {
    stub.fail(new PayError('nope', 'pay.checkout_session_not_found'));
    const api = await caller([]);
    expect(codeOf(await api.checkout.status({ sessionToken: 'cs_unknown_token' }).catch((e: unknown) => e))).toBe('NOT_FOUND');
  });
});

describe('payment links are capability URLs on the wire too', () => {
  const codeOf = (err: unknown) => (err as { code?: string }).code;

  /**
   * The bug this test exists for: `createLink` used to pass `expiresAt: null`
   * when the caller omitted one, and the service reads `null` as "never
   * expires". An omitted expiry has to mean the DEFAULT lifetime, not forever.
   */
  it('passes an omitted expiry through as undefined, never as null', async () => {
    const api = await caller(['pay:write']);
    await api.merchant.createLink({ merchantId: MERCHANT, label: 'Invoice' });

    const call = stub.calls.find((c) => c.method === 'createPaymentLink')!;
    expect((call.args[0] as { expiresAt?: unknown }).expiresAt).toBeUndefined();
  });

  it('returns an expiry the merchant can show, and the bound they asked for', async () => {
    const api = await caller(['pay:write']);
    await expect(api.merchant.createLink({ merchantId: MERCHANT, label: 'Invoice', maxUses: 1 })).resolves.toMatchObject({
      expiresAt: '2026-08-29T00:00:00.000Z',
      maxUses: null,
    });

    const call = stub.calls.find((c) => c.method === 'createPaymentLink')!;
    expect((call.args[0] as { maxUses?: unknown }).maxUses).toBe(1);
  });

  it('refuses a maxUses of zero rather than creating a link nobody can pay', async () => {
    const api = await caller(['pay:write']);
    const err = await api.merchant.createLink({ merchantId: MERCHANT, label: 'Invoice', maxUses: 0 }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('BAD_REQUEST');
  });

  it('still needs pay:write to mint one — a link is a bearer credential', async () => {
    const api = await caller(['pay:read']);
    const err = await api.merchant.createLink({ merchantId: MERCHANT, label: 'Invoice' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
  });
});
