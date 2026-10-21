import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createServiceSigner, type Keyring } from '@intafaced/contracts';
import { OPS_FEE_REVENUE_UNAVAILABLE, OPS_FEE_REVENUE_UNCONFIGURED } from './codes.js';
import { createFeeRevenueClient } from './fee-revenue-client.js';

const WINDOW = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };
const OK_BODY = {
  from: WINDOW.from.toISOString(),
  to: WINDOW.to.toISOString(),
  assets: [{ assetId: 'USDT', collected: '12.5', returned: '0.25', net: '12.25' }],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const keyring: Keyring = [{ kid: 'svc-ops.a', svc: 'svc-ops', use: 's2s', x }];
  return { signer: createServiceSigner({ service: 'svc-ops', kid: 'svc-ops.a', privateKey: key, keyring }) };
}

describe('fee revenue client', () => {
  it('is unconfigured, with its own code, when there is no URL or no credential, and never calls out', async () => {
    let called = 0;
    const fetcher = (async () => (called++, json(OK_BODY))) as unknown as typeof fetch;
    const noUrl = createFeeRevenueClient({ secret: 'x'.repeat(32), fetcher });
    const noKey = createFeeRevenueClient({ ledgerUrl: 'http://ledger.internal:4001', fetcher });
    for (const client of [noUrl, noKey]) {
      expect(client.configured).toBe(false);
      expect(await client.read(WINDOW)).toMatchObject({ ok: false, code: OPS_FEE_REVENUE_UNCONFIGURED });
    }
    expect(called).toBe(0);
  });

  it('posts the window to /trpc/feeRevenue, signed, and returns the parsed per-asset answer', async () => {
    const seen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return json(OK_BODY);
    }) as unknown as typeof fetch;
    const client = createFeeRevenueClient({
      ledgerUrl: 'http://ledger.internal:4001/',
      s2s: { signer: keypair().signer, mode: 'keypair' },
      fetcher,
    });
    expect(client.configured).toBe(true);
    const out = await client.read(WINDOW);
    expect(out).toEqual({ ok: true, value: OK_BODY });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://ledger.internal:4001/trpc/feeRevenue');
    expect(JSON.parse(seen[0]!.body)).toEqual({ from: OK_BODY.from, to: OK_BODY.to });
    expect(Object.keys(seen[0]!.headers).length).toBeGreaterThan(1);
  });

  it('turns a refusal, a bad shape, a number amount, a wrong window and a network failure into a typed unavailable, never zero', async () => {
    const cases: Array<() => Response | never> = [
      () => json({ code: 'ledger.caller_forbidden' }, 403),
      () => json({ nope: true }),
      () => json({ ...OK_BODY, assets: [{ assetId: 'USDT', collected: 12, returned: '0', net: '12' }] }),
      () => json({ ...OK_BODY, from: '2026-09-01T00:00:00.000Z' }),
      () => {
        throw new Error('connection refused');
      },
    ];
    for (const respond of cases) {
      const client = createFeeRevenueClient({
        ledgerUrl: 'http://ledger.internal:4001',
        s2s: { signer: keypair().signer, mode: 'keypair' },
        fetcher: (async () => respond()) as unknown as typeof fetch,
      });
      expect(await client.read(WINDOW)).toMatchObject({ ok: false, code: OPS_FEE_REVENUE_UNAVAILABLE });
    }
  });
});
