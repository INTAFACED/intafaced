/**
 * D26-P2-12 — tip re-prove of identity money doors.
 *
 * Matching + ledger own the tradeFill spine; identity owns the two money
 * doors that still touch ledger recipes on tip: affiliates.payout (posts
 * through ledger-client) and subAccounts.assertTransferDoor (pure assert —
 * money services call it before recipes.subAccountTransfer). Softening either
 * into a silent invent / silent post fails here while engine-only suites could
 * stay green.
 *
 * Class: N (honesty). Leverage: createIdentityRouter + MemoryLedger + recipes
 * (Phase A — no second book).
 */
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, houseFees, parseAmount, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';
import { AuthError, type AuthService } from './auth/auth-service.js';
import type { FreezeService } from './affiliates/freeze-service.js';
import { MemoryAccrualStore } from './affiliates/accrual-store.js';
import type { CommissionRow } from './affiliates/commission.js';
import type { RankService } from './rank/rank-service.js';
import { createIdentityRouter } from './router.js';
import { stubActionApprovals } from './auth/privileged-dual-control.js';

const authConfig = {
  secret: 'identity-money-spine-tip-reprove-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OPERATOR = '22222222-2222-4222-8222-222222222222';
const CONFIRM = '55555555-5555-4555-8555-555555555555';
const OWNER = '11111111-1111-4111-8111-111111111111';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PAYER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BENE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FEE_EVT = 'fee-evt-spine-tip-1';
const ASSET = 'USDT';
const SUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function ctx(scopes: string[], opts: { userId?: string } = {}): Promise<Context> {
  if (scopes.length === 0) return { principal: null, service: null, region: 'DE', requestId: 'req-spine' };
  const { token } = await issueAccessToken(
    {
      userId: opts.userId ?? OWNER,
      sessionId: SESSION,
      scopes,
      tier: 'none',
      mfa: true,
    },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-spine' };
}

const codeOf = (err: unknown) => (err as { code?: string }).code;

const publishedLaw = {
  published: true as const,
  tiers: [{ hop: 0, rate: '0.10' }],
};

function accrualRow(): CommissionRow {
  return {
    feeEventId: FEE_EVT,
    beneficiaryId: BENE,
    payerId: PAYER,
    hop: 0,
    rate: '0.10',
    feeAmount: '100',
    commissionAmount: '10',
    asset: ASSET,
    accruedAt: new Date('2026-08-12T00:00:00.000Z'),
    sourceModule: 'identity',
  };
}

async function fundedLedger(): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({
      userId: PAYER,
      assetId: ASSET,
      amount: parseAmount('1000'),
      rail: 'crypto-native',
      railRef: 'spine-tip-seed',
    }),
  );
  await ledger.post(
    recipes.feeCharge({
      mode: 'asset',
      chargeId: FEE_EVT,
      userId: PAYER,
      module: 'identity',
      assetId: ASSET,
      amount: parseAmount('100'),
    }),
  );
  return ledger;
}

const bal = async (l: MemoryLedger, ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await l.balance(ref)).amount);

describe('D26-P2-12 tip re-prove — identity money doors', () => {
  it('affiliates.payout on the mount pays once; retry leaves balances unchanged', async () => {
    const ledger = await fundedLedger();
    const store = new MemoryAccrualStore();
    await store.saveRows([accrualRow()]);
    const auth = {} as AuthService;
    const rank = {} as RankService;
    const router = createIdentityRouter(auth, rank, {
      actionApprovals: stubActionApprovals(),
      registrationOpen: true,
      accruals: store,
      accrualTierLaw: publishedLaw,
      ledger,
      freeze: { frozenIds: async () => new Set<string>() } as unknown as FreezeService,
    });
    const api = router.createCaller(await ctx(['admin:write'], { userId: OPERATOR }));

    const first = await api.affiliates.payout({ feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' });
    const second = await api.affiliates.payout({ feeEventId: FEE_EVT, approvalId: 'appr-1', operationId: 'op-1' });

    expect(first.posted).toBe(true);
    expect(second.idempotencyKeys).toEqual(first.idempotencyKeys);
    expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('10');
    expect(await bal(ledger, houseFees('identity', ASSET))).toBe('90');
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('0');
  });

  it('affiliates.payout without admin:write moves nothing', async () => {
    const ledger = await fundedLedger();
    const store = new MemoryAccrualStore();
    await store.saveRows([accrualRow()]);
    const router = createIdentityRouter({} as AuthService, {} as RankService, {
      actionApprovals: stubActionApprovals(),
      registrationOpen: true,
      accruals: store,
      accrualTierLaw: publishedLaw,
      ledger,
      freeze: { frozenIds: async () => new Set<string>() } as unknown as FreezeService,
    });
    const api = router.createCaller(await ctx(['identity:read'], { userId: OPERATOR }));

    const err = await api.affiliates.payout({ feeEventId: FEE_EVT }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('FORBIDDEN');
    expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('0');
    expect(await bal(ledger, houseFees('identity', ASSET))).toBe('100');
  });

  it('assertTransferDoor is mounted, refuses missing ids, and never posts ledger', async () => {
    const ledger = await fundedLedger();
    let posts = 0;
    const wrapped: Pick<MemoryLedger, 'post' | 'balance'> = {
      post: async (req) => {
        posts += 1;
        return ledger.post(req);
      },
      balance: (ref) => ledger.balance(ref),
    };

    let doorCalls = 0;
    const auth = {
      assertSubAccountTransferDoor: async () => {
        doorCalls += 1;
        // Production code for a missing id — never invents primary (§ SPEC-SUBACCOUNTS).
        throw new AuthError('from and to sub-account ids are required', 'auth.sub_account_required');
      },
    } as unknown as AuthService;

    const router = createIdentityRouter(auth, {} as RankService, {
      actionApprovals: stubActionApprovals(),
      registrationOpen: true,
      ledger: wrapped as MemoryLedger,
    });

    expect(Object.keys(router._def.procedures)).toContain('subAccounts.assertTransferDoor');

    const api = router.createCaller(await ctx(['identity:write'], { userId: OWNER }));
    const err = await api.subAccounts.assertTransferDoor({ fromSubAccountId: SUB_A, toSubAccountId: null }).catch((e: unknown) => e);

    expect(doorCalls).toBe(1);
    expect(codeOf(err)).toBe('BAD_REQUEST');
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('auth.sub_account_required');
    expect(posts).toBe(0);
    expect(await bal(ledger, houseFees('identity', ASSET))).toBe('100');
  });

  it('assertTransferDoor happy path returns ids without moving value', async () => {
    const ledger = await fundedLedger();
    let posts = 0;
    const wrapped: Pick<MemoryLedger, 'post' | 'balance'> = {
      post: async (req) => {
        posts += 1;
        return ledger.post(req);
      },
      balance: (ref) => ledger.balance(ref),
    };

    const auth = {
      assertSubAccountTransferDoor: async () => ({ fromId: SUB_A, toId: SUB_B }),
    } as unknown as AuthService;

    const router = createIdentityRouter(auth, {} as RankService, {
      actionApprovals: stubActionApprovals(),
      registrationOpen: true,
      ledger: wrapped as MemoryLedger,
    });
    const api = router.createCaller(await ctx(['identity:write'], { userId: OWNER }));

    await expect(api.subAccounts.assertTransferDoor({ fromSubAccountId: SUB_A, toSubAccountId: SUB_B })).resolves.toEqual({
      fromId: SUB_A,
      toId: SUB_B,
    });
    expect(posts).toBe(0);
    expect(await bal(ledger, userAvailable(BENE, ASSET))).toBe('0');
  });
});
