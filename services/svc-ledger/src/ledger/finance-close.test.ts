import { describe, expect, it } from 'vitest';
import {
  CLIENT_CORPORATE_COMMINGLED,
  OWNERS_UNNAMED,
  POR_MISLEADING,
  RECIPES_INCOMPLETE,
  RESERVE_INVENTED,
  handleFinanceClose,
} from './finance-close.js';
import { handleS2sFinanceClose } from '../s2s-http.js';
import type { LedgerService } from '../service.js';

const DISTINCT = {
  clientOwnerId: 'client-1',
  corporateOwnerId: 'corp-1',
  periodId: '2026-Q3',
  recipes: ['clientBalances', 'corporateBalances'],
};

const stub = {} as LedgerService;

describe('CARD G-finance client vs corporate, close, PoR', () => {
  it('refuses a commingled client/corporate pot', () => {
    const same = handleFinanceClose({
      kind: 'segregation',
      clientOwnerId: 'same',
      corporateOwnerId: 'same',
    });
    const flag = handleFinanceClose({
      kind: 'segregation',
      clientOwnerId: 'client-1',
      corporateOwnerId: 'corp-1',
      commingle: true,
    });
    expect(same.ok).toBe(false);
    expect(flag.ok).toBe(false);
    if (same.ok || flag.ok) return;
    expect(same.reason).toBe(CLIENT_CORPORATE_COMMINGLED);
    expect(flag.reason).toBe(CLIENT_CORPORATE_COMMINGLED);
  });

  it('refuses a segregation that omits an owner because the owner was not named', () => {
    const cases: ReadonlyArray<{ readonly body: Record<string, unknown>; readonly missing: readonly string[] }> = [
      { body: { kind: 'segregation' }, missing: ['clientOwnerId', 'corporateOwnerId'] },
      { body: { kind: 'segregation', corporateOwnerId: 'corp-1' }, missing: ['clientOwnerId'] },
      { body: { kind: 'segregation', clientOwnerId: 'client-1' }, missing: ['corporateOwnerId'] },
      { body: { kind: 'segregation', clientOwnerId: '', corporateOwnerId: 'corp-1' }, missing: ['clientOwnerId'] },
      { body: { kind: 'segregation', clientOwnerId: '   ', corporateOwnerId: 'corp-1' }, missing: ['clientOwnerId'] },
      { body: { kind: 'segregation', clientOwnerId: 'client-1', corporateOwnerId: '' }, missing: ['corporateOwnerId'] },
      { body: { kind: 'segregation', clientOwnerId: 'client-1', corporateOwnerId: ' \n' }, missing: ['corporateOwnerId'] },
      { body: { kind: 'segregation', complete: true, corporateOwnerId: 'corp-1' }, missing: ['clientOwnerId'] },
      {
        body: { kind: 'segregation', claimFullyReserved: true, clientOwnerId: 'client-1' },
        missing: ['corporateOwnerId'],
      },
    ];

    for (const { body, missing } of cases) {
      const out = handleFinanceClose(body);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe(OWNERS_UNNAMED);
      expect(out.reason).not.toBe(CLIENT_CORPORATE_COMMINGLED);
      expect(out.kind).toBe('segregation');
      expect(out.missing).toEqual(missing);
      expect(out.detail).toMatch(/not named/);
      const json = JSON.stringify(out);
      expect(json).not.toMatch(/client_corporate_commingled/);
      expect(json).not.toMatch(/"clientOwnerId":/);
      expect(json).not.toMatch(/"corporateOwnerId":/);
      expect(json).not.toMatch(/"balance"|"drift"|"amount"/);
      expect(out).not.toHaveProperty('balance');
      expect(out).not.toHaveProperty('drift');
    }
  });

  it('keeps client and corporate owners distinct on a named segregation', () => {
    const out = handleFinanceClose({
      kind: 'segregation',
      clientOwnerId: 'client-1',
      corporateOwnerId: 'corp-1',
    });
    expect(out).toEqual({
      ok: true,
      kind: 'segregation',
      complete: false,
      clientOwnerId: 'client-1',
      corporateOwnerId: 'corp-1',
      included: ['clientOwnerId', 'corporateOwnerId'],
    });
  });

  it('refuses a finance close when recipes are incomplete', () => {
    const out = handleFinanceClose({
      kind: 'close',
      complete: true,
      clientOwnerId: 'client-1',
      corporateOwnerId: 'corp-1',
      periodId: '2026-Q3',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(RECIPES_INCOMPLETE);
    expect(out.missing).toEqual(['clientBalances', 'corporateBalances']);
    expect(JSON.stringify(out)).not.toMatch(/"reserve"/);
    expect(out).not.toHaveProperty('amount');
  });

  it('accepts a close only when owners are distinct and both balance recipes are named', () => {
    const out = handleFinanceClose({
      kind: 'close',
      complete: true,
      ...DISTINCT,
    });
    expect(out).toEqual({
      ok: true,
      kind: 'close',
      complete: true,
      clientOwnerId: 'client-1',
      corporateOwnerId: 'corp-1',
      included: ['clientOwnerId', 'corporateOwnerId', 'periodId', 'clientBalances', 'corporateBalances'],
    });
    expect(JSON.stringify(out)).not.toMatch(/"coverage"|"fullyReserved"/);
  });

  it('refuses an invented reserve amount or inventReserve flag', () => {
    const invented = handleFinanceClose({
      kind: 'close',
      ...DISTINCT,
      inventReserve: true,
    });
    const bare = handleFinanceClose({
      kind: 'por',
      ...DISTINCT,
      reserveAmount: '100',
    });
    expect(invented.ok).toBe(false);
    expect(bare.ok).toBe(false);
    if (invented.ok || bare.ok) return;
    expect(invented.reason).toBe(RESERVE_INVENTED);
    expect(bare.reason).toBe(RESERVE_INVENTED);
    expect(JSON.stringify(bare)).not.toMatch(/"100"/);
  });

  it('refuses a fully-reserved PoR claim as misleading', () => {
    const out = handleFinanceClose({
      kind: 'por',
      ...DISTINCT,
      claimFullyReserved: true,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(POR_MISLEADING);
    expect(JSON.stringify(out)).not.toMatch(/"coverage"|"100%"/);
  });

  it('serves the incomplete-close refuse through the S2S handle', async () => {
    const out = await handleS2sFinanceClose(stub, {
      kind: 'close',
      complete: true,
      clientOwnerId: 'client-1',
      corporateOwnerId: 'corp-1',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(RECIPES_INCOMPLETE);
  });
});
