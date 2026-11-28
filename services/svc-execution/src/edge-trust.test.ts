/**
 * The edge principal is verified with the shared secret AND, when configured, the edge's public key.
 * The trust settings come from the service's edge env settings through `edgeTrustFromEnv`; the last case boots
 * the real entrypoint (`testing/boot.ts`) and asks it over /trpc.
 */
import { describe, expect, it } from 'vitest';
import { edgeEnvSchema, edgeTrustFromEnv, loadEnv } from '@intafaced/config';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodeForwardedPrincipal,
  encodePrincipal,
  generateEdgePrincipalKeyPair,
  signPrincipalHeader,
  serviceAuthHeadersForBody,
  signPrincipalHeaderEd25519,
} from '@intafaced/contracts';
import { BOOT_EDGE_SECRET, bootExecution } from './testing/boot.js';

type Principal = Parameters<typeof encodeForwardedPrincipal>[0];

const SECRET = 's'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const edge = generateEdgePrincipalKeyPair();
const LIMITS = { EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '120', EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '10' };

const principal = (): Principal =>
  ({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

function contextWith(overrides: Record<string, string | undefined>) {
  const env = loadEnv(edgeEnvSchema, { EDGE_PRINCIPAL_SECRET: SECRET, ...overrides });
  return createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, ...edgeTrustFromEnv(env), serviceName: 'svc-execution' });
}

const request = (raw: string, signature: string) => ({
  headers: { [EDGE_PRINCIPAL_HEADER]: raw, [EDGE_SIGNATURE_HEADER]: signature, 'x-intafaced-region': 'DE' },
});

const edgeSigned = (privateKey = edge.privateKey, maxLifetimeSeconds = 120) => {
  const raw = encodeForwardedPrincipal(principal(), maxLifetimeSeconds);
  return request(raw, signPrincipalHeaderEd25519(raw, privateKey, 'DE'));
};

describe('edge principal receiver', () => {
  const withKey = { EDGE_PRINCIPAL_PUBLIC_KEY: edge.publicKey, ...LIMITS };

  it('accepts a principal signed by the edge key when the public key and both limits are set', () => {
    expect(contextWith(withKey)(edgeSigned()).principal?.userId).toBe(USER);
  });

  it('refuses that principal when the public key is unset', () => {
    expect(contextWith({})(edgeSigned()).principal).toBeNull();
  });

  it('refuses a principal signed by another key', () => {
    expect(contextWith(withKey)(edgeSigned(generateEdgePrincipalKeyPair().privateKey)).principal).toBeNull();
  });

  it('refuses a principal whose lifetime exceeds the configured maximum', () => {
    expect(contextWith(withKey)(edgeSigned(edge.privateKey, 300)).principal).toBeNull();
  });

  it('still accepts the shared-secret form', () => {
    const raw = encodePrincipal(principal());
    expect(contextWith(withKey)(request(raw, signPrincipalHeader(raw, SECRET, 'DE'))).principal?.userId).toBe(USER);
  });

  it('index.ts hands the edge trust settings to the edge context', async () => {
    // The booted service, asked over /trpc with a trade:read principal the edge key signed.
    const statusOf = async (vars: Record<string, string>) => {
      const booted = await bootExecution({ ...vars });
      try {
        const input = encodeURIComponent(JSON.stringify({ symbol: 'BTC/USDT', amount: '1' }));
        const signed = edgeSigned();
        const res = await booted.app.inject({
          method: 'GET',
          url: `/trpc/execution.arb.opportunities?input=${input}`,
          headers: signed.headers,
        });
        return res.statusCode;
      } finally {
        await booted.close();
      }
    };
    expect(await statusOf(withKey)).not.toBe(401);
    expect(await statusOf({})).toBe(401);
  });

  it('index.ts verifies the shared-secret principal with its own EDGE_PRINCIPAL_SECRET', async () => {
    // The booted service, given a principal signed with the secret it was started with, and with another one.
    const booted = await bootExecution();
    try {
      const input = encodeURIComponent(JSON.stringify({ symbol: 'BTC/USDT', amount: '1' }));
      const raw = encodePrincipal(principal());
      const statusFor = async (secret: string) =>
        (
          await booted.app.inject({
            method: 'GET',
            url: `/trpc/execution.arb.opportunities?input=${input}`,
            headers: request(raw, signPrincipalHeader(raw, secret, 'DE')).headers,
          })
        ).statusCode;
      expect(await statusFor(BOOT_EDGE_SECRET)).toBe(200);
      expect(await statusFor('another-edge-secret-that-is-not-the-boot-one')).toBe(401);
    } finally {
      await booted.close();
    }
  });

  it('index.ts hands the edge context the whole request, so a service call binds its body', async () => {
    // A v2 service signature binds the body bytes. The context can only check them if it is given the request
    // itself (`req.body`); handed `{ headers, id }` it has no body and refuses every service call.
    const SERVICE = 'svc-execution-boot-placeholder-internal-secret';
    const booted = await bootExecution({ INTERNAL_SERVICE_SECRET: SERVICE });
    try {
      const body = JSON.stringify({ parentClientOrderId: 'parent-1' });
      const post = async (sent: string) =>
        booted.app.inject({
          method: 'POST',
          url: '/trpc/execution.oms.start',
          headers: {
            ...serviceAuthHeadersForBody('svc-execution', SERVICE, body),
            'content-type': 'application/json',
            'x-intafaced-region': 'DE',
          },
          payload: sent,
        });
      const bound = await post(body);
      expect(bound.statusCode).toBe(200);
      expect(bound.json().result.data).toMatchObject({ ok: false, reason: 'jobs_off' });
      // The same signature over other bytes is refused: the body the context checked is the one that came in.
      expect((await post(JSON.stringify({ parentClientOrderId: 'parent-2' }))).statusCode).toBe(401);
    } finally {
      await booted.close();
    }
  });
});
