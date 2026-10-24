/**
 * CARD R-quant — paper place never ledger-posts.
 * Source scan of placePaperOrderIsolated: a spy on a client this method
 * does not hold would stay green after someone added ledger.post here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// Placement lives in spot/trade-service/order-place.ts since the split by area.
const TRADE_SERVICE = join(here, '..', 'spot', 'trade-service', 'order-place.ts');

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('R-quant paper place never posts to the ledger', () => {
  const source = readFileSync(TRADE_SERVICE, 'utf8');

  it('routes paper markets into placePaperOrderIsolated before the hold', () => {
    expect(source).toContain('if (market.paper)');
    expect(source).toContain('return svc.placePaperOrderIsolated(');
    expect(source).toMatch(/Stage-1 paper isolation[\s\S]*post orderHold \/ tradeFill/);
  });

  it('the class method placePaperOrderIsolated only hands over to order-place.ts', () => {
    const cls = readFileSync(join(here, '..', 'spot', 'trade-service.ts'), 'utf8');
    const stub = cls.match(/private async placePaperOrderIsolated\([\s\S]*?\n  \}\n/);
    expect(stub, 'placePaperOrderIsolated must exist on TradeService').not.toBeNull();
    const body = stripComments(stub?.[0] ?? '').replace(/^[\s\S]*?\)[^{]*\{/, '');
    expect(body.trim()).toMatch(/^return orderPlace\.placePaperOrderIsolated\(this\.internal, [^;]*\);\s*\}$/);
  });

  it('placePaperOrderIsolated body has no ledger.post / orderHold / tradeFill', () => {
    const match = source.match(/export async function placePaperOrderIsolated\([\s\S]*?\n\}\n/);
    expect(match, 'placePaperOrderIsolated must exist in trade-service/order-place.ts').not.toBeNull();
    const body = stripComments(match?.[0] ?? '');
    expect(body).not.toMatch(/(?:this|svc)\.ledger\.post/);
    expect(body).not.toMatch(/\bledger\.post\b/);
    expect(body).not.toMatch(/recipes\.orderHold/);
    expect(body).not.toMatch(/recipes\.tradeFill/);
    expect(body).toMatch(/hold_amount[\s\S]*formatAmount\(0n\)/);
  });
});
