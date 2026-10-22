import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { PREVIEW_LABEL, PREVIEW_REFUSAL_CODE, isPreviewRefusal, router, type Context } from '@intafaced/contracts';
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
  )) as { code: string; message: string; cause?: { refusal?: unknown; message?: string } } | null;
  expect(err).not.toBeNull();
  return err!;
}

describe('loan servicing previews (BK-loan-09)', () => {
  it('changing the repayment date returns the typed Preview refusal for the schedule engine', async () => {
    const err = await refusalOf((await caller()).changeRepaymentDate({ loanId: LOAN, date: '2026-11-01' }));
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toBe(`${PREVIEW_REFUSAL_CODE} — bank.loan_schedule:change_repayment_date`);
    expect(isPreviewRefusal(err.cause?.refusal)).toBe(true);
    expect(err.cause?.refusal).toMatchObject({
      kind: 'preview',
      engine: 'bank.loan_schedule',
      action: 'change_repayment_date',
      label: PREVIEW_LABEL,
    });
  });

  it('paying extra returns the Preview refusal', async () => {
    const err = await refusalOf((await caller()).payExtra({ loanId: LOAN, amount: '10.5' }));
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.cause?.refusal).toMatchObject({ engine: 'bank.loan_schedule', action: 'pay_extra' });
  });

  it('repaying from an external bank returns the Preview refusal, not an allowlist code', async () => {
    const err = await refusalOf((await caller()).repayFromExternalBank({ loanId: LOAN }));
    expect(err.message).toContain(PREVIEW_REFUSAL_CODE);
    expect(err.message).not.toContain('rail.bank');
    expect(err.cause?.refusal).toMatchObject({ engine: 'bank.loan_external_repay', action: 'repay_from_external_bank' });
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
});
