import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { BankServices } from './bank-service.js';
import { CardService } from './cards/card-service.js';
import { cardSim, noCardIssuer } from './cards/issuer.js';
import { LoanService } from './loans/loan-service.js';
import { fixedPriceSource } from './loans/prices.js';
import { RampService } from './ramps/ramp-service.js';
import { CRYPTO_LEDGER_PROGRAMME } from './ramps/rails.js';
import { SpaceService } from './spaces/space-service.js';
import { BillsPotService } from './spaces/bills-pot.js';
import { createBankRouter } from './router.js';

/**
 * Public bank actions for ticket 18. Callers use the router.
 * A refusal names the missing piece, leaves the slot empty, and posts nothing.
 */

const USER = '11111111-1111-4111-8111-111111111111';

function context(): Context {
  return {
    principal: {
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal,
    service: null,
    region: 'DE',
    requestId: 'req-bank-honesty',
  };
}

function untouchedSql(): Sql {
  const tag = () => {
    throw new Error('bank honesty must not touch sql');
  };
  return tag as unknown as Sql;
}

describe('card rewards', () => {
  it('refuses until a card issuer is connected and posts no rewards balance', async () => {
    const ledger = new MemoryLedger();
    const cards = new CardService(untouchedSql(), ledger, { issuer: cardSim() });
    const caller = createBankRouter({ cards } as BankServices).createCaller(context());

    await expect(caller.cards.rewards()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: {
        code: 'bank.rewards_issuer_unset',
        message: expect.stringMatching(/outside company/i),
      },
    });

    let message = '';
    try {
      await caller.cards.rewards();
    } catch (err) {
      message = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ''}` : String(err);
    }
    expect(message).toMatch(/cashback/i);
    expect(message).not.toMatch(/visa|mastercard|amex|stripe|marqeta/i);
    expect(message).not.toMatch(/\d/);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('keeps the card programme marked simulated and does not name an issuer', async () => {
    const ledger = new MemoryLedger();
    const caller = createBankRouter({
      cards: new CardService(untouchedSql(), ledger, { issuer: cardSim() }),
    } as BankServices).createCaller(context());
    const none = createBankRouter({
      cards: new CardService(untouchedSql(), ledger),
    } as BankServices).createCaller(context());

    const simulated = await caller.cards.programme();
    const unconfigured = await none.cards.programme();

    expect(simulated.simulated).toBe(true);
    expect(unconfigured.simulated).toBe(true);
    expect(unconfigured).toEqual(noCardIssuer.programme);
    expect(`${simulated.displayName} ${unconfigured.displayName}`).not.toMatch(/visa|mastercard|amex|stripe|marqeta/i);
    expect(ledger.journal()).toHaveLength(0);
  });
});

describe('cash ramp', () => {
  it('stays marked simulated and a live ramp refuses without posting', async () => {
    const ledger = new MemoryLedger();
    const ramps = new RampService(untouchedSql(), ledger, { programme: CRYPTO_LEDGER_PROGRAMME });
    const caller = createBankRouter({ ramps } as BankServices).createCaller(context());

    const programme = await caller.ramps.programme();
    expect(programme.simulated).toBe(true);

    await expect(caller.ramps.live({ amount: '25' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: {
        code: 'bank.live_ramp_unset',
        message: expect.stringMatching(/outside company/i),
      },
    });

    let message = '';
    try {
      await caller.ramps.live({ amount: '25' });
    } catch (err) {
      message = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ''}` : String(err);
    }
    expect(message).toMatch(/cash rail/i);
    expect(message).not.toMatch(/visa|mastercard|stripe|plaid|adyen|checkout\.com|wise/i);
    expect(ledger.journal()).toHaveLength(0);
  });
});

describe('direct deposit', () => {
  it('refuses until a paycheck rail exists and posts nothing', async () => {
    const ledger = new MemoryLedger();
    const spaces = new SpaceService(untouchedSql(), ledger);
    const caller = createBankRouter({ spaces } as BankServices).createCaller(context());

    await expect(caller.directDeposit({ amount: '1000.00' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: {
        code: 'bank.no_paycheck_rail',
        message: expect.stringMatching(/outside company/i),
      },
    });

    let message = '';
    try {
      await caller.directDeposit({ amount: '1000.00' });
    } catch (err) {
      message = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ''}` : String(err);
    }
    expect(message).toMatch(/paycheck rail/i);
    expect(message).not.toMatch(/ach|plaid|adyen|stripe|wise|swift|payroll/i);
    expect(ledger.journal()).toHaveLength(0);
  });
});

describe('loan health', () => {
  it('stays empty while the price is blank and posts nothing', async () => {
    const ledger = new MemoryLedger();
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('FROM bank.loans') && text.includes('status IN')) {
        return Promise.resolve([
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            product_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            user_id: USER,
            debt_asset_id: 'BTC',
            collateral_asset_id: 'ETH',
            quote_asset_id: 'USD',
            apr_bps: 0,
            principal: '2',
            opening_collateral: '3',
            status: 'active',
            draw_ledger_tx_id: null,
            opened_at: new Date('2026-01-01T00:00:00.000Z'),
            margin_called_at: null,
            last_mark_price: null,
            closed_at: null,
          },
        ]);
      }
      throw new Error(`loan health touched more than the open book: ${text}`);
    }) as unknown as Sql;
    const loans = new LoanService(sql, ledger, { priceSource: fixedPriceSource({}) });
    const caller = createBankRouter({ loans } as BankServices).createCaller(context());

    await expect(caller.loans.health()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: {
        code: 'bank.loan_health_price_unset',
        message: expect.stringMatching(/price/i),
      },
    });

    let message = '';
    try {
      await caller.loans.health();
    } catch (err) {
      message = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ''}` : String(err);
    }
    expect(message).toMatch(/missing piece is price/i);
    expect(message).toMatch(/bank\.loan_health_price_unset/);
    expect(message).not.toMatch(/\d/);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('does not invent a price for an empty loan book', async () => {
    const ledger = new MemoryLedger();
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    const loans = new LoanService(sql, ledger, {
      priceSource: {
        marks: async () => {
          throw new Error('price was consulted');
        },
      },
    });
    const caller = createBankRouter({ loans } as BankServices).createCaller(context());

    const health = await caller.loans.health();

    expect(health.loans).toEqual([]);
    expect(health).not.toHaveProperty('price');
    expect(ledger.journal()).toHaveLength(0);
  });
});

describe('bank list', () => {
  it('refuses a spaces list that omits the limit', async () => {
    const ledger = new MemoryLedger();
    let sqlCalled = false;
    const sql = (() => {
      sqlCalled = true;
      return Promise.resolve([]);
    }) as unknown as Sql;
    const spaces = new SpaceService(sql, ledger);
    const billsPots = new BillsPotService(sql, spaces);
    const caller = createBankRouter({ spaces, billsPots } as BankServices).createCaller(context());

    await expect(caller.spaces.list({})).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: {
        code: 'bank.spaces_list_limit_unset',
        message: expect.stringMatching(/limit|page size/i),
      },
    });
    expect(sqlCalled).toBe(false);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('returns the spaces list when the caller sends a limit and keeps no balance of its own', async () => {
    const ledger = new MemoryLedger();
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    const spaces = new SpaceService(sql, ledger);
    const billsPots = new BillsPotService(sql, spaces);
    const caller = createBankRouter({ spaces, billsPots } as BankServices).createCaller(context());

    await expect(caller.directDeposit({ amount: '1000.00' })).rejects.toMatchObject({
      cause: { code: 'bank.no_paycheck_rail' },
    });
    await expect(caller.spaces.list({ limit: 1 })).resolves.toEqual([]);
    expect(ledger.journal()).toHaveLength(0);
  });
});
