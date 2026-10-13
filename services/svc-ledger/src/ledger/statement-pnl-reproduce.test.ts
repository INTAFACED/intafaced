import { describe, expect, it } from 'vitest';
import { STATEMENT_LOTS_MISSING, STATEMENT_NAV_INPUTS_MISSING } from './statement-pnl.js';
import { factsWhenLotsExist, handleStatementPnlHappyOrRefuse, reproduceStatementPnl } from './statement-pnl-reproduce.js';

const OWNER = {
  ownerType: 'user' as const,
  ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  reportingAssetId: 'USDT',
};

const LOTS = {
  closed: [{ assetId: 'BTC', costBasis: '20000', proceeds: '25000' }],
  open: [{ assetId: 'ETH', qtyRemaining: '2', costBasis: '4000' }],
};

const MARKS = { ETH: '2500' };
const NAV = { cashReporting: '100' };

describe('CARD G-statements-happy reproduce when lots exist', () => {
  it('reproduces the same realized/unrealized/NAV from the same lots', () => {
    const facts = factsWhenLotsExist({ lots: LOTS, marks: MARKS, navInputs: NAV });
    expect(facts?.lots.status).toBe('present');
    const first = reproduceStatementPnl(OWNER, facts!);
    const second = reproduceStatementPnl(OWNER, facts!);
    expect(first.status).toBe('ok');
    expect(second).toEqual(first);
    if (first.status !== 'ok') return;
    expect(first.realized).toBe('5000');
    expect(first.unrealized).toBe('1000');
    expect(first.nav).toBe('5100');
    expect(typeof first.realized).toBe('string');
  });

  it('keeps the B5 refuse when lots do not exist', async () => {
    const out = await handleStatementPnlHappyOrRefuse({ balances: async () => [] }, OWNER);
    expect(out.status).toBe('refused');
    expect(out.codes).toContain(STATEMENT_LOTS_MISSING);
    expect(out.realized).toBeNull();
    expect(out.nav).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/"0"/);
  });

  it('refuses invented FIFO rather than treating history as lots', async () => {
    const out = await handleStatementPnlHappyOrRefuse(
      { balances: async () => [] },
      { ...OWNER, inventFifoFromHistory: true, lots: LOTS, marks: MARKS, navInputs: NAV },
    );
    expect(out.status).toBe('refused');
    expect(out.realized).toBeNull();
  });

  it('refuses present lots without NAV rather than inventing cash', async () => {
    const out = await handleStatementPnlHappyOrRefuse({ balances: async () => [] }, { ...OWNER, lots: LOTS, marks: MARKS });
    expect(out.status).toBe('refused');
    expect(out.codes).toContain(STATEMENT_NAV_INPUTS_MISSING);
    expect(out.nav).toBeNull();
  });

  it('refuses a JS number on lot money', async () => {
    await expect(
      handleStatementPnlHappyOrRefuse(
        { balances: async () => [] },
        {
          ...OWNER,
          lots: { closed: [{ assetId: 'BTC', costBasis: 20000, proceeds: '25000' }], open: [] },
          navInputs: NAV,
        },
      ),
    ).rejects.toThrow(/JS number refused/);
  });

  it('serves the happy path through the S2S handle', async () => {
    let asked = false;
    const out = await handleStatementPnlHappyOrRefuse(
      {
        balances: async () => {
          asked = true;
          return [];
        },
      },
      { ...OWNER, lots: LOTS, marks: MARKS, navInputs: NAV },
    );
    expect(asked).toBe(false);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.realized).toBe('5000');
    expect(out.unrealized).toBe('1000');
    expect(out.nav).toBe('5100');
  });
});
