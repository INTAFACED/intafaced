import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { P2P_TRADES_TAKE } from '@intafaced/contracts/p2p-procedures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { P2pError, P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';
import { recordingSql } from './testing/sql-recorder-fixture.js';
import { confirmedTakeStepUp, metTakeGate } from './take-gate-fixture.js';

const SECRET = 'a-p2p-take-id-test-edge-secret-long-enough';
const TAKER = '22222222-2222-4222-8222-222222222222';
const OFFER = '33333333-3333-4333-8333-333333333333';
const TRADE = '44444444-4444-4444-8444-444444444444';

afterEach(() => vi.unstubAllEnvs());

describe('trades.take requires a caller tradeId', () => {
  it('does not mint a UUID on take', async () => {
    // A blank id is refused by name before the service reads anything. A given id is the trade's id: the release
    // test takes under a fixed id and confirms by it (affiliate-release.pg.test.ts), which a minted one would fail.
    const { sql, calls } = recordingSql();
    const p2p = new P2pService(sql, {} as never, {} as never, {} as never);
    for (const tradeId of ['', '   ']) {
      await expect(p2p.takeOffer({ offerId: OFFER, takerId: TAKER, amount: 10n, method: 'sepa', tradeId })).rejects.toMatchObject({
        code: 'p2p.trade_id_required',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('the take record requires a tradeId uuid, and the handler passes it on', async () => {
    const take = { offerId: OFFER, amount: '10', method: 'sepa' };
    expect(P2P_TRADES_TAKE.input.safeParse(take).success).toBe(false);
    expect(P2P_TRADES_TAKE.input.safeParse({ ...take, tradeId: 'not-a-uuid' }).success).toBe(false);
    expect(P2P_TRADES_TAKE.input.safeParse({ ...take, tradeId: TRADE }).success).toBe(true);

    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-take-id');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const handed: Array<{ tradeId: string; takerId: string }> = [];
    const p2p = new P2pService(recordingSql().sql, {} as never, {} as never, {} as never);
    vi.spyOn(p2p, 'takeOffer').mockImplementation(async (input) => {
      handed.push({ tradeId: input.tradeId, takerId: input.takerId });
      throw new P2pError('stopped after the hand-off', 'p2p.offer_not_found');
    });
    const principal = {
      sub: TAKER,
      userId: TAKER,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    const ctx = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-take-id',
    });
    const caller = createP2pRouter(p2p, {} as never, undefined, {
      takeGate: metTakeGate(),
      takeStepUp: confirmedTakeStepUp(),
    }).createCaller(ctx);
    await expect(caller.trades.take({ ...take, tradeId: TRADE, stepUpApprovalId: 'appr-1' } as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(handed).toEqual([{ tradeId: TRADE, takerId: TAKER }]);
  });
});
