import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from './router.js';
import type { BankServices } from './bank-service.js';

const SECRET = 'a-bank-ops-job-hmac-route-test-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

const JOBS = [
  'runDueTransfers',
  'runAutoInvest',
  'accrueInterest',
  'accrueLoanInterest',
  'runRiskSweep',
  'resumePendingLoans',
  'resumePendingEarn',
] as const;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:treasury'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

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

function jobCaller(p: Principal = principal()) {
  return { ...signed(p), service: 'svc-bank' as const };
}

function stubBank(): BankServices {
  return {
    transfers: {
      runDueTransfers: async () => ({
        schedulesConsidered: 0,
        settled: 0,
        rejected: 0,
        alreadyFired: 0,
        strandedSwept: 0,
        failures: [],
      }),
    },
    autoInvest: {
      runDue: async () => ({ considered: 0, settled: 0, skipped: 0, rejected: 0, failures: [] }),
    },
    earn: {
      accrueAll: async () => ({ results: [], failures: [] }),
      resumePending: async () => [],
    },
    loans: {
      originationFeeBps: '0',
      accrueAll: async () => ({ results: [], failures: [] }),
      runRiskSweep: async () => ({ marked: 0, called: 0, liquidated: 0, cleared: 0, refused: [] }),
      resumePending: async () => [],
    },
  } as unknown as BankServices;
}

async function callJob(caller: ReturnType<typeof signed>, job: (typeof JOBS)[number]) {
  const ops = createBankRouter(stubBank()).createCaller(caller).ops;
  return ops[job]({});
}

describe('ops job tRPC HMAC as svc-bank', () => {
  it.each(JOBS)('%s session admin:treasury (no HMAC) is UNAUTHORIZED', async (job) => {
    await expect(callJob(signed(), job)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each(JOBS)('%s HMAC as svc-trade is FORBIDDEN', async (job) => {
    await expect(callJob({ ...signed(), service: 'svc-trade' }, job)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(JOBS)('%s HMAC as svc-bank reaches the job', async (job) => {
    await expect(callJob(jobCaller(), job)).resolves.toBeDefined();
  });
});
