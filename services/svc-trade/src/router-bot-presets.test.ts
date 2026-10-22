import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { BOT_PRESETS_NOT_SET, BotPresetsSourceError, parseBotPresetsSource, type BotPresetsView } from './algo/bot-presets.js';
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
const app = (presets?: BotPresetsView) =>
  createTradeRouter({} as TradeService, undefined, undefined, undefined, undefined, undefined, undefined, presets);
const SOURCE = {
  version: 'bt-2026-10-test',
  backtestedAt: '2026-10-20T00:00:00.000Z',
  presets: [
    { id: 'grid-cons-30d', strategy: 'grid', marketId: 'TEST-USDT', aggressiveness: 'conservative', horizon: '30d', aprEstimate: '4.25' },
    { id: 'dca-aggr-7d', strategy: 'dca', marketId: 'TEST-USDT', aggressiveness: 'aggressive', horizon: '7d', aprEstimate: '-1.5' },
  ],
};

describe('trade.bots.presets', () => {
  it('blank source reads not_set with no APR', () => {
    expect(parseBotPresetsSource('')).toEqual({ state: 'not_set', presets: [] });
    expect(parseBotPresetsSource('   ')).toBe(BOT_PRESETS_NOT_SET);
    expect(parseBotPresetsSource(undefined)).toBe(BOT_PRESETS_NOT_SET);
  });
  it('a set source returns exactly the owner presets through the router', async () => {
    const parsed = parseBotPresetsSource(JSON.stringify(SOURCE));
    expect(
      await app(parsed)
        .createCaller(contextFor(principal(['trade:read'])))
        .bots.presets(),
    ).toEqual({ state: 'published', ...SOURCE });
  });
  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['an empty preset list', JSON.stringify({ ...SOURCE, presets: [] })],
    ['a JSON-number APR', JSON.stringify({ ...SOURCE, presets: [{ ...SOURCE.presets[0], aprEstimate: 4.25 }] })],
    ['an unknown horizon', JSON.stringify({ ...SOURCE, presets: [{ ...SOURCE.presets[0], horizon: '1y' }] })],
    ['an unknown aggressiveness', JSON.stringify({ ...SOURCE, presets: [{ ...SOURCE.presets[0], aggressiveness: 'Moderate' }] })],
    ['a blank version', JSON.stringify({ ...SOURCE, version: ' ' })],
    ['an extra key', JSON.stringify({ ...SOURCE, apr: '99' })],
    ['a duplicate id', JSON.stringify({ ...SOURCE, presets: [SOURCE.presets[0], SOURCE.presets[0]] })],
  ])('an invalid source (%s) fails the boot parse', (_label, raw) => {
    expect(() => parseBotPresetsSource(raw)).toThrow(BotPresetsSourceError);
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
