import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import {
  ActionApprovalConsumeError,
  p2pActionPayloadHash,
  stubApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { createP2pRouter } from './router.js';
import {
  assertDisputeListLimit,
  assertLateSettlementsListLimit,
  assertOfferListLimit,
  assertTradeListLimit,
  P2pError,
  type P2pService,
} from './p2p-service.js';
import {
  assertAccessLogLimit,
  assertInstrumentListLimit,
  assertMethodSchemaListLimit,
  type InstrumentService,
} from './instrument-service.js';
import { parseFieldSpecs } from './instruments.js';
import { assertMerchantHistoryLimit } from './merchant-service.js';
import type { MerchantStatus } from './merchant-programme.js';
import { snapshotOf, type ReputationCounters } from './reputation.js';
import { BlockRfqService } from './block-rfq.js';
import { MemoryBlockQuoteStore } from './block-rfq-store.js';

// Attributed local screening fixture: exercise downstream authorization and storage.
// Explicit dev mode accepts this fixture; it is never a production sanctions list.
beforeEach(() => {
  vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
  vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-recovery');
  vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
});
afterEach(() => vi.unstubAllEnvs());

/**
 * THE MOUNT BOUNDARY, for svc-p2p (docs/decisions/mount-boundary.md).
 *
 * Not a test of P2P behaviour — `p2p-service.test.ts` owns that. What this file
 * protects is the one property mounting `/trpc` depends on:
 *
 *   **reaching the port is not sufficient to become someone.**
 *
 * So it builds its context the way `index.ts` does — through `createEdgeContext`
 * over real request headers — rather than by handing the router a `Context`
 * object a test author wrote. A context literal would pass no matter how the
 * service derived its principal in production, which is precisely the bug the
 * decision exists to catch: it would still be green if `index.ts` went back to
 * `JSON.parse(req.headers['x-intafaced-principal'])`.
 *
 * `p2p` is `OPEN_BASIC` in the jurisdiction matrix, so `basic` is the tier floor
 * and neither `p2p:read` nor `p2p:write` is in `INTERACTIVE_ONLY_SCOPES`.
 */

const SECRET = 'a-p2p-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
/** Consumed-row requester. Distinct from the session principal on purpose. */
const REQUESTER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * A consumed identity row. `approverId` null is legal on the wire contract.
 * The requester is never substituted in as the confirming operator.
 */
function consumedApproval(approverId: string | null, requesterId = REQUESTER) {
  return {
    async consume() {
      return {
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-p2p',
        targetId: 'p2p.method_register',
        expectedVersion: '1',
        actionType: 'p2p.method_register',
        requesterId,
        approverId,
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED' as const,
      };
    },
  };
}

/**
 * Copy of `apps/customer/src/features/pay/schemas.ts` `offerSchema` (and its
 * `amount` string). The live board parses `offers.list` with `z.array` of
 * this object. Extra service fields are stripped; a `{ offers, nextCursor }`
 * envelope is not an array and fails the parse.
 */
const customerAmount = z
  .string()
  .refine((value) => {
    try {
      return parseAmount(value) >= 0n;
    } catch {
      return false;
    }
  }, 'Expected an unsigned exact decimal string')
  .refine((value) => /^\d+(\.\d{1,18})?$/.test(value));

const customerOfferSchema = z.object({
  id: z.string().guid(),
  makerId: z.string(),
  side: z.enum(['buy', 'sell']),
  asset: z.string().min(1).max(16),
  fiatCurrency: z.string(),
  priceType: z.enum(['fixed', 'float']),
  price: customerAmount,
  minAmount: customerAmount,
  maxAmount: customerAmount,
  remainingAmount: customerAmount,
  methods: z.array(z.unknown()),
  nonInstantMethods: z.array(z.object({ methodId: z.string(), windowSeconds: z.number().int().positive().nullable() })).optional(),
  acceptsNonInstant: z.boolean().optional(),
  terms: z.string(),
  status: z.enum(['active', 'paused', 'closed']),
  createdAt: z.string(),
});

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['p2p:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

/** No credentials of any kind — a caller who simply found the port. */
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

/** A principal the edge really vouched for. */
function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

/**
 * The forgery. A principal asserted by the caller, with no signature — exactly
 * what a hand-rolled `JSON.parse` context would have believed.
 */
function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'req-forged',
  });
}

function stubP2p(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listOffers: async () => [],
    listOfferBoard: async () => ({ offers: [], nextCursor: null }),
    releasedTradeCounts: async () => new Map<string, number>(),
    tradesInWindow: async () => 0,
    completionRatesOf: async () => ({
      completionRate30d: null,
      completionRateTotal: null,
      completed30d: 0,
      counted30d: 0,
      completedTotal: 0,
      countedTotal: 0,
    }),
    assertNotBlocked: async () => undefined,
    payTimingOf: async () => ({ avgPaySecs: null, paySamples: 0 }),
    // P-trade-orders-15: no reminders on a stubbed order, and the owner's figures unset.
    reminderState: async () => ({ count: 0, lastAt: null, nextAt: null, max: null }),
    mismatchReport: async () => null,
    paymentValidationBlocker: () => 'rail.bank',
    reviewRating: async () => null,
    ...overrides,
  } as unknown as P2pService;
}

/**
 * The instrument half of the router.
 *
 * Every method throws, deliberately: this file is about whether a caller gets
 * PAST the mount at all, and a stub that quietly returned `[]` would let a test
 * pass while the router happily disclosed payment details to an anonymous
 * caller. If anything here is ever reached by an unauthorised request, the test
 * that reached it fails loudly rather than assertively passing.
 */
function stubInstruments(overrides: Partial<Record<string, unknown>> = {}) {
  const refuse = async () => {
    throw new Error('the mount let an unauthorised caller reach a payment instrument');
  };
  return {
    listMethodSchemas: refuse,
    listInstruments: refuse,
    revealOwn: refuse,
    revealForTrade: refuse,
    accessLogFor: refuse,
    // The board's settlement profiles are about methods, not anyone's instrument: every method reads instant here.
    boardSettlements: async () => new Map(),
    ...overrides,
  } as unknown as InstrumentService;
}

const routerFor = (p2p: P2pService, instruments: InstrumentService = stubInstruments()) => createP2pRouter(p2p, instruments);

function merchantStub(status: MerchantStatus | null) {
  return {
    get: async (userId: string) =>
      status === null
        ? null
        : {
            userId,
            status,
            appliedCompletionRate: 1,
            appliedTradesTotal: 100,
            appliedAt: new Date('2026-01-01T00:00:00.000Z'),
            decidedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
  };
}

describe('svc-p2p mount — authorisation', () => {
  it('refuses an anonymous caller on a scoped procedure, and reads nothing', async () => {
    // Shaped like the ledger's: it does not assert on a message, it asserts the
    // service was never asked to do the work.
    let read = false;
    const p2p = stubP2p({
      listOffers: async () => {
        read = true;
        return [];
      },
    });

    await expect(routerFor(p2p).createCaller(anonymous()).offers.list({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(read).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * A caller who writes their own principal header gets nothing. If this fails,
   * the mount is trusting caller-supplied claims and every scope check in the
   * service — including the ones guarding escrow release — is decorative.
   */
  it('refuses a self-asserted principal, however privileged it claims to be', async () => {
    const ctx = forged(principal({ scopes: ['p2p:read', 'p2p:write', 'admin:treasury'], tier: 'full', mfa: true }));
    expect(ctx.principal).toBeNull();

    await expect(routerFor(stubP2p()).createCaller(ctx).offers.list({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('accepts a principal the edge signed', async () => {
    // Without this the UNAUTHORIZED assertions above would also pass on a
    // router that refuses everyone.
    await expect(routerFor(stubP2p()).createCaller(signed()).offers.list({ limit: 50 })).resolves.toEqual([]);
  });

  it('parses offers.list with the customer offer schema', async () => {
    const offerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const p2p = stubP2p({
      listOfferBoard: async () => ({
        offers: [
          {
            id: offerId,
            makerId: USER,
            side: 'sell' as const,
            asset: 'USDT',
            fiatCurrency: 'USD',
            priceType: 'fixed' as const,
            price: parseAmount('1'),
            minAmt: parseAmount('10'),
            maxAmt: parseAmount('100'),
            totalAmt: parseAmount('500'),
            remainingAmt: parseAmount('500'),
            methods: ['sepa'],
            terms: 'pay within 15 minutes',
            acceptsNonInstant: false,
            status: 'active' as const,
            createdAt: new Date('2026-10-17T00:00:00.000Z'),
          },
        ],
        nextCursor: 'cursor-must-not-be-the-reply',
      }),
      releasedTradeCounts: async () => new Map<string, number>([[offerId, 2]]),
    });
    const reply = await routerFor(p2p).createCaller(signed()).offers.list({ limit: 50 });
    expect(z.array(customerOfferSchema).parse(reply)).toEqual([
      {
        id: offerId,
        makerId: USER,
        side: 'sell',
        asset: 'USDT',
        fiatCurrency: 'USD',
        priceType: 'fixed',
        price: '1',
        minAmount: '10',
        maxAmount: '100',
        remainingAmount: '500',
        methods: ['sepa'],
        nonInstantMethods: [],
        acceptsNonInstant: false,
        terms: 'pay within 15 minutes',
        status: 'active',
        createdAt: '2026-10-17T00:00:00.000Z',
      },
    ]);
  });

  it('offers.list omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const p2p = stubP2p({
      listOfferBoard: async (filter: { limit?: number } = {}) => {
        assertOfferListLimit(filter.limit);
        return { offers: [], nextCursor: null };
      },
    });
    const caller = routerFor(p2p).createCaller(signed());
    await expect(caller.offers.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.offer_list_limit_unset',
    });
    await expect(caller.offers.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.offer_list_limit_unset',
    });
    await expect(caller.offers.list({ limit: 50 })).resolves.toEqual([]);
    await expect(caller.offers.page({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.offer_list_limit_unset',
    });
    await expect(caller.offers.page({ limit: 50 })).resolves.toEqual({ offers: [], nextCursor: null });
  });

  it('trades.list omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const p2p = stubP2p({
      listTrades: async (_userId: string, limit?: number) => {
        assertTradeListLimit(limit);
        return [];
      },
    });
    const caller = routerFor(p2p).createCaller(signed());
    await expect(caller.trades.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.trade_list_limit_unset',
    });
    await expect(caller.trades.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.trade_list_limit_unset',
    });
    await expect(caller.trades.list({ limit: 50 })).resolves.toEqual([]);
  });

  it('instruments.methods.list omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const instruments = stubInstruments({
      listMethodSchemas: async (filter: { limit?: number } = {}) => {
        assertMethodSchemaListLimit(filter.limit);
        return [];
      },
    });
    const caller = routerFor(stubP2p(), instruments).createCaller(signed());
    await expect(caller.instruments.methods.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.method_schema_list_limit_unset',
    });
    await expect(caller.instruments.methods.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.method_schema_list_limit_unset',
    });
    await expect(caller.instruments.methods.list({ limit: 50 })).resolves.toEqual([]);
  });

  it('instruments.list omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const instruments = stubInstruments({
      listInstruments: async (_ownerId: string, _includeRemoved?: boolean, limit?: number) => {
        assertInstrumentListLimit(limit);
        return [];
      },
    });
    const caller = routerFor(stubP2p(), instruments).createCaller(signed());
    await expect(caller.instruments.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.instrument_list_limit_unset',
    });
    await expect(caller.instruments.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.instrument_list_limit_unset',
    });
    await expect(caller.instruments.list({ limit: 50 })).resolves.toEqual([]);
  });

  it('instruments.accessLog omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const instruments = stubInstruments({
      accessLogFor: async (_ownerId: string, limit?: number) => {
        assertAccessLogLimit(limit);
        return [];
      },
    });
    const caller = routerFor(stubP2p(), instruments).createCaller(signed());
    await expect(caller.instruments.accessLog({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.access_log_limit_unset',
    });
    await expect(caller.instruments.accessLog()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.access_log_limit_unset',
    });
    await expect(caller.instruments.accessLog({ limit: 100 })).resolves.toEqual([]);
  });

  /**
   * The payment-instrument surface, at the mount.
   *
   * `instrument-service.test.ts` proves that a non-counterparty is refused.
   * This proves the layer in front of it: a caller with no credentials at all
   * never reaches the code that would make that decision. The stub throws on
   * every method, so "the service was never asked" is asserted by the absence
   * of that error rather than by a flag.
   */
  it('refuses an anonymous caller on every payment-instrument path', async () => {
    const caller = routerFor(stubP2p()).createCaller(anonymous());

    await expect(caller.instruments.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.instruments.methods.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.instruments.accessLog({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.instruments.reveal({ instrumentId: USER })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.trades.paymentInstrument({ tradeId: USER })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /**
   * A session may not register what a market's payment rails require.
   *
   * `admin:compliance` guards the registry because a wrong field list produces
   * instruments that look complete and cannot be paid — the same class of
   * content as a sanctions list, and equally not a user's to write.
   */
  it('refuses a normal session on the operator method registry', async () => {
    const caller = routerFor(stubP2p()).createCaller(signed(principal({ scopes: ['p2p:read', 'p2p:write'] })));

    await expect(
      caller.instruments.methods.register({ methodId: 'anything', country: 'DE', label: 'x', fields: [{}] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('svc-p2p mount — instruments.methods schema dual-control', () => {
  const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };
  const FIELDS = [{ key: 'iban', label: 'IBAN', required: true }] as const;

  function schemaStub() {
    const calls: unknown[] = [];
    return {
      calls,
      instruments: stubInstruments({
        registerMethodSchema: async (input: unknown) => {
          calls.push(['register', input]);
          return {
            methodId: 'bank_transfer',
            country: 'DE',
            label: 'SEPA',
            fields: [...FIELDS],
            enabled: true,
            settlement: { instant: true },
            kind: 'transfer' as const,
            noteRules: null,
            cashRules: null,
          };
        },
        setMethodSchemaEnabled: async (methodId: string, country: string, enabled: boolean, reason?: string) => {
          calls.push(['setEnabled', { methodId, country, enabled, ...(reason ? { reason } : {}) }]);
          return {
            methodId,
            country,
            label: 'SEPA',
            fields: [...FIELDS],
            enabled,
            settlement: { instant: true },
            kind: 'transfer' as const,
            noteRules: null,
            cashRules: null,
          };
        },
      }),
    };
  }

  const registerInput = {
    methodId: 'bank_transfer',
    country: 'DE',
    label: 'SEPA',
    fields: [{ key: 'iban', label: 'IBAN' }],
  };

  it('refuses register without MFA even with admin:compliance — no invented second factor', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments).createCaller(signed(principal({ scopes: ['admin:compliance'], mfa: false })));
    await expect(caller.instruments.methods.register({ ...registerInput, confirmOperatorId: CONFIRM, ...APPROVED })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses setEnabled without MFA even with admin:compliance — no invented second factor', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments).createCaller(signed(principal({ scopes: ['admin:compliance'], mfa: false })));
    await expect(
      caller.instruments.methods.setEnabled({
        methodId: 'bank_transfer',
        country: 'DE',
        enabled: false,
        reason: 'regulation',
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids on register and does not write', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(caller.instruments.methods.register(registerInput)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.instruments.methods.register({ ...registerInput, confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(caller.instruments.methods.register({ ...registerInput, confirmOperatorId: '   ' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids on setEnabled and does not write', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(
      caller.instruments.methods.setEnabled({ methodId: 'bank_transfer', country: 'DE', enabled: false, reason: 'regulation' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      caller.instruments.methods.setEnabled({
        methodId: 'bank_transfer',
        country: 'DE',
        enabled: false,
        reason: 'regulation',
        confirmOperatorId: USER,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      caller.instruments.methods.setEnabled({
        methodId: 'bank_transfer',
        country: 'DE',
        enabled: false,
        reason: 'regulation',
        confirmOperatorId: '   ',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls).toEqual([]);
  });

  it('registers with MFA and a consumed approval', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(caller.instruments.methods.register({ ...registerInput, confirmOperatorId: CONFIRM, ...APPROVED })).resolves.toMatchObject(
      {
        methodId: 'bank_transfer',
        country: 'DE',
        confirmOperatorId: CONFIRM,
      },
    );
    expect(calls).toEqual([
      [
        'register',
        {
          methodId: 'bank_transfer',
          country: 'DE',
          label: 'SEPA',
          fields: [{ key: 'iban', label: 'IBAN' }],
        },
      ],
    ]);
  });

  it('setEnabled with MFA and a consumed approval', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: stubApprovalConsumer(CONFIRM) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(
      caller.instruments.methods.setEnabled({
        methodId: 'bank_transfer',
        country: 'DE',
        enabled: false,
        reason: 'regulation',
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      }),
    ).resolves.toMatchObject({
      methodId: 'bank_transfer',
      enabled: false,
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([['setEnabled', { methodId: 'bank_transfer', country: 'DE', enabled: false, reason: 'regulation' }]]);
  });

  it('refuses retiring a method without a reason, before any approval is used, and does not write', async () => {
    const { calls, instruments } = schemaStub();
    const consumed: unknown[] = [];
    const approvals = { consume: async (input: unknown) => (consumed.push(input), { approverId: CONFIRM, requesterId: REQUESTER }) };
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: approvals as never }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(
      caller.instruments.methods.setEnabled({ methodId: 'bank_transfer', country: 'DE', enabled: false, ...APPROVED }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'p2p.delist_reason_required' } });
    expect(consumed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refuses register when the consumed approver is missing and does not write', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: consumedApproval(null) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(caller.instruments.methods.register({ ...registerInput, ...APPROVED })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses register when the consumed approver is the requester and does not write', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: consumedApproval(REQUESTER) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(caller.instruments.methods.register({ ...registerInput, ...APPROVED })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses setEnabled when the consumed approver is missing and does not write', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: consumedApproval(null) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(
      caller.instruments.methods.setEnabled({
        methodId: 'bank_transfer',
        country: 'DE',
        enabled: false,
        reason: 'regulation',
        ...APPROVED,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls).toEqual([]);
  });

  it('refuses setEnabled when the consumed approver is the requester and does not write', async () => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals: consumedApproval(REQUESTER) }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    await expect(
      caller.instruments.methods.setEnabled({
        methodId: 'bank_transfer',
        country: 'DE',
        enabled: false,
        reason: 'regulation',
        ...APPROVED,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls).toEqual([]);
  });

  /**
   * Identity stores one payload hash. Consume accepts that hash and refuses
   * any other, the same rule as action_approval.payload_mismatch.
   */
  function hashBoundApproval(payloadHash: string): ActionApprovalConsumer {
    return {
      async consume(input) {
        if (input.payloadHash !== payloadHash) {
          throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
        }
        return {
          ...input,
          actionType: input.targetId,
          requesterId: REQUESTER,
          approverId: CONFIRM,
          policyVersion: 'v1',
          createdAt: '2026-09-09T12:00:00.000Z',
          expiresAt: '2026-09-09T12:10:00.000Z',
          status: 'CONSUMED',
        };
      },
    };
  }

  function registerSchemaHash(fields: unknown, enabled: boolean | undefined): string {
    return p2pActionPayloadHash('p2p.method_register', {
      methodId: registerInput.methodId,
      country: registerInput.country,
      label: registerInput.label,
      fields: JSON.stringify(parseFieldSpecs(fields)),
      enabled: enabled === undefined ? 'preserve-or-default' : enabled ? 'true' : 'false',
    });
  }

  const compliance = (approvals: ActionApprovalConsumer) => {
    const { calls, instruments } = schemaStub();
    const caller = createP2pRouter(stubP2p(), instruments, undefined, { approvals }).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: true })),
    );
    return { calls, caller };
  };

  it('refuses register when the approval bound only methodId, country, and label, and does not write', async () => {
    const unbound = p2pActionPayloadHash('p2p.method_register', {
      methodId: registerInput.methodId,
      country: registerInput.country,
      label: registerInput.label,
    });
    const { calls, caller } = compliance(hashBoundApproval(unbound));
    await expect(caller.instruments.methods.register({ ...registerInput, ...APPROVED })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(caller.instruments.methods.register({ ...registerInput, enabled: false, ...APPROVED })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a different field list than the approved schema and does not write', async () => {
    const approved = registerSchemaHash([{ key: 'iban', label: 'IBAN' }], true);
    const { calls, caller } = compliance(hashBoundApproval(approved));
    await expect(
      caller.instruments.methods.register({
        ...registerInput,
        fields: [{ key: 'swift', label: 'SWIFT' }],
        enabled: true,
        ...APPROVED,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls).toEqual([]);
  });

  it('refuses a different enabled flag than the approved schema and does not write', async () => {
    const approved = registerSchemaHash(registerInput.fields, false);
    const { calls, caller } = compliance(hashBoundApproval(approved));
    await expect(caller.instruments.methods.register({ ...registerInput, enabled: true, ...APPROVED })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(caller.instruments.methods.register({ ...registerInput, ...APPROVED })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(calls).toEqual([]);
  });

  it('registers when enabled is omitted and the approval bound preserve-or-default', async () => {
    const fields = registerInput.fields;
    const { calls, caller } = compliance(hashBoundApproval(registerSchemaHash(fields, undefined)));
    await expect(caller.instruments.methods.register({ ...registerInput, fields, ...APPROVED })).resolves.toMatchObject({
      methodId: 'bank_transfer',
      country: 'DE',
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([
      [
        'register',
        {
          methodId: 'bank_transfer',
          country: 'DE',
          label: 'SEPA',
          fields,
        },
      ],
    ]);
  });

  it('registers when the approval hash matches the fields and enabled that are written', async () => {
    const fields = [{ key: 'iban', label: 'IBAN' }];
    const { calls, caller } = compliance(hashBoundApproval(registerSchemaHash(fields, false)));
    await expect(caller.instruments.methods.register({ ...registerInput, fields, enabled: false, ...APPROVED })).resolves.toMatchObject({
      methodId: 'bank_transfer',
      country: 'DE',
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([
      [
        'register',
        {
          methodId: 'bank_transfer',
          country: 'DE',
          label: 'SEPA',
          fields,
          enabled: false,
        },
      ],
    ]);
  });

  it('binds the cash and payment-note rules to the approval: the approved rules register, other rules refuse', async () => {
    // P-ads-merchant-19: rules make a method cash in person (a locked price, its own release window), so a second
    // person approves them with the fields; a register that sends none hashes as before.
    const fields = [{ key: 'iban', label: 'IBAN' }];
    const noteRules = { guidance: 'Write only the order number.', forbidden: ['USDT'] };
    const cashRules = { meetingGuidance: 'Meet in public.', proof: 'Count together.', releaseWindowSeconds: 600 };
    const hash = p2pActionPayloadHash('p2p.method_register', {
      methodId: registerInput.methodId,
      country: registerInput.country,
      label: registerInput.label,
      fields: JSON.stringify(parseFieldSpecs(fields)),
      enabled: 'preserve-or-default',
      noteRules: JSON.stringify(noteRules),
      cashRules: JSON.stringify(cashRules),
    });
    const approved = compliance(hashBoundApproval(hash));
    await expect(
      approved.caller.instruments.methods.register({ ...registerInput, fields, noteRules, cashRules, ...APPROVED }),
    ).resolves.toMatchObject({ methodId: 'bank_transfer', confirmOperatorId: CONFIRM });
    expect(approved.calls).toEqual([['register', expect.objectContaining({ noteRules, cashRules })]]);

    const swapped = compliance(hashBoundApproval(hash));
    await expect(
      swapped.caller.instruments.methods.register({
        ...registerInput,
        fields,
        noteRules,
        cashRules: { ...cashRules, releaseWindowSeconds: 86_400 },
        ...APPROVED,
      }),
    ).rejects.toThrow();
    const dropped = compliance(hashBoundApproval(hash));
    await expect(dropped.caller.instruments.methods.register({ ...registerInput, fields, noteRules, ...APPROVED })).rejects.toThrow();
    expect([...swapped.calls, ...dropped.calls]).toEqual([]);
  });

  /**
   * `registerMethodSchema` stores `parseFieldSpecs`, not the request array.
   * Key case, label whitespace, and a non-boolean `required` all change on
   * the way in. An approval of the raw list did not bind the row that lands.
   */
  const rawIbanFields = [{ key: 'IBAN', label: ' IBAN ', required: 'no' }];
  const storedIbanFields = [{ key: 'iban', label: 'IBAN', required: true }];

  function registerParsingStoredSpecs() {
    const stored: Array<{
      methodId: string;
      country: string;
      label: string;
      fields: ReturnType<typeof parseFieldSpecs>;
      enabled: boolean;
    }> = [];
    const instruments = stubInstruments({
      registerMethodSchema: async (input: { methodId: string; country: string; label: string; fields: unknown; enabled?: boolean }) => {
        const fields = parseFieldSpecs(input.fields);
        const enabled = input.enabled ?? true;
        stored.push({ methodId: input.methodId, country: input.country, label: input.label, fields, enabled });
        return {
          methodId: input.methodId,
          country: input.country,
          label: input.label,
          fields,
          enabled,
          settlement: { instant: true },
          kind: 'transfer' as const,
          noteRules: null,
          cashRules: null,
        };
      },
    });
    const callerFor = (payloadHash: string) =>
      createP2pRouter(stubP2p(), instruments, undefined, { approvals: hashBoundApproval(payloadHash) }).createCaller(
        signed(principal({ scopes: ['admin:compliance'], mfa: true })),
      );
    return { stored, callerFor };
  }

  function registerPayloadHash(fields: unknown, enabled: boolean | undefined): string {
    return p2pActionPayloadHash('p2p.method_register', {
      methodId: registerInput.methodId,
      country: registerInput.country,
      label: registerInput.label,
      fields: JSON.stringify(fields),
      enabled: enabled === undefined ? 'preserve-or-default' : enabled ? 'true' : 'false',
    });
  }

  it('refuses an approval of the un-normalized IBAN field list and does not store the normalized schema', async () => {
    const { stored, callerFor } = registerParsingStoredSpecs();
    const caller = callerFor(registerPayloadHash(rawIbanFields, undefined));
    await expect(caller.instruments.methods.register({ ...registerInput, fields: rawIbanFields, ...APPROVED })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(stored).toEqual([]);
  });

  it('registers when the approval bound the stored IBAN field specs and the enabled flag that is written', async () => {
    const { stored, callerFor } = registerParsingStoredSpecs();
    const caller = callerFor(registerPayloadHash(storedIbanFields, undefined));
    await expect(caller.instruments.methods.register({ ...registerInput, fields: rawIbanFields, ...APPROVED })).resolves.toMatchObject({
      methodId: 'bank_transfer',
      country: 'DE',
      label: 'SEPA',
      fields: storedIbanFields,
      enabled: true,
      confirmOperatorId: CONFIRM,
    });
    expect(stored).toEqual([
      {
        methodId: 'bank_transfer',
        country: 'DE',
        label: 'SEPA',
        fields: storedIbanFields,
        enabled: true,
      },
    ]);
  });
});

describe('svc-p2p mount — merchant API access', () => {
  it('refuses P2P API-key traffic until the key owner is an approved merchant', async () => {
    let reads = 0;
    const p2p = stubP2p({
      listOffers: async () => {
        reads++;
        return [];
      },
    });
    const ctx = signed(principal({ kid: 'merchant-key-1', scopes: ['p2p:read'] }));

    await expect(
      createP2pRouter(p2p, stubInstruments(), undefined, {}, merchantStub('applied') as never)
        .createCaller(ctx)
        .offers.list({ limit: 50 }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/approved merchant/i),
    });
    expect(reads).toBe(0);
  });

  it('allows an approved merchant to use an identity-issued P2P API key', async () => {
    const ctx = signed(principal({ kid: 'merchant-key-1', scopes: ['p2p:read'] }));
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, {}, merchantStub('approved') as never).createCaller(ctx);

    await expect(caller.offers.list({ limit: 50 })).resolves.toEqual([]);
  });

  it('removes API access immediately when merchant standing is suspended', async () => {
    let status: MerchantStatus = 'approved';
    const merchants = {
      get: async (userId: string) => ({
        userId,
        status,
        appliedCompletionRate: 1,
        appliedTradesTotal: 100,
        appliedAt: new Date('2026-01-01T00:00:00.000Z'),
        decidedAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    };
    const ctx = signed(principal({ kid: 'merchant-key-1', scopes: ['p2p:read'] }));
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, {}, merchants as never).createCaller(ctx);

    await expect(caller.offers.list({ limit: 50 })).resolves.toEqual([]);
    status = 'suspended';
    await expect(caller.offers.list({ limit: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not turn ordinary interactive P2P access into merchant-only access', async () => {
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, {}, merchantStub(null) as never).createCaller(ctx);

    await expect(caller.offers.list({ limit: 50 })).resolves.toEqual([]);
  });

  it('reports API eligibility from the same current standing that enforces it', async () => {
    const keyCtx = signed(principal({ kid: 'merchant-key-1', scopes: ['p2p:read'] }));
    const sessionCtx = signed(principal({ scopes: ['p2p:read'] }));
    const router = createP2pRouter(stubP2p(), stubInstruments(), undefined, {}, merchantStub('approved') as never);

    await expect(router.createCaller(keyCtx).merchants.apiAccess()).resolves.toEqual({
      eligible: true,
      credential: 'api_key',
      merchantStatus: 'approved',
      keyPlane: 'identity',
      rateLimitPlane: 'edge',
      disputeResolution: 'interactive_human_only',
    });
    await expect(router.createCaller(sessionCtx).merchants.apiAccess()).resolves.toMatchObject({
      eligible: true,
      credential: 'session',
      merchantStatus: 'approved',
    });
  });
});

/**
 * THE MODERATOR SURFACE.
 *
 * Two separate promises, both asserted here because they fail in opposite
 * directions: the queue must not be readable by a user session (it contains
 * other people's disputes), and the evidence a PARTY gets back must be their
 * own (it is filed by, and about, the person they are in dispute with).
 */
describe('svc-p2p mount — the moderator queue', () => {
  const SELLER = USER;
  const BUYER = '33333333-3333-4333-8333-333333333333';

  const dispute = {
    id: '44444444-4444-4444-8444-444444444444',
    tradeId: '55555555-5555-4555-8555-555555555555',
    openedBy: BUYER,
    openedVia: 'party' as const,
    reason: 'nothing arrived',
    chatThreadId: '77777777-7777-4777-8777-777777777777',
    evidence: [
      { seq: 1, submittedBy: BUYER, submittedAt: new Date('2026-08-04T00:00:00.000Z'), item: { ref: 'BUYER-RECEIPT' } },
      { seq: 2, submittedBy: SELLER, submittedAt: new Date('2026-08-04T01:00:00.000Z'), item: { ref: 'SELLER-STATEMENT' } },
    ],
    moderatorId: null,
    resolution: null,
    resolutionNotes: null,
    status: 'open' as const,
    deadlineAt: new Date('2026-08-01T00:00:00.000Z'),
    openedAt: new Date('2026-07-25T00:00:00.000Z'),
    resolvedAt: null,
    lastSeenByModeratorAt: null,
    moderatorViews: 0,
    escalatedAt: null,
    escalations: 0,
  };

  const trade = { id: dispute.tradeId, sellerId: SELLER, buyerId: BUYER };

  function disputesStub(seen: { asModerator: number } = { asModerator: 0 }) {
    return stubP2p({
      listDisputes: async (input: { limit?: number }) => {
        assertDisputeListLimit(input.limit);
        seen.asModerator++;
        return { disputes: [dispute], nextCursor: null };
      },
      getTrade: async () => trade,
      getDispute: async () => dispute,
      getDisputeAsModerator: async () => {
        seen.asModerator++;
        return dispute;
      },
    });
  }

  it('honest-refuses the queue when no moderator auth is configured', async () => {
    // Empty allowlist + no admin:compliance = moderation unreachable. FORBIDDEN
    // would lie that the caller is missing a scope; the deployment is what is
    // missing a human (D-S-08).
    const seen = { asModerator: 0 };
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));

    await expect(createP2pRouter(disputesStub(seen), stubInstruments()).createCaller(ctx).disputes.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/moderation is not configured/i),
    });
    expect(seen.asModerator).toBe(0);
  });

  it('serves an allowlisted moderator with ordinary p2p:read', async () => {
    const seen = { asModerator: 0 };
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const page = await createP2pRouter(disputesStub(seen), stubInstruments(), undefined, {
      moderatorUserIds: [USER],
    })
      .createCaller(ctx)
      .disputes.list({ limit: 50 });

    expect(page.disputes).toHaveLength(1);
    expect(page.disputes[0]!.evidence.map((e) => e.submittedBy)).toEqual([BUYER, SELLER]);
    expect(page.disputes[0]!.overdue).toBe(true);
    expect(seen.asModerator).toBe(1);
  });

  it('forbids a configured queue to a session that is not on the allowlist', async () => {
    const seen = { asModerator: 0 };
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    await expect(
      createP2pRouter(disputesStub(seen), stubInstruments(), undefined, {
        moderatorUserIds: [BUYER],
      })
        .createCaller(ctx)
        .disputes.list({}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(seen.asModerator).toBe(0);
  });

  it('serves a moderator the queue, with the evidence in it', async () => {
    const ctx = signed(principal({ scopes: ['p2p:read', 'admin:compliance'] }));
    const page = await createP2pRouter(disputesStub(), stubInstruments()).createCaller(ctx).disputes.list({ limit: 50 });

    expect(page.disputes).toHaveLength(1);
    // Evidence rides the QUEUE, not only `.get`. A triage list that cannot show
    // what is alleged costs a round trip per row, which is how a queue stops
    // being used at all.
    expect(page.disputes[0]!.evidence.map((e) => e.submittedBy)).toEqual([BUYER, SELLER]);
    expect(page.disputes[0]!.overdue).toBe(true);
  });

  it('disputes.list omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const caller = createP2pRouter(disputesStub(), stubInstruments()).createCaller(
      signed(principal({ scopes: ['p2p:read', 'admin:compliance'] })),
    );
    await expect(caller.disputes.list({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.dispute_list_limit_unset',
    });
    await expect(caller.disputes.list()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.dispute_list_limit_unset',
    });
    await expect(caller.disputes.list({ limit: 50 })).resolves.toMatchObject({ nextCursor: null });
  });

  it('gives a PARTY only the evidence they filed themselves', async () => {
    // Their counterparty's submissions are free-form text about them, filed by
    // someone they are in dispute with, with no redaction and no erase path.
    // Handing that back is a product decision with a legal shadow; it is not
    // made here by accident.
    const ctx = signed(principal({ scopes: ['p2p:read'] })); // SELLER
    const got = await createP2pRouter(disputesStub(), stubInstruments()).createCaller(ctx).disputes.get({ tradeId: dispute.tradeId });

    expect(got.evidence).toHaveLength(1);
    expect(got.evidence[0]!.submittedBy).toBe(SELLER);
  });

  it('gives a MODERATOR the whole evidence set, and records that they were served it', async () => {
    const seen = { asModerator: 0 };
    const ctx = signed(principal({ scopes: ['p2p:read', 'admin:compliance'] }));
    const got = await createP2pRouter(disputesStub(seen), stubInstruments()).createCaller(ctx).disputes.get({ tradeId: dispute.tradeId });

    expect(got.evidence).toHaveLength(2);
    // The stamped read, not the plain one: "a human reached this dispute" is
    // only a fact if reaching it writes something down.
    expect(seen.asModerator).toBe(1);
  });

  it('tells a party what happens if nobody rules, at the moment they open the dispute', async () => {
    const p2p = stubP2p({
      openDispute: async () => dispute,
    });
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));
    const opened = await createP2pRouter(p2p, stubInstruments()).createCaller(ctx).disputes.open({ tradeId: dispute.tradeId, reason: 'x' });

    expect(opened.ifNobodyRules).toBe('escalated_and_held');
    expect(opened.moderationConfigured).toBe(false);
    expect(opened.moderation).toEqual({ status: 'absent', code: 'p2p.moderation_unreachable' });
    expect(opened).not.toHaveProperty('moderationReachable');
    expect(opened.chatThreadId).toBe(dispute.chatThreadId);
  });

  it('discloses when moderation IS configured at open time — configured is not reachable', async () => {
    const p2p = stubP2p({
      openDispute: async () => dispute,
    });
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));
    const opened = await createP2pRouter(p2p, stubInstruments(), undefined, { moderatorUserIds: [BUYER] })
      .createCaller(ctx)
      .disputes.open({ tradeId: dispute.tradeId, reason: 'x' });

    expect(opened.moderationConfigured).toBe(true);
    expect(opened.moderation).toEqual({ status: 'configured', code: 'p2p.moderation_unprobed' });
    expect(opened).not.toHaveProperty('moderationReachable');
  });

  it('never lets a normal session resolve a dispute when moderation is unconfigured', async () => {
    // Money path: resolve moves escrow. Empty allowlist must refuse before the service runs.
    let resolved = 0;
    const p2p = stubP2p({
      resolveDispute: async () => {
        resolved++;
        throw new Error('resolve must not run');
      },
    });
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));
    await expect(
      createP2pRouter(p2p, stubInstruments()).createCaller(ctx).disputes.resolve({
        tradeId: dispute.tradeId,
        resolution: 'release',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(resolved).toBe(0);
  });

  it('never lets a non-moderator resolve when the queue is staffed', async () => {
    let resolved = 0;
    const p2p = stubP2p({
      resolveDispute: async () => {
        resolved++;
        throw new Error('resolve must not run');
      },
    });
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));
    await expect(
      createP2pRouter(p2p, stubInstruments(), undefined, { moderatorUserIds: [BUYER] })
        .createCaller(ctx)
        .disputes.resolve({ tradeId: dispute.tradeId, resolution: 'refund' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(resolved).toBe(0);
  });

  it('pulls merchant standing for the party who lost a moderated dispute (release → seller)', async () => {
    const MOD = BUYER;
    const suspended: Array<{ userId: string; tradeId: string; disputeId: string; actorId: string }> = [];
    const resolvedTrade = {
      id: dispute.tradeId,
      offerId: dispute.tradeId,
      takerId: BUYER,
      makerId: SELLER,
      sellerId: SELLER,
      buyerId: BUYER,
      asset: 'USDT',
      amount: 100n,
      fiatCurrency: 'EUR',
      fiatAmount: 100n,
      price: 1n,
      method: 'sepa',
      feeBps: 0,
      status: 'released' as const,
      resolution: 'released' as const,
      resolutionReason: 'moderator:release',
      chatThreadId: '77777777-7777-4777-8777-777777777777',
      deadlines: {},
      deadlineAt: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      escrowedAt: new Date('2026-07-20T00:00:00.000Z'),
      fiatSentAt: null,
      resolvedAt: new Date('2026-08-04T02:00:00.000Z'),
      settledAt: new Date('2026-08-04T02:00:00.000Z'),
    };
    const p2p = stubP2p({
      resolveDispute: async () => resolvedTrade,
      getDispute: async () => ({ ...dispute, status: 'resolved' as const, resolution: 'release' as const }),
    });
    const merchants = {
      ...merchantStub('approved'),
      suspendIfStandingBrokenByDisputeLaw: async (input: {
        userId: string;
        tradeId: string;
        disputeId: string;
        actorId: string;
        actorScope: string;
      }) => {
        suspended.push({
          userId: input.userId,
          tradeId: input.tradeId,
          disputeId: input.disputeId,
          actorId: input.actorId,
        });
        return null;
      },
    };
    const ctx = signed(principal({ userId: MOD, sub: MOD, scopes: ['p2p:read'] }));

    await createP2pRouter(p2p, stubInstruments(), undefined, { moderatorUserIds: [MOD] }, merchants as never)
      .createCaller(ctx)
      .disputes.resolve({ tradeId: dispute.tradeId, resolution: 'release' });

    expect(suspended).toEqual([{ userId: SELLER, tradeId: dispute.tradeId, disputeId: dispute.id, actorId: MOD }]);
  });

  it('attributes a refund loss to the buyer for merchant suspension', async () => {
    const MOD = '77777777-7777-4777-8777-777777777777';
    const suspended: string[] = [];
    const resolvedTrade = {
      id: dispute.tradeId,
      offerId: dispute.tradeId,
      takerId: BUYER,
      makerId: SELLER,
      sellerId: SELLER,
      buyerId: BUYER,
      asset: 'USDT',
      amount: 100n,
      fiatCurrency: 'EUR',
      fiatAmount: 100n,
      price: 1n,
      method: 'sepa',
      feeBps: 0,
      status: 'cancelled' as const,
      resolution: 'refunded' as const,
      resolutionReason: 'moderator:refund',
      chatThreadId: '77777777-7777-4777-8777-777777777777',
      deadlines: {},
      deadlineAt: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      escrowedAt: new Date('2026-07-20T00:00:00.000Z'),
      fiatSentAt: null,
      resolvedAt: new Date('2026-08-04T02:00:00.000Z'),
      settledAt: new Date('2026-08-04T02:00:00.000Z'),
    };
    const p2p = stubP2p({
      resolveDispute: async () => resolvedTrade,
      getDispute: async () => ({ ...dispute, status: 'resolved' as const, resolution: 'refund' as const }),
    });
    const merchants = {
      ...merchantStub('approved'),
      suspendIfStandingBrokenByDisputeLaw: async (input: { userId: string }) => {
        suspended.push(input.userId);
        return null;
      },
    };
    const ctx = signed(principal({ userId: MOD, sub: MOD, scopes: ['p2p:read'] }));

    await createP2pRouter(p2p, stubInstruments(), undefined, { moderatorUserIds: [MOD] }, merchants as never)
      .createCaller(ctx)
      .disputes.resolve({ tradeId: dispute.tradeId, resolution: 'refund' });

    expect(suspended).toEqual([BUYER]);
  });

  it('serves the backlog counts to an allowlisted moderator', async () => {
    let called = 0;
    const p2p = stubP2p({
      moderationBacklog: async () => {
        called++;
        return { open: 3, overdue: 1, escalated: 1, neverSeen: 2 };
      },
    });
    const ctx = signed(principal({ userId: USER, scopes: ['p2p:read'] }));
    const page = await createP2pRouter(p2p, stubInstruments(), undefined, {
      moderatorUserIds: [USER],
    })
      .createCaller(ctx)
      .disputes.backlog();
    expect(page).toEqual({
      open: 3,
      overdue: 1,
      escalated: 1,
      neverSeen: 2,
      moderationConfigured: true,
      moderation: { status: 'configured', code: 'p2p.moderation_unprobed' },
    });
    expect(called).toBe(1);
  });

  it('honest-refuses backlog when moderation is unconfigured', async () => {
    let called = 0;
    const p2p = stubP2p({
      moderationBacklog: async () => {
        called++;
        return { open: 0, overdue: 0, escalated: 0, neverSeen: 0 };
      },
    });
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    await expect(createP2pRouter(p2p, stubInstruments()).createCaller(ctx).disputes.backlog()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/moderation is not configured/i),
    });
    expect(called).toBe(0);
  });

  it('serialises openedVia and resolutionNotes on a dispute get', async () => {
    const ruled = {
      ...dispute,
      status: 'resolved' as const,
      moderatorId: USER,
      resolution: 'release' as const,
      resolutionNotes: 'receipt holds',
      resolvedAt: new Date('2026-08-05T00:00:00.000Z'),
      openedVia: 'timeout' as const,
    };
    const p2p = stubP2p({
      getTrade: async () => trade,
      getDisputeAsModerator: async () => ruled,
    });
    const ctx = signed(principal({ userId: USER, scopes: ['p2p:read'] }));
    const got = await createP2pRouter(p2p, stubInstruments(), undefined, {
      moderatorUserIds: [USER],
    })
      .createCaller(ctx)
      .disputes.get({ tradeId: dispute.tradeId });
    expect(got.openedVia).toBe('timeout');
    expect(got.resolutionNotes).toBe('receipt holds');
    expect(got.resolution).toBe('release');
  });
});

describe('svc-p2p mount — trade/dispute read IDOR', () => {
  const SELLER = USER;
  const BUYER = '33333333-3333-4333-8333-333333333333';
  const STRANGER = '66666666-6666-4666-8666-666666666666';
  const tradeId = '55555555-5555-4555-8555-555555555555';

  const foreignTrade = {
    id: tradeId,
    offerId: tradeId,
    sellerId: SELLER,
    buyerId: BUYER,
    asset: 'USDT',
    amount: 100n,
    fiatCurrency: 'EUR',
    fiatAmount: 100n,
    price: 1n,
    priceType: 'fixed' as const,
    method: 'sepa',
    feeBps: 100,
    status: 'escrowed' as const,
    resolution: null,
    resolutionReason: null,
    chatThreadId: null,
    deadlines: {},
    deadlineAt: new Date(),
    createdAt: new Date(),
    escrowedAt: new Date(),
    fiatSentAt: null,
    resolvedAt: null,
    settledAt: null,
    escalatedAt: null,
    escalations: 0,
    settlement: { instant: true } as const,
  };

  it("hides another pair's trade as the same NOT_FOUND as a missing trade", async () => {
    // FORBIDDEN, or a different sentence, would confirm the trade id exists.
    // ADR 2026-08-04: absent and not-yours are byte-identical.
    const ctx = signed(principal({ userId: STRANGER, sub: STRANGER, scopes: ['p2p:read'] }));
    const shape = async (p2p: P2pService) => {
      try {
        await createP2pRouter(p2p, stubInstruments()).createCaller(ctx).trades.get({ tradeId });
        return null;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return { code: err.code, message: err.message };
      }
    };
    const missing = await shape(
      stubP2p({
        getTrade: async () => {
          throw new P2pError(`Trade ${tradeId} not found`, 'p2p.trade_not_found');
        },
      }),
    );
    let reads = 0;
    const strangerHit = await shape(
      stubP2p({
        getTrade: async () => {
          reads++;
          return foreignTrade;
        },
      }),
    );
    expect(strangerHit).toEqual(missing);
    expect(missing).toEqual({ code: 'NOT_FOUND', message: `Trade ${tradeId} not found` });
    expect(reads).toBe(1);
  });

  it('gives a party the order with the terms copied when it was placed, and an older order null', async () => {
    const ctx = signed(principal({ userId: BUYER, sub: BUYER, scopes: ['p2p:read'] }));
    const read = (termsSnapshot: string | null) =>
      createP2pRouter(stubP2p({ getTrade: async () => ({ ...foreignTrade, termsSnapshot }) }), stubInstruments())
        .createCaller(ctx)
        .trades.get({ tradeId });
    expect((await read('pay within 15 minutes')).terms).toBe('pay within 15 minutes');
    expect((await read(null)).terms).toBeNull();
  });

  it('gives a party the readable status, the frozen fee rate, and the release split of a released order only', async () => {
    const ctx = signed(principal({ userId: BUYER, sub: BUYER, scopes: ['p2p:read'] }));
    const read = (patch: Record<string, unknown>) =>
      createP2pRouter(stubP2p({ getTrade: async () => ({ ...foreignTrade, termsSnapshot: null, ...patch }) as never }), stubInstruments())
        .createCaller(ctx)
        .trades.get({ tradeId });
    const fifty = parseAmount('50');
    // Open: nothing has been paid out, so there is no split to show.
    expect(await read({ amount: fifty })).toMatchObject({
      displayStatus: 'waiting_for_buyer_to_pay',
      feeBps: 100,
      fee: null,
      netAmount: null,
    });
    const done = await read({ amount: fifty, status: 'released', resolution: 'released', resolutionReason: 'confirmed' });
    expect(done).toMatchObject({ displayStatus: 'completed', fee: '0.5', netAmount: '49.5' });
    // A refund returns the whole escrow to the seller: no fee was taken.
    const refunded = await read({ amount: fifty, status: 'cancelled', resolution: 'refunded', resolutionReason: 'timeout.escrowed' });
    expect(refunded).toMatchObject({ displayStatus: 'cancelled_by_timeout', fee: null, netAmount: null });
    // The ledger ceils the fee, so the buyer's share is never rounded up.
    const odd = await read({ amount: parseAmount('0.000000000000000003'), feeBps: 1, status: 'released', resolution: 'released' });
    expect(odd).toMatchObject({ fee: '0.000000000000000001', netAmount: '0.000000000000000002' });
    // A split that leaves the buyer nothing is one the release refuses; the read names none rather than a zero payout.
    const nothing = await read({ amount: 1n, feeBps: 1, status: 'released', resolution: 'released' });
    expect(nothing).toMatchObject({ fee: null, netAmount: null });
    expect(await read({ amount: fifty, feeBps: 0, status: 'released', resolution: 'released' })).toMatchObject({
      fee: '0',
      netAmount: '50',
    });
  });

  it("hides another pair's dispute as NOT_FOUND rather than FORBIDDEN or 500", async () => {
    let reads = 0;
    const dispute = {
      id: '44444444-4444-4444-8444-444444444444',
      tradeId,
      openedBy: BUYER,
      openedVia: 'party' as const,
      reason: 'nothing arrived',
      chatThreadId: '77777777-7777-4777-8777-777777777777',
      evidence: [],
      moderatorId: null,
      resolution: null,
      resolutionNotes: null,
      status: 'open' as const,
      deadlineAt: new Date('2026-08-01T00:00:00.000Z'),
      openedAt: new Date('2026-07-25T00:00:00.000Z'),
      resolvedAt: null,
      lastSeenByModeratorAt: null,
      moderatorViews: 0,
      escalatedAt: null,
      escalations: 0,
    };
    const p2p = stubP2p({
      getTrade: async () => {
        reads++;
        return foreignTrade;
      },
      getDispute: async () => dispute,
    });
    const ctx = signed(principal({ userId: STRANGER, sub: STRANGER, scopes: ['p2p:read'] }));
    const present = await createP2pRouter(p2p, stubInstruments())
      .createCaller(ctx)
      .disputes.get({ tradeId })
      .then(
        () => null,
        (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }),
      );
    const absent = await createP2pRouter(
      stubP2p({
        getTrade: async () => {
          throw new P2pError(`Trade ${tradeId} not found`, 'p2p.trade_not_found');
        },
      }),
      stubInstruments(),
    )
      .createCaller(ctx)
      .disputes.get({ tradeId })
      .then(
        () => null,
        (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }),
      );
    expect(present).toEqual(absent);
    expect(absent).toEqual({ code: 'NOT_FOUND', message: `Trade ${tradeId} not found` });
    expect(reads).toBe(1);
  });
});

describe('svc-p2p mount — the public surface', () => {
  it('serves health to an anonymous caller', async () => {
    await expect(routerFor(stubP2p()).createCaller(anonymous()).health()).resolves.toEqual({
      ok: true,
      service: 'svc-p2p',
      moderationConfigured: false,
      moderation: { status: 'absent', code: 'p2p.moderation_unreachable' },
      offerLimitsConfigured: false,
      offerLimitsPosture: 'unset',
      instrumentKmsConfigured: false,
      instrumentKeyProvider: 'none',
    });
  });

  it('names a local-test key provider without calling it a configured KMS', async () => {
    await expect(
      createP2pRouter(stubP2p(), stubInstruments(), undefined, { instrumentKeyProvider: 'local-test' }).createCaller(anonymous()).health(),
    ).resolves.toMatchObject({ instrumentKmsConfigured: false, instrumentKeyProvider: 'local-test' });
  });

  it('discloses moderationConfigured on health when an allowlist is set — never reachable', async () => {
    // Clients must not imply a watcher when none is staffed. Named ids are
    // config, not a live probe — health must not sell them as reachable.
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, {
      moderatorUserIds: [USER],
    }).createCaller(anonymous());
    await expect(caller.health()).resolves.toEqual({
      ok: true,
      service: 'svc-p2p',
      moderationConfigured: true,
      moderation: { status: 'configured', code: 'p2p.moderation_unprobed' },
      offerLimitsConfigured: false,
      offerLimitsPosture: 'unset',
      instrumentKmsConfigured: false,
      instrumentKeyProvider: 'none',
    });
  });

  it('discloses offerLimitsConfigured on health when ceilings are armed', async () => {
    // Same honesty pattern as moderationConfigured: a badge must not imply a
    // higher limit while env ceilings are unset. Health is public so probes
    // never need a scoped read to learn the posture.
    const { parseAmount } = await import('@intafaced/ledger-client');
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, {
      offerLimits: {
        standardMaxAmount: parseAmount('1000'),
        merchantMaxAmount: parseAmount('5000'),
      },
    }).createCaller(anonymous());
    await expect(caller.health()).resolves.toEqual({
      ok: true,
      service: 'svc-p2p',
      moderationConfigured: false,
      moderation: { status: 'absent', code: 'p2p.moderation_unreachable' },
      offerLimitsConfigured: true,
      offerLimitsPosture: 'configured',
      instrumentKmsConfigured: false,
      instrumentKeyProvider: 'none',
    });
  });

  it('serves health even when a forged principal was presented', async () => {
    // A rejected principal makes the caller anonymous, not rejected outright.
    await expect(routerFor(stubP2p()).createCaller(forged()).health()).resolves.toMatchObject({ ok: true });
  });
});

describe('svc-p2p mount — late settlements ops', () => {
  it('refuses the late-settlements list without admin:compliance', async () => {
    // Operator surface for committed-but-unsettled decisions. Not either party's
    // p2p:write — that would let a party inventory the whole house's backlog.
    let listed = 0;
    const p2p = stubP2p({
      listLateSettlements: async () => {
        listed++;
        return [];
      },
    });
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));
    await expect(createP2pRouter(p2p, stubInstruments()).createCaller(ctx).ops.lateSettlements({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(listed).toBe(0);
  });

  it('refuses a forged principal even when it claims admin:compliance', async () => {
    let listed = 0;
    const p2p = stubP2p({
      listLateSettlements: async () => {
        listed++;
        return [];
      },
    });
    const ctx = forged(principal({ scopes: ['admin:compliance', 'p2p:write'], tier: 'full', mfa: true }));
    await expect(createP2pRouter(p2p, stubInstruments()).createCaller(ctx).ops.lateSettlements({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(listed).toBe(0);
  });

  it('ops.lateSettlements omit is PRECONDITION_FAILED — never invents a 100-row page', async () => {
    const p2p = stubP2p({
      listLateSettlements: async (limit?: number) => {
        assertLateSettlementsListLimit(limit);
        return [];
      },
    });
    const caller = createP2pRouter(p2p, stubInstruments()).createCaller(signed(principal({ scopes: ['p2p:read', 'admin:compliance'] })));
    await expect(caller.ops.lateSettlements({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.late_settlements_list_limit_unset',
    });
    await expect(caller.ops.lateSettlements()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.late_settlements_list_limit_unset',
    });
    await expect(caller.ops.lateSettlements({ limit: 100 })).resolves.toEqual({ trades: [] });
  });
});

describe('svc-p2p mount — offer methods shape', () => {
  it('refuses an offer whose methods are not matchable ids', async () => {
    // methodAllowed only matches strings or {id}. Boarding junk would create
    // an active offer that can never be taken — a free stall of inventory.
    let created = 0;
    const p2p = stubP2p({
      createOffer: async () => {
        created++;
        throw new Error('create must not run');
      },
    });
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));
    await expect(
      createP2pRouter(p2p, stubInstruments())
        .createCaller(ctx)
        .offers.create({
          side: 'sell',
          asset: 'USDT',
          fiatCurrency: 'EUR',
          priceType: 'fixed',
          price: '1',
          minAmount: '10',
          maxAmount: '100',
          // TS wire type forbids bare `{}`; cast so we still prove runtime zod refuses it.
          methods: [{} as { id: string }],
        }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(created).toBe(0);
  });

  it('named-refuses live offers.create until OWNER KMS — createOffer never runs', async () => {
    let created = 0;
    const p2p = stubP2p({
      createOffer: async () => {
        created++;
        throw new Error('create must not run');
      },
    });
    const ctx = signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));
    await expect(
      createP2pRouter(p2p, stubInstruments())
        .createCaller(ctx)
        .offers.create({
          side: 'sell',
          asset: 'USDT',
          fiatCurrency: 'EUR',
          priceType: 'fixed',
          price: '1',
          minAmount: '10',
          maxAmount: '100',
          methods: ['sepa'],
          idempotencyKey: 'kms-refuse-key',
        }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.instrument_kms_required',
      cause: { code: 'p2p.instrument_kms_required' },
    });
    expect(created).toBe(0);
  });
});

describe('svc-p2p mount — merchants offer-limits honest API', () => {
  it('refuses offerLimits without p2p:read', async () => {
    const ctx = signed(principal({ scopes: [] }));
    await expect(createP2pRouter(stubP2p(), stubInstruments()).createCaller(ctx).merchants.offerLimits()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns unconfigured posture without inventing magnitudes', async () => {
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const wire = await createP2pRouter(stubP2p(), stubInstruments()).createCaller(ctx).merchants.offerLimits();
    expect(wire).toEqual({
      standardMax: null,
      merchantMax: null,
      configured: false,
      posture: 'unset',
      standardMode: 'unset',
      merchantMode: 'unset',
      summary: expect.stringMatching(/NONE CONFIGURED/),
    });
  });

  it('returns armed ceilings as decimal strings', async () => {
    const { parseAmount } = await import('@intafaced/ledger-client');
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const wire = await createP2pRouter(stubP2p(), stubInstruments(), undefined, {
      offerLimits: {
        standardMaxAmount: parseAmount('1000'),
        merchantMaxAmount: parseAmount('5000'),
      },
    })
      .createCaller(ctx)
      .merchants.offerLimits();
    expect(wire).toEqual({
      standardMax: '1000',
      merchantMax: '5000',
      configured: true,
      posture: 'configured',
      standardMode: 'capped',
      merchantMode: 'capped',
      summary: expect.stringContaining('1000'),
    });
  });

  it('myOfferCeiling refuses when the programme is not wired', async () => {
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    await expect(createP2pRouter(stubP2p(), stubInstruments()).createCaller(ctx).merchants.myOfferCeiling()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('myOfferCeiling puts approved merchants on the merchant band', async () => {
    const { parseAmount } = await import('@intafaced/ledger-client');
    const merchants = {
      get: async (userId: string) =>
        userId === USER
          ? {
              userId: USER,
              status: 'approved' as const,
              appliedCompletionRate: 0.99,
              appliedTradesTotal: 50,
              appliedAt: new Date('2026-01-01T00:00:00.000Z'),
              decidedAt: new Date('2026-01-02T00:00:00.000Z'),
            }
          : null,
    };
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const ceiling = await createP2pRouter(
      stubP2p(),
      stubInstruments(),
      undefined,
      {
        offerLimits: {
          standardMaxAmount: parseAmount('1000'),
          merchantMaxAmount: parseAmount('5000'),
        },
      },
      merchants as never,
    )
      .createCaller(ctx)
      .merchants.myOfferCeiling();
    expect(ceiling).toEqual({
      maxAmount: '5000',
      band: 'merchant',
      limitMode: 'capped',
      merchantStatus: 'approved',
    });
  });

  it('myOfferCeiling drops a frozen merchant onto the standard band', async () => {
    const { parseAmount } = await import('@intafaced/ledger-client');
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const ceiling = await createP2pRouter(
      stubP2p(),
      stubInstruments(),
      undefined,
      {
        offerLimits: {
          standardMaxAmount: parseAmount('1000'),
          merchantMaxAmount: parseAmount('5000'),
        },
      },
      merchantStub('suspended') as never,
    )
      .createCaller(ctx)
      .merchants.myOfferCeiling();
    expect(ceiling).toEqual({
      maxAmount: '1000',
      band: 'standard',
      limitMode: 'capped',
      merchantStatus: 'suspended',
    });
  });

  it('myOfferCeiling does not give an applicant the merchant ceiling', async () => {
    const { parseAmount } = await import('@intafaced/ledger-client');
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const ceiling = await createP2pRouter(
      stubP2p(),
      stubInstruments(),
      undefined,
      {
        offerLimits: {
          standardMaxAmount: parseAmount('1000'),
          merchantMaxAmount: parseAmount('5000'),
        },
      },
      merchantStub('applied') as never,
    )
      .createCaller(ctx)
      .merchants.myOfferCeiling();
    expect(ceiling).toEqual({
      maxAmount: '1000',
      band: 'standard',
      limitMode: 'capped',
      merchantStatus: 'applied',
    });
  });
});

describe('svc-p2p mount — merchants.decide dual-control', () => {
  const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };
  const TARGET = '33333333-3333-4333-8333-333333333333';

  function decideStub() {
    const calls: unknown[] = [];
    return {
      calls,
      merchants: {
        ...merchantStub('applied'),
        transition: async (input: unknown) => {
          calls.push(input);
          return {
            userId: TARGET,
            status: 'suspended',
            appliedCompletionRate: 1,
            appliedTradesTotal: 100,
            appliedAt: new Date('2026-01-01T00:00:00.000Z'),
            decidedAt: new Date('2026-01-02T00:00:00.000Z'),
          };
        },
      },
    };
  }

  it('refuses without MFA even with admin:compliance — no invented second factor', async () => {
    const { calls, merchants } = decideStub();
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, {}, merchants as never).createCaller(
      signed(principal({ scopes: ['admin:compliance'], mfa: false })),
    );
    await expect(
      caller.merchants.decide({ userId: TARGET, to: 'suspended', reason: 'operator freeze', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids and does not write', async () => {
    const { calls, merchants } = decideStub();
    const caller = createP2pRouter(
      stubP2p(),
      stubInstruments(),
      undefined,
      { approvals: stubApprovalConsumer(CONFIRM) },
      merchants as never,
    ).createCaller(signed(principal({ scopes: ['admin:compliance'], mfa: true })));
    await expect(caller.merchants.decide({ userId: TARGET, to: 'suspended', reason: 'operator freeze' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      caller.merchants.decide({ userId: TARGET, to: 'suspended', reason: 'operator freeze', confirmOperatorId: USER }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      caller.merchants.decide({ userId: TARGET, to: 'suspended', reason: 'operator freeze', confirmOperatorId: '   ' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls).toEqual([]);
  });

  it('freezes with MFA and a consumed approval', async () => {
    const { calls, merchants } = decideStub();
    const caller = createP2pRouter(
      stubP2p(),
      stubInstruments(),
      undefined,
      { approvals: stubApprovalConsumer(CONFIRM) },
      merchants as never,
    ).createCaller(signed(principal({ scopes: ['admin:compliance'], mfa: true })));
    await expect(
      caller.merchants.decide({
        userId: TARGET,
        to: 'suspended',
        reason: 'operator freeze',
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      }),
    ).resolves.toMatchObject({
      userId: TARGET,
      status: 'suspended',
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([
      {
        userId: TARGET,
        to: 'suspended',
        by: 'operator',
        reason: 'operator freeze',
        actorId: USER,
        actorScope: 'admin:compliance',
      },
    ]);
  });

  it('refuses decide when the consumed approver is missing and does not write', async () => {
    const { calls, merchants } = decideStub();
    const caller = createP2pRouter(
      stubP2p(),
      stubInstruments(),
      undefined,
      { approvals: consumedApproval(null) },
      merchants as never,
    ).createCaller(signed(principal({ scopes: ['admin:compliance'], mfa: true })));
    await expect(
      caller.merchants.decide({ userId: TARGET, to: 'suspended', reason: 'operator freeze', ...APPROVED }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls).toEqual([]);
  });

  it('refuses decide when the consumed approver is the requester and does not write', async () => {
    const { calls, merchants } = decideStub();
    const caller = createP2pRouter(
      stubP2p(),
      stubInstruments(),
      undefined,
      { approvals: consumedApproval(REQUESTER) },
      merchants as never,
    ).createCaller(signed(principal({ scopes: ['admin:compliance'], mfa: true })));
    await expect(
      caller.merchants.decide({ userId: TARGET, to: 'suspended', reason: 'operator freeze', ...APPROVED }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(calls).toEqual([]);
  });
});

describe('svc-p2p mount — merchants.history limit unset', () => {
  it('omit is PRECONDITION_FAILED — never invents a 50-row page', async () => {
    const merchants = {
      ...merchantStub('approved'),
      history: async (_userId: string, limit?: number) => {
        assertMerchantHistoryLimit(limit);
        return [];
      },
    };
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, {}, merchants as never).createCaller(
      signed(principal({ scopes: ['admin:compliance'] })),
    );
    await expect(caller.merchants.history({ userId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'p2p.merchant_history_limit_unset',
    });
    await expect(caller.merchants.history({ userId: USER, limit: 50 })).resolves.toEqual([]);
  });
});

describe('svc-p2p mount — freeze is visible on the reputation door', () => {
  function spotlessCounters(): ReputationCounters {
    return {
      tradesTotal: 60,
      completed: 60,
      cancelled: 0,
      disputed: 0,
      disputesLost: 0,
      totalReleaseSecs: 600,
      releaseSamples: 60,
    };
  }

  it('keeps derived badges and drops merchant vouch when standing is frozen', async () => {
    const snap = snapshotOf(spotlessCounters());
    const p2p = stubP2p({ reputationOf: async () => snap });
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const door = await createP2pRouter(p2p, stubInstruments(), undefined, {}, merchantStub('suspended') as never)
      .createCaller(ctx)
      .reputation.get({ userId: USER });

    expect(door.merchant).toBe(false);
    expect(door.badges).toEqual(snap.badges);
    expect(door.badges).toContain('spotless');
    expect(door).not.toHaveProperty('p2pLimitMultiplier');
  });

  it('restores programme vouch on unfreeze without minting a badge', async () => {
    const snap = snapshotOf(spotlessCounters());
    const p2p = stubP2p({ reputationOf: async () => snap });
    const ctx = signed(principal({ scopes: ['p2p:read'] }));
    const door = await createP2pRouter(p2p, stubInstruments(), undefined, {}, merchantStub('approved') as never)
      .createCaller(ctx)
      .reputation.get({ userId: USER });

    expect(door.merchant).toBe(true);
    expect(door.badges).toEqual(snap.badges);
  });
});

describe('svc-p2p mount — block/RFQ doors', () => {
  const TAKER = '22222222-2222-4222-8222-222222222222';
  const EXPIRY = new Date(Date.now() + 60_000).toISOString();
  const firm = { capacity: 'principal' as const, firmness: 'firm' as const };

  it('refuses anonymous quote/accept/expire', async () => {
    const blockRfq = new BlockRfqService(new MemoryBlockQuoteStore());
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, { blockRfq }).createCaller(anonymous());
    await expect(
      caller.rfq.quote({
        takerId: TAKER,
        side: 'sell',
        asset: 'USDT',
        fiatCurrency: 'USD',
        size: '10',
        price: '1',
        expiresAt: EXPIRY,
        ...firm,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.rfq.accept({ quoteId: '55555555-5555-4555-8555-555555555555' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.rfq.expire({ quoteId: '55555555-5555-4555-8555-555555555555' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses a caller-supplied midPrice rather than quoting off it', async () => {
    const blockRfq = new BlockRfqService(new MemoryBlockQuoteStore());
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, { blockRfq }).createCaller(
      signed(principal({ scopes: ['p2p:write'] })),
    );
    await expect(
      caller.rfq.quote({
        takerId: TAKER,
        side: 'sell',
        asset: 'USDT',
        fiatCurrency: 'USD',
        size: '10',
        price: '1',
        expiresAt: EXPIRY,
        ...firm,
        midPrice: '999',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('quotes, accepts, expires with decimal strings and refuses allocation/give-up', async () => {
    const blockRfq = new BlockRfqService(new MemoryBlockQuoteStore(), { now: () => new Date('2026-08-26T12:00:00.000Z') });
    const makerCaller = createP2pRouter(stubP2p(), stubInstruments(), undefined, { blockRfq }).createCaller(
      signed(principal({ scopes: ['p2p:read', 'p2p:write'] })),
    );
    const quoted = await makerCaller.rfq.quote({
      takerId: TAKER,
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'USD',
      size: '10.00',
      price: '1.25',
      expiresAt: '2026-08-26T12:05:00.000Z',
      ...firm,
    });
    expect(quoted.bookFill).toBe(false);
    expect(quoted.midInvented).toBe(false);
    expect(quoted.lastLook).toBe(false);
    expect(quoted.capacity).toBe('principal');
    expect(quoted.firmness).toBe('firm');
    expect(quoted.size).toBe('10');
    expect(quoted.price).toBe('1.25');

    const takerCaller = createP2pRouter(stubP2p(), stubInstruments(), undefined, { blockRfq }).createCaller(
      signed(principal({ userId: TAKER, sub: TAKER, scopes: ['p2p:read', 'p2p:write'] })),
    );
    const bound = await takerCaller.rfq.accept({ quoteId: quoted.quoteId, assertedPrice: '1.25' });
    expect(bound.lifecycle).toBe('bound');
    expect(bound.fillPrice).toBe('1.25');
    expect(bound.bookFill).toBe(false);

    await expect(
      takerCaller.rfq.allocate({ quoteId: quoted.quoteId, allocations: [{ account: 'fund-a', size: '5' }] } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(takerCaller.rfq.giveUp({ quoteId: quoted.quoteId } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      takerCaller.rfq.allocate({ quoteId: quoted.quoteId, allocations: [{ receivingAccount: 'fund-a' }] }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/refuse-closed/),
    });
    await expect(takerCaller.rfq.giveUp({ quoteId: quoted.quoteId, receivingAccount: 'carrying-1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/refuse-closed/),
    });

    const open = await makerCaller.rfq.quote({
      takerId: TAKER,
      side: 'buy',
      asset: 'USDT',
      fiatCurrency: 'USD',
      size: '2',
      price: '1',
      expiresAt: '2026-08-26T12:05:00.000Z',
      ...firm,
    });
    const expired = await makerCaller.rfq.expire({ quoteId: open.quoteId });
    expect(expired.lifecycle).toBe('expired');
    await expect(takerCaller.rfq.accept({ quoteId: open.quoteId })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('unwired RFQ doors refuse rather than invent a quote', async () => {
    const caller = createP2pRouter(stubP2p(), stubInstruments()).createCaller(signed(principal({ scopes: ['p2p:write'] })));
    await expect(
      caller.rfq.quote({
        takerId: TAKER,
        side: 'sell',
        asset: 'USDT',
        fiatCurrency: 'USD',
        size: '1',
        price: '1',
        expiresAt: EXPIRY,
        ...firm,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('last-look quote and unlabeled capacity refuse at the door', async () => {
    const blockRfq = new BlockRfqService(new MemoryBlockQuoteStore(), { now: () => new Date('2026-08-26T12:00:00.000Z') });
    const caller = createP2pRouter(stubP2p(), stubInstruments(), undefined, { blockRfq }).createCaller(
      signed(principal({ scopes: ['p2p:write'] })),
    );
    await expect(
      caller.rfq.quote({
        takerId: TAKER,
        side: 'sell',
        asset: 'USDT',
        fiatCurrency: 'USD',
        size: '1',
        price: '1',
        expiresAt: '2026-08-26T12:05:00.000Z',
        capacity: 'principal',
        firmness: 'firm',
        lastLook: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/last look/i) });
    await expect(
      caller.rfq.quote({
        takerId: TAKER,
        side: 'sell',
        asset: 'USDT',
        fiatCurrency: 'USD',
        size: '1',
        price: '1',
        expiresAt: '2026-08-26T12:05:00.000Z',
        firmness: 'firm',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/capacity/i) });
  });
});

describe('svc-p2p strict screening control', () => {
  it('refuses an actually blank screening list before reading offers or touching escrow', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'true');
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', '');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', '');
    let reads = 0;
    const p2p = stubP2p({
      listOffers: async () => {
        reads += 1;
        return [];
      },
    });
    await expect(
      createP2pRouter(p2p, stubInstruments())
        .createCaller(signed(principal({ scopes: ['p2p:read'] })))
        .offers.list({ limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'denied.screening_unconfigured' } });
    expect(reads).toBe(0);
  });
});

describe('svc-p2p mount — sensitive-remark cases (P-ads-merchant-19, J-p2p-04 #5)', () => {
  const TRADE = '44444444-4444-4444-8444-444444444444';
  const CASE = '55555555-5555-4555-8555-555555555555';
  const opened = {
    id: CASE,
    tradeId: TRADE,
    reporterId: USER,
    reportedId: '66666666-6666-4666-8666-666666666666',
    reporterRole: 'seller' as const,
    remark: 'USDT',
    status: 'open' as const,
    openedAt: new Date('2026-10-25T10:00:00.000Z'),
  };
  const writer = () => signed(principal({ scopes: ['p2p:read', 'p2p:write'] }));

  it('reports as the signed-in party, trimmed, and maps a repeat to CONFLICT and a bad quote to BAD_REQUEST', async () => {
    const seen: unknown[] = [];
    let answer: () => unknown = () => opened;
    const p2p = stubP2p({
      reportSensitiveRemark: async (input: unknown) => {
        seen.push(input);
        return answer();
      },
    });
    const caller = createP2pRouter(p2p, stubInstruments()).createCaller(writer());
    expect(await caller.trades.reportSensitiveRemark({ caseId: CASE, tradeId: TRADE, remark: '  USDT  ' })).toMatchObject({
      id: CASE,
      openedAt: '2026-10-25T10:00:00.000Z',
    });
    expect(seen).toEqual([{ caseId: CASE, tradeId: TRADE, reporterId: USER, remark: 'USDT' }]);
    answer = () => {
      throw new P2pError('exists', 'p2p.remark_case_exists');
    };
    await expect(caller.trades.reportSensitiveRemark({ caseId: CASE, tradeId: TRADE, remark: 'x' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'p2p.remark_case_exists' },
    });
    answer = () => {
      throw new P2pError('invalid', 'p2p.remark_invalid');
    };
    await expect(caller.trades.reportSensitiveRemark({ caseId: CASE, tradeId: TRADE, remark: 'x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'p2p.remark_invalid' },
    });
    await expect(caller.trades.reportSensitiveRemark({ caseId: CASE, tradeId: TRADE, remark: 'x'.repeat(281) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(seen).toHaveLength(3);
  });

  it('reads the caller’s own case or null, and lists the open cases to moderators only', async () => {
    let own: typeof opened | null = opened;
    let listed = 0;
    const p2p = stubP2p({
      ownRemarkCase: async (tradeId: string, userId: string) => (tradeId === TRADE && userId === USER ? own : null),
      listRemarkCases: async () => {
        listed += 1;
        return [opened];
      },
    });
    const MODERATOR = '77777777-7777-4777-8777-777777777777';
    const caller = createP2pRouter(p2p, stubInstruments(), undefined, { moderatorUserIds: [MODERATOR] }).createCaller(writer());
    expect(await caller.trades.remarkCase({ tradeId: TRADE })).toMatchObject({ id: CASE, remark: 'USDT' });
    own = null;
    expect(await caller.trades.remarkCase({ tradeId: TRADE })).toBeNull();
    await expect(caller.disputes.remarkCases({ limit: 10 })).rejects.toMatchObject({ cause: { code: 'p2p.not_a_moderator' } });
    expect(listed).toBe(0);
    const moderator = createP2pRouter(p2p, stubInstruments(), undefined, { moderatorUserIds: [USER] }).createCaller(writer());
    expect(await moderator.disputes.remarkCases({ limit: 10 })).toEqual({ cases: [expect.objectContaining({ id: CASE })] });
  });
});
