import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P2P_TRADES_TAKE } from '@intafaced/contracts/p2p-procedures';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('trades.take requires a caller tradeId', () => {
  it('does not mint a UUID on take', () => {
    const service = readFileSync(join(here, 'p2p-service.ts'), 'utf8');
    const take = service.slice(service.indexOf('async takeOffer'), service.indexOf('private async reserveTrade'));
    expect(take).toMatch(/p2p\.trade_id_required/);
    expect(take).not.toMatch(/crypto\.randomUUID\(\)/);
  });

  it('the take record requires a tradeId uuid, and the handler passes it on', () => {
    const take = { offerId: '33333333-3333-4333-8333-333333333333', amount: '10', method: 'sepa' };
    expect(P2P_TRADES_TAKE.input.safeParse(take).success).toBe(false);
    expect(P2P_TRADES_TAKE.input.safeParse({ ...take, tradeId: 'not-a-uuid' }).success).toBe(false);
    expect(P2P_TRADES_TAKE.input.safeParse({ ...take, tradeId: '44444444-4444-4444-8444-444444444444' }).success).toBe(true);
    const router = readFileSync(join(here, 'router.ts'), 'utf8');
    const handler = router.slice(router.indexOf("'p2p.trades.take':"), router.indexOf("'p2p.trades.contractEscrow':"));
    expect(handler).toMatch(/tradeId: input\.tradeId/);
  });
});
