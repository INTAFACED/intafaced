import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { procedureSchemaFile, routePath } from '@intafaced/contracts/procedure';
import { MATCHING_SUBMIT_ORDER } from './matching-submit-order.js';
import { EXCHANGE_PROCEDURES } from './procedure-registry.js';

describe('the written records of exchange calls', () => {
  it('procedures.schema.json is what the records say (run `pnpm --filter @intafaced/exchange-contract procedures:write`)', () => {
    const committed = readFileSync(new URL('../procedures.schema.json', import.meta.url), 'utf8');
    expect(JSON.parse(committed)).toEqual(JSON.parse(procedureSchemaFile(EXCHANGE_PROCEDURES)));
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
