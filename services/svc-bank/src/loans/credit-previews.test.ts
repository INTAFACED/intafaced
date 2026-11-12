import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { PREVIEW_LABEL, previewRefusalSchema, type Context } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { CREDIT_PREVIEW_ACTIONS, CREDIT_PREVIEW_ENGINES, REVOLVING_SECTIONS, SAMPLE_UNSECURED_LOAN_ID } from './credit-previews.js';

/** J-bank-12 (BK-loan-08, BK-loan-09 sample schedule, BK-cops-09 revolving credit): TEST reads and refusals only. */

const USER = '11111111-1111-4111-8111-111111111111';

function context(scopes: string[]): Context {
  return {
    principal: {
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal,
    service: null,
    region: 'DE',
    requestId: 'req-credit-previews',
  };
}

/** Every service throws on touch: no preview may read or write a store or the ledger. */
const untouched = new Proxy(
  {},
  {
    get(_t, name) {
      throw new Error(`credit preview touched bank.${String(name)}`);
    },
  },
) as BankServices;

const caller = (scopes: string[]) => createBankRouter(untouched).createCaller(context(scopes));

/** Every value in a fixture that is a figure carries `test: true` on its own row or on its product. */
function everyRowTest(rows: readonly { test: true }[]) {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.test).toBe(true);
}

describe('credit previews', () => {
  it('serves the overdraft, personal loan, business term loan and bureau as labelled, blurred TEST rows', async () => {
    const view = await caller(['bank:read']).creditPreviews.overview();
    expect(view).toMatchObject({ label: PREVIEW_LABEL, preview: true, blurred: true });
    expect(view.overdraft.test).toBe(true);
    expect(view.personalLoan.test).toBe(true);
    expect(view.businessTermLoan.test).toBe(true);
    everyRowTest(view.overdraft.monthlyCost);
    everyRowTest(view.personalLoan.terms);
    everyRowTest(view.businessTermLoan.terms);
    everyRowTest(view.bureau.rows);
    expect(view.personalLoan.terms.map((t) => t.termMonths)).toEqual([12, 24, 36, 48, 60]);
  });

  it('works its sample figures out from its sample amount and rate (no figure is free-standing)', async () => {
    const view = await caller(['bank:read']).creditPreviews.overview();
    const cents = (s: string) => BigInt(s.replace('.', ''));
    // Overdraft: limit × rate ÷ 12 months, half-up to cents (rate in hundredths of a percent).
    const rate = cents(view.overdraft.rate);
    for (const row of view.overdraft.monthlyCost) expect(cents(row.cost)).toBe((cents(row.limit) * rate * 2n + 120000n) / 240000n);
    // Personal loan: the total interest is the payments less the amount.
    for (const t of view.personalLoan.terms)
      expect(cents(t.totalInterest)).toBe(cents(t.monthly) * BigInt(t.termMonths) - cents(view.personalLoan.amount));
    // Business: weekly × weeks = amount + flat fee.
    for (const t of view.businessTermLoan.terms) {
      expect(cents(t.fee)).toBe((cents(view.businessTermLoan.amount) * cents(view.businessTermLoan.flatFee)) / 10000n);
      expect(cents(t.weekly) * BigInt(t.weeks)).toBe(cents(view.businessTermLoan.amount) + cents(t.fee));
    }
  });

  it('serves a sample unsecured schedule keyed by a TEST loan id that the servicing doors refuse without a lookup', async () => {
    const schedule = await caller(['bank:read']).creditPreviews.schedule();
    expect(schedule.sampleLoanId).toBe(SAMPLE_UNSECURED_LOAN_ID);
    expect(schedule.rows).toHaveLength(schedule.termMonths);
    everyRowTest(schedule.rows);
    const err = (await caller(['bank:read', 'bank:write'])
      .loans.changeRepaymentDate({ loanId: schedule.sampleLoanId, date: '2026-12-15' })
      .catch((e: unknown) => e)) as { code?: string; message?: string };
    expect(err).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'preview.engine_not_built — bank.loan_schedule:change_repayment_date',
    });
    expect(await caller(['bank:read']).loans.missedPaymentPolicy()).toEqual({ status: 'not_set' });
  });

  it('serves revolving credit over every section as TEST rows', async () => {
    const view = await caller(['bank:read']).creditPreviews.revolving();
    expect(view).toMatchObject({ label: PREVIEW_LABEL, preview: true, blurred: true, engine: 'bank.revolving_credit' });
    everyRowTest(view.rows);
    expect(new Set(view.rows.map((r) => r.section))).toEqual(new Set(REVOLVING_SECTIONS));
  });

  it('refuses every engine action with the typed Preview refusal naming its engine', async () => {
    const write = caller(['bank:read', 'bank:write']).creditPreviews;
    for (const [product, actions] of Object.entries(CREDIT_PREVIEW_ACTIONS)) {
      for (const action of actions) {
        const err = (await write.act({ product, action } as never).catch((e: unknown) => e)) as {
          code?: string;
          message?: string;
          cause?: unknown;
        };
        const engine = CREDIT_PREVIEW_ENGINES[product as keyof typeof CREDIT_PREVIEW_ENGINES];
        expect(err).toMatchObject({ code: 'PRECONDITION_FAILED', message: `preview.engine_not_built — ${engine}:${action}` });
        expect(previewRefusalSchema.parse(err.cause)).toEqual({
          kind: 'preview',
          code: 'preview.engine_not_built',
          engine,
          action,
          label: PREVIEW_LABEL,
        });
      }
    }
  });

  it('refuses an action a product does not offer, and a session without bank:write', async () => {
    const write = caller(['bank:read', 'bank:write']).creditPreviews;
    await expect(write.act({ product: 'credit_bureau', action: 'apply' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller(['bank:read']).creditPreviews.act({ product: 'overdraft', action: 'apply' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
