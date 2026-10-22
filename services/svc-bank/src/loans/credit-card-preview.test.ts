import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import {
  CREDIT_CARD_FEES,
  CREDIT_CARD_PREVIEW_ACTIONS,
  CREDIT_CARD_REPAYMENT_OPTIONS,
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

describe('credit card preview', () => {
  it('is labelled, blurred, covers every tab and serves TEST rows with no invented number', async () => {
    const view = await caller(['bank:read']).creditCard.preview();
    expect(view.label).toBe('Preview · sample data');
    expect(view.preview).toBe(true);
    expect(view.blurred).toBe(true);
    expect(view.tabs).toEqual([...CREDIT_CARD_TABS]);
    expect(new Set(view.rows.map((r) => r.tab))).toEqual(new Set(CREDIT_CARD_TABS));
    for (const row of view.rows) expect(row.test).toBe(true);
    const items = view.rows.map((r) => r.item);
    for (const o of CREDIT_CARD_REPAYMENT_OPTIONS) expect(items).toContain(o);
    for (const r of CREDIT_CARD_RESTRICTIONS) expect(items).toContain(`restricted:${r}`);
    for (const f of CREDIT_CARD_FEES) expect(items).toContain(`fee:${f}`);
    expect(items).toContain('dispute_entry');
    expect(JSON.stringify(view.rows)).not.toMatch(/\d/);
  });

  it.each(CREDIT_CARD_PREVIEW_ACTIONS)('refuses %s with the typed Preview refusal and stores nothing', async (action) => {
    const before = creditCardPreview();
    await expect(caller(['bank:read', 'bank:write']).creditCard.action({ action })).resolves.toEqual({
      kind: 'preview',
      engine: 'Credit card',
      action,
      changed: false,
    });
    expect(creditCardPreview()).toEqual(before);
  });

  it('refuses an action it does not know, and extra fields, at validation', async () => {
    const c = caller(['bank:read', 'bank:write']);
    await expect(c.creditCard.action({ action: 'issue' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.creditCard.action({ action: 'apply', limit: '5000' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('refuses a caller without the bank scopes', async () => {
    await expect(caller([]).creditCard.preview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(['bank:read']).creditCard.action({ action: 'apply' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps the fixture frozen so no caller can turn a TEST row into a live one', () => {
    const view = creditCardPreview();
    expect(Object.isFrozen(view.rows)).toBe(true);
    expect(() => {
      (view.rows[0] as { test: boolean }).test = false;
    }).toThrow();
    expect(refuseCreditCardAction('apply').changed).toBe(false);
  });
});
