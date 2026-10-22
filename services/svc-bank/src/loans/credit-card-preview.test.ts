import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { PREVIEW_LABEL, previewRefusalSchema, type Context } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import {
  CREDIT_CARD_FEES,
  CREDIT_CARD_REPAYMENT_OPTIONS,
  CREDIT_CARD_REPAYMENT_VARIANTS,
  CREDIT_CARD_RESTRICTIONS,
  CREDIT_CARD_TABS,
  creditCardPreview,
  refuseCreditCardAction,
} from './credit-card-preview.js';

/** BK-loan-10: a labelled credit card preview that stores nothing and refuses every engine action. */

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
    requestId: 'req-credit-card-preview',
  };
}

/** Every service throws on touch: the preview must not read or write any store, the ledger or the dispute door. */
const untouched = new Proxy(
  {},
  {
    get(_t, name) {
      throw new Error(`credit card preview touched bank.${String(name)}`);
    },
  },
) as BankServices;

const caller = (scopes: string[]) => createBankRouter(untouched).createCaller(context(scopes));
const writer = () => caller(['bank:read', 'bank:write']).creditCard;

async function expectRefused(call: Promise<unknown>, action: string) {
  const err = (await call.catch((e: unknown) => e)) as { code?: string; message?: string; cause?: unknown };
  expect(err).toMatchObject({ code: 'PRECONDITION_FAILED', message: `preview.engine_not_built — bank.credit_card:${action}` });
  const cause = previewRefusalSchema.parse(err.cause);
  expect(cause).toEqual({
    kind: 'preview',
    code: 'preview.engine_not_built',
    engine: 'bank.credit_card',
    action,
    label: PREVIEW_LABEL,
  });
}

describe('credit card preview', () => {
  it('is labelled, blurred, covers every tab and serves TEST rows with no invented number', async () => {
    const view = await caller(['bank:read']).creditCard.preview();
    expect(view.label).toBe(PREVIEW_LABEL);
    expect(view.preview).toBe(true);
    expect(view.blurred).toBe(true);
    expect(view.tabs).toEqual([...CREDIT_CARD_TABS]);
    expect(new Set(view.rows.map((r) => r.tab))).toEqual(new Set(CREDIT_CARD_TABS));
    for (const row of view.rows) expect(row.test).toBe(true);
    const items = view.rows.map((r) => r.item);
    for (const o of CREDIT_CARD_REPAYMENT_OPTIONS) expect(items).toContain(o);
    for (const v of CREDIT_CARD_REPAYMENT_VARIANTS) expect(items).toContain(`variant:${v}`);
    for (const r of CREDIT_CARD_RESTRICTIONS) expect(items).toContain(`restricted:${r}`);
    for (const f of CREDIT_CARD_FEES) expect(items).toContain(`fee:${f}`);
    expect(items).toContain('dispute_entry');
    expect(JSON.stringify(view.rows)).not.toMatch(/\d/);
  });

  it('answers the statements read with the typed Preview refusal, never an empty list', async () => {
    const answer = await caller(['bank:read']).creditCard.statements();
    expect(previewRefusalSchema.parse(answer)).toMatchObject({ action: 'read_statements', engine: 'bank.credit_card' });
  });

  it('refuses apply, limit, rules and dispute with PRECONDITION_FAILED and the refusal as cause', async () => {
    const before = creditCardPreview();
    await expectRefused(writer().application({ variant: 'credit_card' }), 'apply');
    await expectRefused(writer().application({ variant: 'charge_card' }), 'apply');
    await expectRefused(writer().limit({ change: 'request' }), 'change_limit');
    for (const restriction of CREDIT_CARD_RESTRICTIONS) await expectRefused(writer().rules({ restriction }), 'set_usage_rule');
    await expectRefused(writer().dispute({ statementLine: 'TEST-LINE-A' }), 'open_dispute');
    expect(creditCardPreview()).toEqual(before);
  });

  it.each([
    ['pay_in_full', 'repay_in_full'],
    ['pay_early', 'repay_early'],
    ['pay_extra', 'repay_extra'],
    ['choose_date', 'set_payment_date'],
  ] as const)('refuses repay %s as %s', async (option, action) => {
    await expectRefused(writer().repay({ option }), action);
  });

  it('refuses unknown values and extra fields at validation', async () => {
    const c = writer();
    await expect(c.application({ variant: 'debit' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.application({ variant: 'credit_card', limit: '5000' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.repay({ option: 'pay_later' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.rules({ restriction: 'travel' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.dispute({ statementLine: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a caller without the bank scopes', async () => {
    await expect(caller([]).creditCard.preview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller([]).creditCard.statements()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const readOnly = caller(['bank:read']).creditCard;
    await expect(readOnly.application({ variant: 'credit_card' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(readOnly.limit({ change: 'request' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(readOnly.repay({ option: 'pay_in_full' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(readOnly.rules({ restriction: 'gambling' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(readOnly.dispute({ statementLine: 'TEST-LINE-A' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps the fixture frozen so no caller can turn a TEST row into a live one', () => {
    const view = creditCardPreview();
    expect(Object.isFrozen(view.rows)).toBe(true);
    expect(() => {
      (view.rows[0] as { test: boolean }).test = false;
    }).toThrow();
    expect(previewRefusalSchema.parse(refuseCreditCardAction('apply')).kind).toBe('preview');
  });
});
