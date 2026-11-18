import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANK_SPACES_LIST } from './bank-spaces-list.js';
import { procedureSchemaFile, routePath } from './procedure.js';
import { CONTRACT_PROCEDURES } from './procedure-registry.js';

describe('the written records of calls', () => {
  it('procedures.schema.json is what the records say (run `pnpm --filter @intafaced/contracts procedures:write`)', () => {
    const committed = readFileSync(new URL('../procedures.schema.json', import.meta.url), 'utf8');
    expect(JSON.parse(committed)).toEqual(JSON.parse(procedureSchemaFile(CONTRACT_PROCEDURES)));
  });

  it('a held space reads with no ledger account, and a ledger space must carry one shape', () => {
    const row = {
      id: 's',
      assetId: 'EUR',
      kind: 'primary',
      name: 'TEST',
      goalTarget: null,
      lockedUntil: null,
      unlocksAt: null,
      unlockRequestedAt: null,
      billsPot: null,
      balance: '1',
    };
    const heldAt = {
      label: 'TEST partner',
      asOf: '2026-11-18T00:00:00.000Z',
      figure: { state: 'known', source: 'TEST', amount: '1', asOf: '2026-11-18T00:00:00.000Z', staleAfterMs: 1, reason: null },
    };
    expect(BANK_SPACES_LIST.output.safeParse([{ ...row, ledgerAccount: null, heldAt }]).success).toBe(true);
    expect(BANK_SPACES_LIST.output.safeParse([{ ...row, ledgerAccount: { ownerType: 'user' }, heldAt: null }]).success).toBe(false);
    expect(BANK_SPACES_LIST.output.safeParse([{ ...row, balance: 1, ledgerAccount: null, heldAt }]).success).toBe(false);
  });

  it('a record cannot be changed after it is declared', () => {
    expect(Object.isFrozen(BANK_SPACES_LIST)).toBe(true);
  });

  it('fills an HTTP route template and refuses a missing part', () => {
    const route = { transport: 'http', method: 'POST', path: '/markets/:marketId/orders' } as const;
    expect(routePath(route, { marketId: 'BTC/USDT' })).toBe('/markets/BTC%2FUSDT/orders');
    expect(() => routePath(route, {})).toThrow('needs :marketId');
  });
});
