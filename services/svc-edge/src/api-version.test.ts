import { describe, expect, it } from 'vitest';
import { API_DEPRECATIONS, LATEST_API_VERSION } from '@intafaced/contracts/api-versions';
import { advisoriesFor, advisoryReplyHeaders, negotiateApiVersion, versionReplyHeaders } from './api-version.js';
import { apiVersionDefaultFromExchange } from './principal-exchange.js';

// J-developer-16 #5 and #6: the dated version header on /api/v1, the account default, the two refusals and the advisory.

const ORDERS = '/api/v1/orders';
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('negotiateApiVersion', () => {
  it('applies a known header for every caller and echoes it as the header source', () => {
    for (const apiKey of [true, false]) {
      const decision = negotiateApiVersion({ pathname: ORDERS, header: LATEST_API_VERSION, apiKey, accountDefault: null });
      expect(decision).toEqual({ kind: 'apply', version: LATEST_API_VERSION, source: 'header' });
      expect(versionReplyHeaders(decision)).toEqual({ 'intafaced-version': LATEST_API_VERSION, 'intafaced-version-source': 'header' });
    }
  });

  it('a header wins over the account default', () => {
    expect(negotiateApiVersion({ pathname: ORDERS, header: LATEST_API_VERSION, apiKey: true, accountDefault: LATEST_API_VERSION })).toEqual(
      {
        kind: 'apply',
        version: LATEST_API_VERSION,
        source: 'header',
      },
    );
  });

  it('refuses an unknown value, an empty one and a repeated one, for a key and a signed-out caller alike', () => {
    for (const header of ['1999-01-01', 'latest', '', ' ', [LATEST_API_VERSION, LATEST_API_VERSION]]) {
      for (const apiKey of [true, false]) {
        const decision = negotiateApiVersion({ pathname: ORDERS, header, apiKey, accountDefault: LATEST_API_VERSION });
        expect(decision).toMatchObject({ kind: 'refuse', status: 400, code: 'version.unknown' });
        expect(versionReplyHeaders(decision)).toEqual({});
      }
    }
  });

  it('a key with no header takes its account default, echoed as the account source', () => {
    const decision = negotiateApiVersion({ pathname: ORDERS, header: undefined, apiKey: true, accountDefault: LATEST_API_VERSION });
    expect(decision).toEqual({ kind: 'apply', version: LATEST_API_VERSION, source: 'account' });
    expect(versionReplyHeaders(decision)).toEqual({ 'intafaced-version': LATEST_API_VERSION, 'intafaced-version-source': 'account' });
  });

  it('a key with neither is refused version.unset with both fixes named, never the latest', () => {
    for (const accountDefault of [null, undefined]) {
      const decision = negotiateApiVersion({ pathname: ORDERS, header: undefined, apiKey: true, accountDefault });
      expect(decision).toMatchObject({ kind: 'refuse', status: 400, code: 'version.unset' });
      if (decision.kind !== 'refuse') throw new Error('not refused');
      expect(decision.message).toContain('intafaced-version header');
      expect(decision.message).toContain('account default API version');
    }
  });

  it('a signed-out or session call with no header goes on as before, with no echo', () => {
    const decision = negotiateApiVersion({ pathname: ORDERS, header: undefined, apiKey: false });
    expect(decision).toEqual({ kind: 'none' });
    expect(versionReplyHeaders(decision)).toEqual({});
  });

  it('only /api/v1 is versioned', () => {
    for (const pathname of ['/api/v10/orders', '/api/pay/v1/payments', '/api/identity/trpc/me', '/api/v1x']) {
      expect(negotiateApiVersion({ pathname, header: 'nonsense', apiKey: true, accountDefault: null })).toEqual({ kind: 'none' });
    }
    expect(negotiateApiVersion({ pathname: '/api/v1', header: 'nonsense', apiKey: false })).toMatchObject({ code: 'version.unknown' });
  });
});

describe('deprecation advisories', () => {
  const stopPx = API_DEPRECATIONS.find((d) => d.field === 'stopPx')!;

  it('a POST /api/v1/orders body with stopPx carries the Deprecation date, the changelog link and the entry, and no Sunset', () => {
    const advisories = advisoriesFor({ method: 'post', pathname: ORDERS, body: json({ type: 'stop_limit', stopPx: '100' }) });
    expect(advisories).toEqual([stopPx]);
    const headers = advisoryReplyHeaders(advisories);
    // 2026-11-20T00:00:00Z.
    expect(headers.deprecation).toBe('@1795132800');
    expect(headers.link).toBe('</developers/changelog>; rel="deprecation"');
    expect(headers.sunset).toBeUndefined();
    expect(JSON.parse(headers['intafaced-advisories']!)).toEqual([
      expect.objectContaining({ field: 'stopPx', replacement: 'stopPrice', sunset: null, path: ORDERS, method: 'POST' }),
    ]);
  });

  it('no advisory for stopPrice, another path or method, or a body that is not a JSON object', () => {
    expect(advisoriesFor({ method: 'POST', pathname: ORDERS, body: json({ type: 'stop_limit', stopPrice: '100' }) })).toEqual([]);
    expect(advisoriesFor({ method: 'POST', pathname: '/api/v1/orders/replace', body: json({ stopPx: '1' }) })).toEqual([]);
    expect(advisoriesFor({ method: 'GET', pathname: ORDERS, body: Buffer.alloc(0) })).toEqual([]);
    expect(advisoriesFor({ method: 'POST', pathname: ORDERS, body: Buffer.from('stopPx=1') })).toEqual([]);
    expect(advisoriesFor({ method: 'POST', pathname: ORDERS, body: json([{ stopPx: '1' }]) })).toEqual([]);
    expect(advisoryReplyHeaders([])).toEqual({});
  });

  it('sends Sunset once an owner has set a removal date', () => {
    const headers = advisoryReplyHeaders([{ ...stopPx, sunset: '2027-06-01' }]);
    expect(headers.sunset).toBe('Tue, 01 Jun 2027 00:00:00 GMT');
  });
});

describe('the account default from the key exchange', () => {
  it('reads a version this edge implements, and nothing else', () => {
    expect(apiVersionDefaultFromExchange({ apiVersionDefault: LATEST_API_VERSION })).toBe(LATEST_API_VERSION);
    for (const data of [{ apiVersionDefault: null }, { apiVersionDefault: '1999-01-01' }, { apiVersionDefault: 20261120 }, {}, null, 'x']) {
      expect(apiVersionDefaultFromExchange(data)).toBeNull();
    }
  });
});
