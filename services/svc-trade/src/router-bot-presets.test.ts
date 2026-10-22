import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { botPresets } from './algo/bot-presets.js';
import { createTradeRouter } from './router.js';
import type { TradeService } from './spot/trade-service.js';

/** copy-bots-otc-bots-003: the bots presets read. TEST values. */
const SECRET = 'a-trade-bots-router-test-edge-secret';
const USER = '61111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function contextFor(principal: Principal | null) {
  if (!principal) return edgeContext({ headers: {}, id: 'req-bots' });
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
      'x-intafaced-region': 'SG',
    },
    id: 'req-bots',
  });
}
const principal = (scopes: string[]): Principal =>
  ({ sub: USER, userId: USER, sid: USER, scopes, tier: 'full', mfa: false, expiresAt: new Date(Date.now() + 60_000) }) as Principal;
const app = () => createTradeRouter({} as TradeService);

describe('trade.bots.presets', () => {
  it('botPresets is not set and carries no APR until an owner backtest source exists', () => {
    expect(botPresets()).toEqual({ state: 'not_set', presets: [] });
  });
  it('reads not_set with no presets for a trade:read caller', async () => {
    expect(
      await app()
        .createCaller(contextFor(principal(['trade:read'])))
        .bots.presets(),
    ).toEqual({ state: 'not_set', presets: [] });
  });
  it('refuses an unauthenticated caller', async () => {
    await expect(app().createCaller(contextFor(null)).bots.presets()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('refuses a caller without trade:read', async () => {
    await expect(
      app()
        .createCaller(contextFor(principal(['trade:write'])))
        .bots.presets(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
