import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createDexRouter } from '../router.js';
import { limitOrderCodes, type LimitOrderInput } from './limit-order.js';

const SECRET = 'a-dex-limit-order-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-23T00:00:00.000Z');

const priorRegions = process.env[SANCTIONS_REGIONS_ENV];
const priorSource = process.env[SANCTIONS_SOURCE_ENV];
beforeAll(() => {
  process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
  process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
});
afterAll(() => {
  if (priorRegions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
  else process.env[SANCTIONS_REGIONS_ENV] = priorRegions;
  if (priorSource === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
  else process.env[SANCTIONS_SOURCE_ENV] = priorSource;
});

const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-dex' });

const principal = () =>
  encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    // The header codec checks the wire shape. The cast matches the other dex edge tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

function request(headers: Record<string, string>) {
  return edge({ headers, id: 'req-limit' });
}

const anonymous = () => request({ 'x-intafaced-region': 'DE' });

const signed = () => {
  const raw = principal();
  return request({
    [EDGE_PRINCIPAL_HEADER]: raw,
    [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  });
};

const forged = () =>
  request({
    [EDGE_PRINCIPAL_HEADER]: principal(),
    'x-intafaced-region': 'DE',
  });

function router(onVenues?: () => void) {
  return createDexRouter({
    venues: () => {
      onVenues?.();
      return [];
    },
    now: () => NOW,
  });
}

const live: LimitOrderInput = {
  symbol: 'IFC-USD',
  side: 'buy',
  price: '1.25',
  size: '2',
  window: { startsAt: '2026-10-23T00:00:00.000Z', endsAt: '2026-10-24T00:00:00.000Z' },
};

async function refused(input: LimitOrderInput, ctx = signed()) {
  return router()
    .createCaller(ctx)
    .limitOrder(input)
    .then(
      () => {
        throw new Error('limitOrder resolved');
      },
      (err: { code?: string; message?: string; cause?: { code?: string } }) => err,
    );
}

describe('svc-dex limitOrder — forwarded principal, no session store', () => {
  it('does not call another service or keep a store', () => {
    const src = readFileSync(new URL('./limit-order.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/svc-identity|INTERNAL_SERVICE_SECRET|DATABASE_URL|fetch\(|ledger\.post/);
    expect(src).not.toMatch(/from\s+['"]@intafaced\/ledger-client\/recipes['"]/);
  });

  it('refuses a missing principal before reading a price', async () => {
    let venues = 0;
    await expect(
      router(() => (venues += 1))
        .createCaller(anonymous())
        .limitOrder(live),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      cause: { code: limitOrderCodes.principalRequired },
    });
    expect(venues).toBe(0);
  });

  it('refuses an unsigned principal the same way — a forged header is not a session', async () => {
    const err = await refused(live, forged());
    expect(err.cause?.code).toBe(limitOrderCodes.principalRequired);
    expect(err.message).toContain(limitOrderCodes.principalRequired);
  });

  it('refuses a blank symbol, price, size, or window without inventing one', async () => {
    expect((await refused({ ...live, symbol: '  ' })).cause?.code).toBe(limitOrderCodes.symbolUnset);
    expect((await refused({ ...live, price: '' })).cause?.code).toBe(limitOrderCodes.priceUnset);
    expect((await refused({ ...live, price: '   ' })).cause?.code).toBe(limitOrderCodes.priceUnset);
    expect((await refused({ ...live, price: undefined })).cause?.code).toBe(limitOrderCodes.priceUnset);
    expect((await refused({ ...live, size: '' })).cause?.code).toBe(limitOrderCodes.sizeUnset);
    expect((await refused({ ...live, window: undefined })).cause?.code).toBe(limitOrderCodes.windowUnset);
    expect((await refused({ ...live, window: '   ' })).cause?.code).toBe(limitOrderCodes.windowUnset);
    expect((await refused({ ...live, window: { startsAt: '', endsAt: '2026-10-24T00:00:00.000Z' } })).cause?.code).toBe(
      limitOrderCodes.windowUnset,
    );
  });

  it('refuses zero, a negative, and a non-decimal as invalid — not as a filled-in price', async () => {
    expect((await refused({ ...live, price: '0' })).cause?.code).toBe(limitOrderCodes.priceInvalid);
    expect((await refused({ ...live, price: '-1' })).cause?.code).toBe(limitOrderCodes.priceInvalid);
    expect((await refused({ ...live, price: '1.2.3' })).cause?.code).toBe(limitOrderCodes.priceInvalid);
    expect((await refused({ ...live, size: '0' })).cause?.code).toBe(limitOrderCodes.sizeInvalid);
    expect((await refused({ ...live, price: '1.2500000000000000001' })).cause?.code).toBe(limitOrderCodes.priceInvalid);
  });

  it('does not turn a duration word into a window', async () => {
    const err = await refused({ ...live, window: '24h' });
    expect(err.cause?.code).toBe(limitOrderCodes.windowInvalid);
    expect(err.message).not.toMatch(/24:00|86400/);
  });

  it('refuses a window that ends before it starts, or that has already ended', async () => {
    expect(
      (await refused({ ...live, window: { startsAt: '2026-10-24T00:00:00.000Z', endsAt: '2026-10-23T00:00:00.000Z' } })).cause?.code,
    ).toBe(limitOrderCodes.windowInvalid);
    expect(
      (await refused({ ...live, window: { startsAt: '2026-10-22T00:00:00.000Z', endsAt: '2026-10-23T00:00:00.000Z' } })).cause?.code,
    ).toBe(limitOrderCodes.windowInvalid);
  });

  it('refuses to place a valid order, and does not return an id or call a venue', async () => {
    let venues = 0;
    const err = await router(() => {
      venues += 1;
    })
      .createCaller(signed())
      .limitOrder(live)
      .then(
        () => {
          throw new Error('limitOrder resolved');
        },
        (caught: { code?: string; message?: string; cause?: { code?: string } }) => caught,
      );
    expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE', cause: { code: limitOrderCodes.notPlaced } });
    expect(err.message).toContain(limitOrderCodes.notPlaced);
    expect(err.message).not.toMatch(/orderId|0x[0-9a-f]{8}/i);
    expect(venues).toBe(0);
  });

  it('still screens the region before the principal check', async () => {
    vi.stubEnv(SANCTIONS_REGIONS_ENV, '   ');
    vi.stubEnv(SANCTIONS_SOURCE_ENV, undefined);
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'true');
    try {
      await expect(router().createCaller(signed()).limitOrder(live)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'denied.screening_unconfigured' },
      });
    } finally {
      vi.unstubAllEnvs();
      process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
      process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
    }
  });
});
