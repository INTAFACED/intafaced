import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyServiceHeaders, verifyForwardedPrincipal } from '@intafaced/contracts';
import { principalFor } from '../spot/testing.js';
import { createLiveTradingOperator } from './identity-port.js';

const subject = 'a1111111-1111-4111-8111-111111111111';
const serviceSecret = 's'.repeat(32),
  edgeSecret = 'e'.repeat(32);
const config = { url: 'http://identity.invalid', serviceSecret, edgeSecret };
const context = () => ({ principal: { ...principalFor(subject), mfa: true }, service: null, region: 'SG', requestId: 'request' });
const enabled = { status: 'enabled', userId: subject, version: '0', changedAt: new Date().toISOString() };
describe('Trading founder validation transport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('binds exact body and original signed principal/region; every check performs a live request', async () => {
    const requests: RequestInit[] = [];
    const port = createLiveTradingOperator(config, (async (url, request) => {
      expect(String(url)).toBe('http://identity.invalid/trpc/accountControls.operatorEntitlement');
      requests.push(request!);
      return new Response(JSON.stringify({ result: { data: enabled } }), { status: 200 });
    }) as typeof fetch)!;
    expect(await port.check(context())).toBe('enabled');
    expect(await port.check(context())).toBe('enabled');
    expect(requests).toHaveLength(2);
    const request = requests[0]!;
    const headers = request.headers as Record<string, string>;
    expect(request.body).toBe(JSON.stringify({ userId: subject }));
    expect(
      verifyServiceHeaders(headers, serviceSecret, {
        mode: 'require',
        rawBody: { retained: true, bytes: Buffer.from(String(request.body)) },
      }).service,
    ).toBe('svc-trade');
    expect(
      verifyServiceHeaders(headers, serviceSecret, { mode: 'require', rawBody: { retained: true, bytes: Buffer.from('{}') } }).service,
    ).toBeNull();
    expect(
      verifyForwardedPrincipal(headers['x-intafaced-principal']!, headers['x-intafaced-principal-sig']!, edgeSecret, new Date(), 'SG')
        .principal?.userId,
    ).toBe(subject);
    expect(request.redirect).toBe('error');
  });
  it.each([
    {},
    { result: { data: { ...enabled, userId: 'b1111111-1111-4111-8111-111111111111' } } },
    { result: { data: { ...enabled, status: 'unknown' } } },
  ])('fails closed for unknown, malformed, or mismatched authority', async (wire) => {
    const port = createLiveTradingOperator(config, (async () => new Response(JSON.stringify(wire))) as typeof fetch)!;
    expect(await port.check(context())).toBe('unavailable');
  });
  it('bounds a stuck response body independently of fetch abort; missing config refuses', async () => {
    vi.useFakeTimers();
    const port = createLiveTradingOperator(config, (async () => ({
      ok: true,
      json: () => new Promise(() => undefined),
    })) as unknown as typeof fetch)!;
    const pending = port.check(context());
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe('unavailable');
    expect(vi.getTimerCount()).toBe(0);
    expect(createLiveTradingOperator({ ...config, serviceSecret: '' })).toBeNull();
  });
});
