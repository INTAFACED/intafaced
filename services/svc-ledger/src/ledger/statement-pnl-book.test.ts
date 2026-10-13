import { describe, expect, it } from 'vitest';
import { parseAmount, userAvailable, type Balance } from '@intafaced/ledger-client';
import { STATEMENT_LOTS_MISSING, STATEMENT_MARK_MISSING, STATEMENT_NAV_INPUTS_MISSING } from './statement-pnl.js';
import { handleStatementPnlFromBook, refuseInventedCostBasis, statementPnlAgainstPostedBalances } from './statement-pnl-book.js';

const OWNER = {
  ownerType: 'user' as const,
  ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  reportingAssetId: 'USDT',
};

function cash(amount: string): Balance {
  return {
    account: userAvailable(OWNER.ownerId, 'USDT'),
    accountId: 'acct-cash',
    amount: parseAmount(amount),
  };
}

describe('CARD B5 statement PnL against the posted book', () => {
  it('reads balances and still refuses missing lots/marks/NAV — never 0', async () => {
    let asked = false;
    const out = await handleStatementPnlFromBook(
      {
        balances: async () => {
          asked = true;
          return [cash('99.5')];
        },
      },
      OWNER,
    );
    expect(asked).toBe(true);
    expect(out.status).toBe('refused');
    expect(out.codes).toEqual([STATEMENT_LOTS_MISSING, STATEMENT_MARK_MISSING, STATEMENT_NAV_INPUTS_MISSING]);
    expect(out.realized).toBeNull();
    expect(out.unrealized).toBeNull();
    expect(out.nav).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/"0"/);
    expect(JSON.stringify(out)).not.toMatch(/99\.5/);
  });

  it('refuses invented FIFO / caller cost basis rather than treating history as lots', () => {
    expect(refuseInventedCostBasis(OWNER, { inventFifoFromHistory: true })?.status).toBe('refused');
    expect(refuseInventedCostBasis(OWNER, { lotsFromHistory: true })?.status).toBe('refused');
    expect(refuseInventedCostBasis(OWNER, { costBasis: '12.00' })?.nav).toBeNull();
    expect(refuseInventedCostBasis(OWNER, {})).toBeNull();
  });

  it('refuses an invent-FIFO S2S body and never asks the book to mint lots', async () => {
    let asked = false;
    const out = await handleStatementPnlFromBook(
      {
        balances: async () => {
          asked = true;
          return [cash('10')];
        },
      },
      { ...OWNER, inventFifoFromHistory: true },
    );
    expect(asked).toBe(false);
    expect(out.status).toBe('refused');
    expect(out.realized).toBeNull();
    expect(out.nav).toBeNull();
  });

  it('posted cash is not NAV on the compose hitch', () => {
    const out = statementPnlAgainstPostedBalances(OWNER, [cash('250')]);
    expect(out.status).toBe('refused');
    expect(out.nav).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/250/);
  });
});
