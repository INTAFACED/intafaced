import { describe, expect, it } from 'vitest';
import { httpClosureChecker, type ClosureFetch } from './closure-client.js';
import { SHARED, judged, keys, wire, type Wire } from '../s2s-out-keys.testkit.js';

/** The closure check from svc-identity, signed for each owning service and judged by that service's verifier. */
const USER = '11111111-1111-4111-8111-111111111111';
const OK = JSON.stringify({ asOf: '2026-01-01T00:00:00.000Z', blockers: [], balances: [] });

function capture(failFirst = false) {
  const sent: Wire[] = [];
  const fetchImpl: ClosureFetch = async (url, init) => {
    sent.push(wire(url, init));
    const status = failFirst && sent.length === 1 ? 503 : 200;
    return { status, text: async () => OK };
  };
  return { sent, fetchImpl };
}

describe.each([
  ['svc-bank', 'http://bank.test'],
  ['svc-trade', 'http://trade.test'],
  ['svc-p2p', 'http://p2p.test'],
] as const)('svc-identity closure check -> %s', (audience, url) => {
  const input = { userId: USER, subAccountIds: ['s-1'] };

  it('without a signing key the call is signed with the shared secret as before', async () => {
    const { sent, fetchImpl } = capture();
    await expect(httpClosureChecker({ url, secret: SHARED, fetchImpl }).check(input)).resolves.toMatchObject({ ok: true });
    expect(sent[0]!.url.pathname).toBe('/internal/closure-check');
    expect(Object.keys(sent[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s-'))).toBe(false);
    expect(judged(sent[0]!, keys().verifier(audience))).toMatchObject({ service: 'svc-identity', scheme: 'shared' });
  });

  it('dual: the owning service names the caller from the key, and the shared secret rides along', async () => {
    const { sent, fetchImpl } = capture();
    const k = keys();
    await httpClosureChecker({ url, secret: SHARED, fetchImpl, s2s: { ...k.s2s('dual'), audience } }).check(input);
    expect(sent[0]!.headers['x-intafaced-service']).toBe('svc-identity');
    expect(judged(sent[0]!, k.verifier(audience))).toEqual({ service: 'svc-identity', scheme: 'keypair', rejected: null });
  });

  it('keypair: only the key is sent; another path or another service is refused', async () => {
    const { sent, fetchImpl } = capture();
    const k = keys();
    await httpClosureChecker({ url, secret: SHARED, fetchImpl, s2s: { ...k.s2s('keypair'), audience } }).check(input);
    expect(sent[0]!.headers['x-intafaced-service']).toBeUndefined();
    expect(judged(sent[0]!, k.verifier(audience), 'keypair')).toMatchObject({ service: 'svc-identity', scheme: 'keypair' });
    const moved = { ...sent[0]!, url: new URL(`${url}/internal/other`) };
    expect(judged(moved, k.verifier(audience), 'keypair')).toMatchObject({ service: null });
    const other = audience === 'svc-bank' ? 'svc-p2p' : 'svc-bank';
    expect(judged(sent[0]!, k.verifier(other), 'keypair')).toMatchObject({ service: null });
  });

  it('the retry is signed afresh, so a key-signed retry is not a replay', async () => {
    const { sent, fetchImpl } = capture(true);
    const k = keys();
    await expect(
      httpClosureChecker({ url, secret: SHARED, fetchImpl, s2s: { ...k.s2s('keypair'), audience } }).check(input),
    ).resolves.toMatchObject({ ok: true });
    expect(sent).toHaveLength(2);
    const verifier = k.verifier(audience);
    expect(judged(sent[0]!, verifier, 'keypair')).toMatchObject({ service: 'svc-identity' });
    expect(judged(sent[1]!, verifier, 'keypair')).toMatchObject({ service: 'svc-identity' });
  });
});
