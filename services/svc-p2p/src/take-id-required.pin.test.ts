import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('trades.take requires a caller tradeId', () => {
  it('does not mint a UUID on take', () => {
    const service = readFileSync(join(here, 'p2p-service.ts'), 'utf8');
    const take = service.slice(service.indexOf('async takeOffer'), service.indexOf('private async reserveTrade'));
    expect(take).toMatch(/p2p\.trade_id_required/);
    expect(take).not.toMatch(/crypto\.randomUUID\(\)/);
  });

  it('router take input requires tradeId uuid', () => {
    const router = readFileSync(join(here, 'router.ts'), 'utf8');
    const take = router.slice(router.indexOf('take: merchantApiProcedure'), router.indexOf('markFiatSent:'));
    expect(take).toMatch(/tradeId: z\.string\(\)\.guid\(\)/);
    expect(take).toMatch(/tradeId: input\.tradeId/);
  });
});
