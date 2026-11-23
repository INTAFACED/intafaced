import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routePath } from '@intafaced/contracts/procedure';
import { committedProcedureSchemas, procedureSchemaDrift, sampleDisagreements } from '@intafaced/contracts/procedure-sides';
import { MATCHING_SUBMIT_ORDER } from './matching-submit-order.js';
import { EXCHANGE_PROCEDURES } from './procedure-registry.js';

const committed = () => committedProcedureSchemas(new URL('../procedures/', import.meta.url));

describe('the written records of exchange calls', () => {
  it('procedures/ is what the records say, one file per service', () => {
    expect(procedureSchemaDrift(committed(), EXCHANGE_PROCEDURES, 'pnpm --filter @intafaced/exchange-contract procedures:write')).toEqual(
      [],
    );
  });

  it('the registry is every `defineProcedure` in src/, written by code (run `procedures:write` when this fails)', () => {
    const args = ['../contracts/scripts/procedure-registry.mjs', '.', 'EXCHANGE_PROCEDURES', '@intafaced/contracts/procedure', '--check'];
    expect(() => execFileSync('node', args, { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' })).not.toThrow();
  });

  it("every record's samples get the same verdict from its zod schema and from its committed JSON export", () => {
    expect(sampleDisagreements(EXCHANGE_PROCEDURES, committed())).toEqual([]);
  });

  it("matching's submit refuses the body #8847 found: no lifecycle proof, and a client order id where a GUID belongs", () => {
    const body = { orderId: 'ORD-0001', accountId: 'acct-desk', type: 'limit', side: 'buy', qty: '1', price: '1', tif: 'GTC' };
    const issues = MATCHING_SUBMIT_ORDER.input.safeParse(body).error?.issues.map((i) => i.path.join('.'));
    expect(issues).toEqual(expect.arrayContaining(['orderId', 'lifecycleProof']));
  });

  it('names the route it is served on', () => {
    expect(MATCHING_SUBMIT_ORDER.transport).toBe('http');
    if (MATCHING_SUBMIT_ORDER.transport !== 'http') return;
    expect(routePath(MATCHING_SUBMIT_ORDER, { marketId: 'BTC/USDT' })).toBe('/markets/BTC%2FUSDT/orders');
  });
});
