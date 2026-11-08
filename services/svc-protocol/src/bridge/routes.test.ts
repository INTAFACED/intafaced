import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { BRIDGE_ROUTE_KIND_FORBIDDEN, BRIDGE_ROUTES_INVALID, BRIDGE_ROUTES_UNSET } from '@intafaced/contracts/protocol-bridge';
import { createBridgeRouter } from './router.js';
import {
  BridgeRoutesError,
  bridgeRoutesLoader,
  bridgeRoutesPath,
  listBridgeRoutes,
  parseBridgeRoutes,
  TEST_BRIDGE_ROUTES,
} from './routes.js';

const end = (chainId: number, kind = 'testnet') => ({ chainId, name: `chain ${chainId}`, kind });
const route = (from = 11155111, to = 84532, token = 'USDC', provider: string | null = null) => ({
  from: end(from),
  to: end(to),
  token,
  provider,
});

function refusal(fn: () => unknown): BridgeRoutesError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeRoutesError);
    return err as BridgeRoutesError;
  }
  throw new Error('expected a refusal');
}

describe('the shipped owner table (D-bridge-chain-03)', () => {
  it('ships blank, and the blank table refuses bridge.routes_unset rather than answering an empty list', () => {
    expect(JSON.parse(readFileSync(bridgeRoutesPath, 'utf8'))).toEqual([]);
    const err = refusal(() => listBridgeRoutes());
    expect(err.code).toBe(BRIDGE_ROUTES_UNSET);
    expect(err.message.startsWith(BRIDGE_ROUTES_UNSET)).toBe(true);
  });
});

describe('parseBridgeRoutes', () => {
  it('reads a valid table of testnet and local routes', () => {
    const table = [route(), { ...route(84532, 11155111), provider: 'a provider' }];
    expect(parseBridgeRoutes(table)).toEqual(table);
    expect(listBridgeRoutes(() => table)).toEqual(table);
  });

  it('refuses a table that is not a list', () => {
    for (const json of [null, {}, 'routes', 3]) expect(refusal(() => parseBridgeRoutes(json)).code).toBe(BRIDGE_ROUTES_INVALID);
  });

  it('refuses a route that ends on a mainnet or INTACHAIN chain, at either end', () => {
    for (const kind of ['mainnet', 'intachain']) {
      expect(refusal(() => parseBridgeRoutes([{ ...route(), from: end(1, kind) }])).code).toBe(BRIDGE_ROUTE_KIND_FORBIDDEN);
      expect(refusal(() => parseBridgeRoutes([{ ...route(), to: end(1, kind) }])).code).toBe(BRIDGE_ROUTE_KIND_FORBIDDEN);
    }
  });

  it('refuses the whole table when one row is forbidden, never reading it in part', () => {
    const err = refusal(() => listBridgeRoutes(() => [route(), { ...route(84532, 1), to: end(1, 'mainnet') }]));
    expect(err.code).toBe(BRIDGE_ROUTE_KIND_FORBIDDEN);
  });

  it('refuses malformed rows: unknown kind, extra field, missing token, bad chain id', () => {
    const rows = [
      { ...route(), from: end(5, 'devnet') },
      { ...route(), extra: true },
      { from: end(1), to: end(2), provider: null },
      { ...route(), from: { ...end(0) } },
      { ...route(), token: '' },
    ];
    for (const row of rows) expect(refusal(() => parseBridgeRoutes([row])).code).toBe(BRIDGE_ROUTES_INVALID);
  });

  it('refuses a route from a chain to itself', () => {
    expect(refusal(() => parseBridgeRoutes([route(84532, 84532)])).code).toBe(BRIDGE_ROUTES_INVALID);
  });

  it('refuses a route listed twice, but allows the same chains with another token or direction', () => {
    expect(refusal(() => parseBridgeRoutes([route(), route()])).code).toBe(BRIDGE_ROUTES_INVALID);
    expect(parseBridgeRoutes([route(), route(11155111, 84532, 'EURC'), route(84532, 11155111)])).toHaveLength(3);
  });
});

describe('bridgeRoutesLoader: the labelled TEST table (OWNER 18, 44)', () => {
  it('reads the shipped owner file when unset or blank', () => {
    expect(bridgeRoutesLoader({})).toBeUndefined();
    expect(bridgeRoutesLoader({ PROTOCOL_BRIDGE_ROUTES: '  ', APP_ENV: 'production' })).toBeUndefined();
  });

  it('gives the labelled TEST route only on a dev or test stack', () => {
    for (const APP_ENV of ['dev', 'test']) {
      const load = bridgeRoutesLoader({ PROTOCOL_BRIDGE_ROUTES: 'TEST', APP_ENV });
      expect(load).toBeTypeOf('function');
      const routes = listBridgeRoutes(load);
      expect(routes).toEqual(TEST_BRIDGE_ROUTES);
      for (const r of routes) {
        expect(r.provider).toMatch(/^TEST\b/);
        expect(r.from.name).toMatch(/^TEST\b/);
        expect(r.to.name).toMatch(/^TEST\b/);
      }
    }
  });

  it('refuses to boot with TEST outside the local test stack', () => {
    for (const APP_ENV of [undefined, '', 'production', 'staging', 'Dev', ' test'])
      expect(() => bridgeRoutesLoader({ PROTOCOL_BRIDGE_ROUTES: 'TEST', APP_ENV })).toThrow(/Refusing to boot/);
  });

  it('refuses to boot with any other value, so a table is never set from the environment', () => {
    for (const value of ['test', 'true', '[]', 'deployments/other.json'])
      expect(() => bridgeRoutesLoader({ PROTOCOL_BRIDGE_ROUTES: value, APP_ENV: 'dev' })).toThrow(/Refusing to boot/);
  });

  it('hands out a copy, so a caller cannot change the TEST table', () => {
    const load = bridgeRoutesLoader({ PROTOCOL_BRIDGE_ROUTES: 'TEST', APP_ENV: 'test' })!;
    (load() as { token: string }[])[0]!.token = 'CHANGED';
    expect(listBridgeRoutes(load)[0]!.token).toBe(TEST_BRIDGE_ROUTES[0]!.token);
  });
});

describe('bridge.routes.list', () => {
  const edgeContext = createEdgeContext({ secret: 'bridge-routes-test-secret-0123456789abcdef', serviceName: 'svc-protocol' });
  const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-bridge' });

  it('refuses PRECONDITION_FAILED with bridge.routes_unset when the table is blank', async () => {
    await expect(
      createBridgeRouter({ loadRoutes: () => [] })
        .createCaller(anonymous())
        .routes.list(),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^bridge\.routes_unset/),
    });
  });

  it('refuses SERVICE_UNAVAILABLE on an invalid table', async () => {
    await expect(
      createBridgeRouter({ loadRoutes: () => [route(1, 1)] })
        .createCaller(anonymous())
        .routes.list(),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: expect.stringMatching(/^bridge\.routes_invalid/) });
  });

  it('answers the published routes', async () => {
    const load = bridgeRoutesLoader({ PROTOCOL_BRIDGE_ROUTES: 'TEST', APP_ENV: 'test' });
    await expect(createBridgeRouter({ loadRoutes: load }).createCaller(anonymous()).routes.list()).resolves.toEqual({
      routes: TEST_BRIDGE_ROUTES,
    });
  });
});
