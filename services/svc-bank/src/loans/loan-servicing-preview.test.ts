import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import {
  PREVIEW_LABEL,
  PREVIEW_REFUSAL_CODE,
  isPreviewRefusal,
  previewRefusal,
  previewRefusalOf,
  router,
  type Context,
} from '@intafaced/contracts';
import { loanServicingPreviewProcedures } from './loan-servicing-preview.js';
import { createBankRouter } from '../router.js';

type BankServices = Parameters<typeof createBankRouter>[0];

const authConfig = {
  secret: 'a-bank-loan-servicing-preview-test-secret-xx',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const USER = '11111111-1111-4111-8111-111111111111';
const LOAN = '22222222-2222-4222-8222-222222222222';

async function ctx(scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: USER, sessionId: '33333333-3333-4333-8333-333333333333', scopes, tier: 'full', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-loan-preview' };
}

/** A BankServices whose every touch throws: proves the preview doors read and write nothing. */
const untouchable = new Proxy({} as BankServices, {
  get() {
    throw new Error('the preview door touched bank services');
  },
});

async function caller(scopes = ['bank:read', 'bank:write'], policy: Parameters<typeof loanServicingPreviewProcedures>[0] = null) {
  return router(loanServicingPreviewProcedures(policy)).createCaller(await ctx(scopes));
}

async function refusalOf(p: Promise<unknown>) {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { code: string; message: string; cause?: unknown } | null;
  expect(err).not.toBeNull();
  return err!;
}

describe('loan servicing previews (BK-loan-09)', () => {
  it('changing the repayment date returns the typed Preview refusal for the schedule engine', async () => {
    const err = await refusalOf((await caller()).changeRepaymentDate({ loanId: LOAN, date: '2026-11-01' }));
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toBe(`${PREVIEW_REFUSAL_CODE} — bank.loan_schedule:change_repayment_date`);
    expect(isPreviewRefusal(previewRefusalOf(err.cause))).toBe(true);
    expect(previewRefusalOf(err.cause)).toMatchObject({
      kind: 'preview',
      engine: 'bank.loan_schedule',
      action: 'change_repayment_date',
      label: PREVIEW_LABEL,
    });
  });

  it('paying extra returns the Preview refusal', async () => {
    const err = await refusalOf((await caller()).payExtra({ loanId: LOAN, amount: '10.5' }));
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(previewRefusalOf(err.cause)).toMatchObject({ engine: 'bank.loan_schedule', action: 'pay_extra' });
  });

  it('repaying from an external bank returns the Preview refusal, not an allowlist code', async () => {
    const err = await refusalOf((await caller()).repayFromExternalBank({ loanId: LOAN }));
    expect(err.message).toContain(PREVIEW_REFUSAL_CODE);
    expect(err.message).not.toContain('rail.bank');
    expect(previewRefusalOf(err.cause)).toMatchObject({ engine: 'bank.loan_external_repay', action: 'repay_from_external_bank' });
  });

  it('refuses a caller without bank:write, and bad input, before the preview', async () => {
    await expect((await caller(['bank:read'])).payExtra({ loanId: LOAN, amount: '1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect((await caller()).payExtra({ loanId: LOAN, amount: '1e3' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect((await caller()).changeRepaymentDate({ loanId: 'x', date: '2026-11-01' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('missed-payment policy reads not_set when blank, and the owner values when published (TEST)', async () => {
    expect(await (await caller()).missedPaymentPolicy()).toEqual({ status: 'not_set' });
    const set = await caller(['bank:read'], { graceDays: 7, catchUpDays: 7, lateFee: '0' });
    expect(await set.missedPaymentPolicy()).toEqual({ status: 'set', graceDays: 7, catchUpDays: 7, lateFee: '0' });
  });

  it('is mounted under loans and touches no bank service', async () => {
    const bankRouter = createBankRouter(untouchable);
    const c = bankRouter.createCaller(await ctx(['bank:read', 'bank:write'])) as unknown as {
      loans: { repayFromExternalBank(i: { loanId: string }): Promise<unknown>; missedPaymentPolicy(): Promise<unknown> };
    };
    const err = await refusalOf(c.loans.repayFromExternalBank({ loanId: LOAN }));
    expect(err.message).toContain(PREVIEW_REFUSAL_CODE);
    expect(await c.loans.missedPaymentPolicy()).toEqual({ status: 'not_set' });
  });
  it('refuses an anonymous caller UNAUTHORIZED before the preview', async () => {
    const anon = router(loanServicingPreviewProcedures(null)).createCaller({
      principal: null,
      service: null,
      region: 'DE',
      requestId: 'req-anon',
    } as Context);
    for (const p of [
      anon.changeRepaymentDate({ loanId: LOAN, date: '2026-11-01' }),
      anon.payExtra({ loanId: LOAN, amount: '1' }),
      anon.repayFromExternalBank({ loanId: LOAN }),
      anon.missedPaymentPolicy(),
    ]) {
      const err = await refusalOf(p);
      expect(err.code).toBe('UNAUTHORIZED');
      expect(previewRefusalOf(err.cause)).toBeUndefined();
    }
  });

  it('refuses missing bank:write FORBIDDEN on changeRepaymentDate and repayFromExternalBank before the preview', async () => {
    const c = await caller(['bank:read']);
    for (const p of [c.changeRepaymentDate({ loanId: LOAN, date: '2026-11-01' }), c.repayFromExternalBank({ loanId: LOAN })]) {
      const err = await refusalOf(p);
      expect(err.code).toBe('FORBIDDEN');
      expect(previewRefusalOf(err.cause)).toBeUndefined();
    }
  });

  it('refuses missing bank:read FORBIDDEN on missedPaymentPolicy', async () => {
    const err = await refusalOf((await caller(['bank:write'])).missedPaymentPolicy());
    expect(err.code).toBe('FORBIDDEN');
  });

  it('runs all four procedures against the throwing services proxy', async () => {
    const c = createBankRouter(untouchable).createCaller(await ctx(['bank:read', 'bank:write'])) as unknown as {
      loans: {
        originationFeeBps: '0';
        changeRepaymentDate(i: { loanId: string; date: string }): Promise<unknown>;
        payExtra(i: { loanId: string; amount: string }): Promise<unknown>;
        repayFromExternalBank(i: { loanId: string }): Promise<unknown>;
        missedPaymentPolicy(): Promise<unknown>;
      };
    };
    for (const p of [
      c.loans.changeRepaymentDate({ loanId: LOAN, date: '2026-11-01' }),
      c.loans.payExtra({ loanId: LOAN, amount: '1' }),
      c.loans.repayFromExternalBank({ loanId: LOAN }),
    ]) {
      const err = await refusalOf(p);
      expect(err.code).toBe('PRECONDITION_FAILED');
      expect(isPreviewRefusal(previewRefusalOf(err.cause))).toBe(true);
    }
    expect(await c.loans.missedPaymentPolicy()).toEqual({ status: 'not_set' });
  });

  it('surfaces the refusal on error.data.preview through createBankRouter over the fetch adapter', async () => {
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      req: new Request('http://localhost/trpc/loans.payExtra', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loanId: LOAN, amount: '10.5' }),
      }),
      router: createBankRouter(untouchable),
      createContext: () => ctx(['bank:read', 'bank:write']),
    });
    expect(res.status).toBe(412);
    const data = ((await res.json()) as { error: { data: Record<string, unknown> } }).error.data;
    expect(data.preview).toEqual(previewRefusal('bank.loan_schedule', 'pay_extra'));
    expect(data.cause).toEqual({ code: PREVIEW_REFUSAL_CODE });
  });
});
