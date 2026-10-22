/**
 * kyc.getDocument through IDENTITY_KYC_DOC_KEY.
 *
 * getFor used to ask the reader before the key, so a blank key could lose to
 * reader_missing. The door now refuses key-missing first — no invented AES
 * key, no plaintext.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { AuthService } from '../auth/auth-service.js';
import type { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { MemoryKycDocumentStore } from './document-store.js';

const EDGE_SECRET = 'identity-kyc-doc-get-public-door-edge-secret-32b';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_ID = '00000000-0000-4000-8000-000000000000';

function principal(): Principal {
  return {
    sub: OPERATOR,
    userId: OPERATOR,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['admin:compliance'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signedHeaders(): Record<string, string> {
  const raw = encodePrincipal(principal());
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

function unwrapData(body: WireBody): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && 'json' in (data as Record<string, unknown>)) {
    return (data as { json: unknown }).json;
  }
  return data;
}

async function mount(vault?: MemoryKycDocumentStore): Promise<FastifyInstance> {
  const router = createIdentityRouter({} as AuthService, {} as RankService, {
    registrationOpen: true,
    ...(vault ? { kycDocs: vault } : {}),
  });
  const app = Fastify({ logger: false });
  const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-identity' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  return app;
}

const getBody = { documentId: DOC_ID };

describe('kyc.getDocument — refuse blank IDENTITY_KYC_DOC_KEY', () => {
  it('unwired vault (blank env key) is 412 — no invented store', async () => {
    const app = await mount();
    try {
      const res = await app.inject({ method: 'POST', url: '/trpc/kyc.getDocument', headers: signedHeaders(), payload: getBody });
      const body = res.json() as WireBody;
      expect(res.statusCode).toBe(412);
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toContain('kyc_doc.unwired');
    } finally {
      await app.close();
    }
  });

  it('blank key on the vault refuses get — 412, no plaintext', async () => {
    const vault = new MemoryKycDocumentStore('');
    const app = await mount(vault);
    try {
      const res = await app.inject({ method: 'POST', url: '/trpc/kyc.getDocument', headers: signedHeaders(), payload: getBody });
      const body = res.json() as WireBody;
      expect(res.statusCode).toBe(412);
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toContain('IDENTITY_KYC_DOC_KEY');
    } finally {
      await app.close();
    }
  });

  it('a real 32-byte key lets get decrypt and returns bytes for compliance', async () => {
    const vault = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    const plain = Buffer.from('passport-scan');
    const meta = await vault.put({ userId: SUBJECT, contentType: 'image/png', bytes: plain, storedBy: OPERATOR });
    const app = await mount(vault);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/trpc/kyc.getDocument',
        headers: signedHeaders(),
        payload: { documentId: meta.id },
      });
      expect(res.statusCode).toBe(200);
      const data = unwrapData(res.json() as WireBody) as Record<string, unknown>;
      expect(data.userId).toBe(SUBJECT);
      expect(data.contentType).toBe('image/png');
      expect(data.byteLength).toBe(plain.length);
      expect(data.bytesBase64).toBe(plain.toString('base64'));
      expect(data).not.toHaveProperty('ciphertext');
    } finally {
      await app.close();
    }
  });
});
