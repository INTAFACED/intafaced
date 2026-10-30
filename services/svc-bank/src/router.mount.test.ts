import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { AUTO_INVEST_KINDS, AUTO_INVEST_RATE_UNSET, describeAutoInvestPolicy } from './auto-invest/auto-invest-policy.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { createBankRouter } from './router.js';
import type { BankServices } from './bank-service.js';

/**
 * THE MOUNT BOUNDARY, for svc-bank (docs/decisions/mount-boundary.md).
 *
 * The context is built the way `index.ts` builds it — through
 * `createEdgeContext` over real headers — not as a `Context` literal. A literal
 * would keep passing if the service went back to trusting
 * `JSON.parse(req.headers['x-intafaced-principal'])`, which is the exact bug
 * this boundary exists to prevent. Every procedure here resolves
 * `ctx.principal.userId` into somebody's spaces and standing orders, so a
 * forgeable principal is a forgeable account holder.
 *
 * `bank` is `OPEN_FULL` in the jurisdiction matrix: `full` verification is the
 * floor, and the guard — not this service — is what enforces it.
 */

const SECRET = 'a-bank-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL = { approvalId: 'appr-1', operationId: 'op-1' } as const;
const POOL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LOAN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

/** No credentials of any kind — a caller who simply found the port. */
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

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

/** A principal the caller wrote themselves. No signature. */
function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'req-forged',
  });
}

function stubBank(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    spaces: { unnamedAssets: async () => [], ...(overrides.spaces as object | undefined) },
    transfers: {
      runDueTransfers: async () => ({
        schedulesConsidered: 0,
        settled: 0,
        rejected: 0,
        alreadyFired: 0,
        strandedSwept: 0,
        failures: [],
      }),
      ...(overrides.transfers as object | undefined),
    },
    earn: {
      accrue: async () => ({
        poolId: '00000000-0000-4000-8000-000000000001',
        date: '2026-01-01',
        paid: 0n,
        recipients: 0,
        alreadyAccrued: false,
      }),
      accrueAll: async () => ({ results: [], failures: [] }),
      ...(overrides.earn as object | undefined),
    },
    loans: {
      originationFeeBps: '0',
      accrue: async () => ({ loanId: '00000000-0000-4000-8000-000000000002', charged: 0n, days: [] as string[] }),
      accrueAll: async () => ({ results: [], failures: [] }),
      runRiskSweep: async () => ({ marked: 0, called: 0, liquidated: 0, cleared: 0, refused: [] }),
      ...(overrides.loans as object | undefined),
    },
    autoInvest: {
      runDue: async () => ({ considered: 0, settled: 0, skipped: 0, rejected: 0, failures: [] }),
      ...(overrides.autoInvest as object | undefined),
    },
    business: {
      accountsOf: async () => [],
      ...(overrides.business as object | undefined),
    },
    cards: {
      ...(overrides.cards as object | undefined),
    },
    ramps: {
      ...(overrides.ramps as object | undefined),
    },
  } as unknown as BankServices;
}

describe('svc-bank mount — authorisation', () => {
  it('refuses an anonymous caller on a scoped procedure, and reads nothing', async () => {
    let read = false;
    const bank = stubBank({
      spaces: {
        unnamedAssets: async () => {
          read = true;
          return [];
        },
      },
    });

    await expect(createBankRouter(bank).createCaller(anonymous()).spaces.unnamed()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(read).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * `full` tier and `mfa: true` are both things an attacker would simply write
   * into the header. Unsigned, they buy nothing.
   */
  it('refuses a self-asserted principal, however privileged it claims to be', async () => {
    const ctx = forged(principal({ scopes: ['bank:read', 'bank:write', 'admin:treasury'], tier: 'full', mfa: true }));
    expect(ctx.principal).toBeNull();

    await expect(createBankRouter(stubBank()).createCaller(ctx).spaces.unnamed()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('accepts a principal the edge signed', async () => {
    await expect(createBankRouter(stubBank()).createCaller(signed()).spaces.unnamed()).resolves.toEqual([]);
  });
});

describe('svc-bank mount — the public surface', () => {
  it('serves health to an anonymous caller', async () => {
    await expect(createBankRouter(stubBank()).createCaller(anonymous()).health()).resolves.toEqual({
      ok: true,
      service: 'svc-bank',
    });
  });

  it('serves health even when a forged principal was presented', async () => {
    await expect(createBankRouter(stubBank()).createCaller(forged()).health()).resolves.toMatchObject({ ok: true });
  });
});

describe('svc-bank mount — ops.runDueTransfers kill switch', () => {
  const jobCaller = () => ({
    ...signed(principal({ scopes: ['admin:treasury'], tier: 'full', mfa: true })),
    service: 'svc-bank' as const,
  });

  it('refuses with SERVICE_UNAVAILABLE / bank.transfers_disabled when the flag is off, and never runs', async () => {
    let ran = false;
    const bank = stubBank({
      transfers: {
        runDueTransfers: async () => {
          ran = true;
          return {
            schedulesConsidered: 1,
            settled: 1,
            rejected: 0,
            alreadyFired: 0,
            strandedSwept: 0,
            failures: [],
          };
        },
      },
    });

    await expect(
      createBankRouter(bank, { scheduledTransfersEnabled: false }).createCaller(jobCaller()).ops.runDueTransfers({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'bank.transfers_disabled' },
    });
    expect(ran).toBe(false);
  });

  it('runs when the flag is on', async () => {
    let ran = false;
    const bank = stubBank({
      transfers: {
        runDueTransfers: async () => {
          ran = true;
          return {
            schedulesConsidered: 0,
            settled: 0,
            rejected: 0,
            alreadyFired: 0,
            strandedSwept: 0,
            failures: [],
          };
        },
      },
    });

    await expect(
      createBankRouter(bank, { scheduledTransfersEnabled: true }).createCaller(jobCaller()).ops.runDueTransfers({}),
    ).resolves.toMatchObject({ schedulesConsidered: 0, settled: 0 });
    expect(ran).toBe(true);
  });
});

/**
 * Kill-switch parity residual (#1271 shape for earn / loan / risk):
 * HTTP jobs honour INTEREST_ACCRUAL_ENABLED, LOAN_ACCRUAL_ENABLED, and
 * LOAN_RISK_SWEEP_ENABLED. tRPC `ops.*` must not be a back door past them.
 */
describe('svc-bank mount — ops job kill switches (earn / loan / risk)', () => {
  const jobCaller = () => ({
    ...signed(principal({ scopes: ['admin:treasury'], tier: 'full', mfa: true })),
    service: 'svc-bank' as const,
  });

  it('ops.accrueInterest refuses when interestAccrualEnabled is false, and never runs', async () => {
    let ran = false;
    const bank = stubBank({
      earn: {
        accrueAll: async () => {
          ran = true;
          return { results: [], failures: [] };
        },
        accrue: async () => {
          ran = true;
          return {
            poolId: '00000000-0000-4000-8000-000000000001',
            date: '2026-01-01',
            paid: 0n,
            recipients: 0,
            alreadyAccrued: false,
          };
        },
      },
    });

    await expect(
      createBankRouter(bank, { interestAccrualEnabled: false }).createCaller(jobCaller()).ops.accrueInterest({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'bank.interest_accrual_disabled' },
    });
    expect(ran).toBe(false);
  });

  it('ops.accrueInterest runs when the flag is on', async () => {
    let ran = false;
    const bank = stubBank({
      earn: {
        accrueAll: async () => {
          ran = true;
          return { results: [], failures: [] };
        },
      },
    });

    await expect(
      createBankRouter(bank, { interestAccrualEnabled: true }).createCaller(jobCaller()).ops.accrueInterest({}),
    ).resolves.toMatchObject({ results: [], failures: [] });
    expect(ran).toBe(true);
  });

  it('ops.accrueInterest refuses a day that has not begun, for one pool or all, and never runs', async () => {
    let ran = false;
    const bank = stubBank({
      earn: {
        accrueAll: async () => {
          ran = true;
          return { results: [], failures: [] };
        },
        accrue: async () => {
          ran = true;
          return { poolId: POOL, date: '2026-01-01', paid: 0n, recipients: 0, alreadyAccrued: false };
        },
      },
    });
    const caller = createBankRouter(bank, { interestAccrualEnabled: true }).createCaller(jobCaller());
    // Two days ahead, so a run that crosses midnight still asks for a day that has not begun.
    const ahead = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const aheadStart = new Date(`${ahead.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();

    for (const input of [{ at: aheadStart }, { poolId: POOL, at: aheadStart }]) {
      await expect(caller.ops.accrueInterest(input)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'bank.accrual_day_not_begun' },
      });
    }
    expect(ran).toBe(false);

    // Today has begun, so a late hour of today is paid.
    const today = new Date().toISOString().slice(0, 10);
    await expect(caller.ops.accrueInterest({ poolId: POOL, at: `${today}T23:59:59.000Z` })).resolves.toMatchObject({
      results: [{ poolId: POOL }],
    });
    expect(ran).toBe(true);
  });

  it('ops.accrueLoanInterest refuses when loanAccrualEnabled is false, and never runs', async () => {
    let ran = false;
    const bank = stubBank({
      loans: {
        originationFeeBps: '0',
        accrueAll: async () => {
          ran = true;
          return { results: [], failures: [] };
        },
        accrue: async () => {
          ran = true;
          return { loanId: '00000000-0000-4000-8000-000000000002', charged: 0n, days: [] as string[] };
        },
      },
    });

    await expect(
      createBankRouter(bank, { loanAccrualEnabled: false }).createCaller(jobCaller()).ops.accrueLoanInterest({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'bank.loan_accrual_disabled' },
    });
    expect(ran).toBe(false);
  });

  it('ops.runRiskSweep refuses when loanRiskSweepEnabled is false, and never runs', async () => {
    let ran = false;
    const bank = stubBank({
      loans: {
        originationFeeBps: '0',
        runRiskSweep: async () => {
          ran = true;
          return { marked: 0, called: 0, liquidated: 0, cleared: 0, refused: [] };
        },
      },
    });

    await expect(
      createBankRouter(bank, { loanRiskSweepEnabled: false }).createCaller(jobCaller()).ops.runRiskSweep({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'bank.loan_risk_sweep_disabled' },
    });
    expect(ran).toBe(false);
  });

  it('ops.runRiskSweep runs when the flag is on', async () => {
    let ran = false;
    const bank = stubBank({
      loans: {
        originationFeeBps: '0',
        runRiskSweep: async () => {
          ran = true;
          return { marked: 1, called: 0, liquidated: 0, cleared: 0, refused: [] };
        },
      },
    });

    await expect(
      createBankRouter(bank, { loanRiskSweepEnabled: true }).createCaller(jobCaller()).ops.runRiskSweep({}),
    ).resolves.toMatchObject({ marked: 1 });
    expect(ran).toBe(true);
  });
});

/**
 * Kill-switch parity for auto-invest (#1526 shape): HTTP
 * `/internal/jobs/run-auto-invest` and tRPC `ops.runAutoInvest` share
 * `AUTO_INVEST_ENABLED` / `bank.auto_invest_disabled`. tRPC is not a back door.
 */
describe('svc-bank mount — ops.runAutoInvest kill switch', () => {
  const jobCaller = () => ({
    ...signed(principal({ scopes: ['admin:treasury'], tier: 'full', mfa: true })),
    service: 'svc-bank' as const,
  });

  it('refuses with SERVICE_UNAVAILABLE / bank.auto_invest_disabled when the flag is off, and never runs', async () => {
    let ran = false;
    const bank = stubBank({
      autoInvest: {
        runDue: async () => {
          ran = true;
          return { considered: 1, settled: 1, skipped: 0, rejected: 0, failures: [] };
        },
      },
    });

    await expect(
      createBankRouter(bank, { autoInvestEnabled: false }).createCaller(jobCaller()).ops.runAutoInvest({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'bank.auto_invest_disabled' },
    });
    expect(ran).toBe(false);
  });

  it('runs when the flag is on', async () => {
    let ran = false;
    const bank = stubBank({
      autoInvest: {
        runDue: async () => {
          ran = true;
          return { considered: 0, settled: 0, skipped: 0, rejected: 0, failures: [] };
        },
      },
    });

    await expect(
      createBankRouter(bank, { autoInvestEnabled: true }).createCaller(jobCaller()).ops.runAutoInvest({}),
    ).resolves.toMatchObject({ considered: 0, settled: 0 });
    expect(ran).toBe(true);
  });
});

describe('svc-bank mount — autoInvest.policy honesty door', () => {
  it('is public and mirrors describeAutoInvestPolicy for convert + rule kinds', async () => {
    const bank = stubBank();
    const expected = describeAutoInvestPolicy({ enabled: true, convertWired: false });
    const result = await createBankRouter(bank, { autoInvestEnabled: true, autoInvestConvertWired: false })
      .createCaller(anonymous())
      .autoInvest.policy();
    expect(result).toEqual(expected);
    expect(result.kinds).toEqual(AUTO_INVEST_KINDS);
    expect(result.rateUnsetCode).toBe(AUTO_INVEST_RATE_UNSET);
    expect(result.inventsRates).toBe(false);
    expect(result.convertWired).toBe(false);

    const wired = await createBankRouter(bank, { autoInvestEnabled: false, autoInvestConvertWired: true })
      .createCaller(anonymous())
      .autoInvest.policy();
    expect(wired.enabled).toBe(false);
    expect(wired.convertWired).toBe(true);
  });
});

describe('svc-bank mount — treasury value mutates identity consume', () => {
  const treasury = (overrides: Partial<Principal> = {}) =>
    signed(principal({ userId: OP, sub: OP, scopes: ['admin:treasury'], tier: 'full', mfa: true, ...overrides }));
  const approvals = () => ({ approvals: stubApprovalConsumer(CONFIRM) });

  it('refuses missing approval ids without posting — a typed-in name is not approval', async () => {
    let funded = 0;
    const bank = stubBank({
      earn: {
        fundPool: async () => {
          funded += 1;
          return { ledgerTxId: 'tx-should-not-land' };
        },
      },
    });
    const caller = createBankRouter(bank, approvals()).createCaller(treasury());
    await expect(caller.ops.fundPool({ poolId: POOL, fundingId: 'fund-1', amount: '10' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      caller.ops.fundPool({ poolId: POOL, fundingId: 'fund-1', amount: '10', confirmOperatorId: CONFIRM }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(
      caller.ops.fundPool({ poolId: POOL, fundingId: 'fund-1', amount: '10', confirmOperatorId: CONFIRM, approvalId: 'appr-1' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(funded).toBe(0);
  });

  it('admin:treasury without MFA is UNAUTHORIZED even with approval ids', async () => {
    let funded = 0;
    const bank = stubBank({
      earn: {
        fundPool: async () => {
          funded += 1;
          return { ledgerTxId: 'tx-should-not-land' };
        },
      },
    });
    await expect(
      createBankRouter(bank, approvals())
        .createCaller(treasury({ mfa: false }))
        .ops.fundPool({ poolId: POOL, fundingId: 'fund-1', amount: '10', confirmOperatorId: CONFIRM, ...APPROVAL }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(funded).toBe(0);
  });

  it('MFA plus consumed approval funds, seizes, cards, and credits', async () => {
    const calls: string[] = [];
    const bank = stubBank({
      earn: {
        fundPool: async () => {
          calls.push('fundPool');
          return { ledgerTxId: 'tx-pool' };
        },
      },
      loans: {
        originationFeeBps: '0',
        fundReserve: async () => {
          calls.push('fundReserve');
          return { ledgerTxId: 'tx-reserve' };
        },
        seize: async () => {
          calls.push('seize');
          return {
            ledgerTxId: 'tx-seize',
            collateralSold: parseAmount('1'),
            proceeds: parseAmount('1'),
            principalRepaid: parseAmount('1'),
            interestRepaid: parseAmount('0'),
            closed: true,
          };
        },
        abandonPending: async () => {
          calls.push('abandon');
          return { released: parseAmount('1'), ledgerTxId: 'tx-abandon', adopted: false, drawLedgerTxId: null };
        },
      },
      cards: {
        authorize: async () => {
          calls.push('authorize');
          return { id: 'auth-1', decision: 'approved', declineCode: null, amount: parseAmount('10'), conversion: null };
        },
        capture: async () => {
          calls.push('capture');
          return {
            captured: parseAmount('10'),
            returned: parseAmount('0'),
            captureLedgerTxId: 'tx-cap',
            reversalLedgerTxId: null,
            settlement: null,
            cashback: { status: 'none', amount: parseAmount('0') },
            roundUp: { status: 'none', amount: parseAmount('0') },
          };
        },
        reverse: async () => {
          calls.push('reverse');
          return { returned: parseAmount('10'), ledgerTxId: 'tx-rev' };
        },
        resumeSettlements: async () => {
          calls.push('resume');
          return { authorizationId: 'auth-1', resumed: [], held: parseAmount('0') };
        },
        fundCashbackPot: async () => {
          calls.push('pot');
          return { ledgerTxId: 'tx-pot' };
        },
        cashbackCapacity: async () => parseAmount('10'),
      },
      ramps: {
        creditOnramp: async () => {
          calls.push('credit');
          return {
            id: 'on-1',
            userId: USER,
            assetId: 'USDT',
            amount: parseAmount('10'),
            kind: 'crypto',
            rail: 'test',
            railRef: 'r-1',
            simulated: true,
            status: 'settled',
            ledgerTxId: 'tx-on',
          };
        },
      },
    });
    const caller = createBankRouter(bank, approvals()).createCaller(treasury());

    await expect(
      caller.ops.fundPool({ poolId: POOL, fundingId: 'fund-1', amount: '10', confirmOperatorId: CONFIRM, ...APPROVAL }),
    ).resolves.toEqual({
      ledgerTxId: 'tx-pool',
      confirmOperatorId: CONFIRM,
    });
    await expect(
      caller.ops.fundLoanReserve({
        debtAssetId: 'USDT',
        fundingId: 'fund-r',
        amount: '10',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).resolves.toEqual({ ledgerTxId: 'tx-reserve', confirmOperatorId: CONFIRM });
    await expect(caller.ops.seizeLoan({ loanId: LOAN, confirmOperatorId: CONFIRM, ...APPROVAL })).resolves.toMatchObject({
      ledgerTxId: 'tx-seize',
      confirmOperatorId: CONFIRM,
    });
    await expect(caller.ops.abandonPendingLoan({ loanId: LOAN, confirmOperatorId: CONFIRM, ...APPROVAL })).resolves.toEqual({
      released: '1',
      ledgerTxId: 'tx-abandon',
      adopted: false,
      drawLedgerTxId: null,
      confirmOperatorId: CONFIRM,
    });
    await expect(
      caller.ops.cardAuthorize({
        cardId: CARD,
        authorizationRef: 'auth-ref-1',
        amount: '10',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).resolves.toMatchObject({ authorizationId: 'auth-1', decision: 'approved', confirmOperatorId: CONFIRM });
    await expect(
      caller.ops.cardCapture({
        cardId: CARD,
        authorizationRef: 'auth-ref-1',
        amount: '10',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).resolves.toMatchObject({ captured: '10', confirmOperatorId: CONFIRM });
    await expect(
      caller.ops.cardReverse({ cardId: CARD, authorizationRef: 'auth-ref-1', confirmOperatorId: CONFIRM, ...APPROVAL }),
    ).resolves.toEqual({
      returned: '10',
      ledgerTxId: 'tx-rev',
      confirmOperatorId: CONFIRM,
    });
    await expect(
      caller.ops.cardResumeSettlement({ cardId: CARD, authorizationRef: 'auth-ref-1', confirmOperatorId: CONFIRM, ...APPROVAL }),
    ).resolves.toMatchObject({ authorizationId: 'auth-1', confirmOperatorId: CONFIRM });
    await expect(
      caller.ops.fundCashbackPot({
        windowId: 'win-1',
        assetId: 'USDT',
        amount: '10',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).resolves.toEqual({ ledgerTxId: 'tx-pot', capacity: '10', confirmOperatorId: CONFIRM });
    await expect(
      caller.ops.creditOnramp({
        userId: USER,
        assetId: 'USDT',
        amount: '10',
        kind: 'crypto',
        railRef: 'rail-1',
        confirmOperatorId: CONFIRM,
        ...APPROVAL,
      }),
    ).resolves.toMatchObject({ id: 'on-1', confirmOperatorId: CONFIRM });

    expect(calls).toEqual(['fundPool', 'fundReserve', 'seize', 'abandon', 'authorize', 'capture', 'reverse', 'resume', 'pot', 'credit']);
  });

  it('HMAC jobs still run without confirmOperatorId — not a human door', async () => {
    let swept = 0;
    const bank = stubBank({
      loans: {
        originationFeeBps: '0',
        runRiskSweep: async () => {
          swept += 1;
          return { marked: 0, called: 0, liquidated: 0, cleared: 0, refused: [] };
        },
      },
    });
    const hmac = { ...signed(principal({ scopes: ['admin:treasury'], tier: 'full', mfa: true })), service: 'svc-bank' as const };
    await expect(createBankRouter(bank).createCaller(hmac).ops.runRiskSweep({})).resolves.toMatchObject({ marked: 0 });
    expect(swept).toBe(1);
  });
});
