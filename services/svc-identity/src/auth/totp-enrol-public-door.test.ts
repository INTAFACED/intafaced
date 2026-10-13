/**
 * totp.enrol through IDENTITY_TOTP_SECRET_KEY.
 *
 * Confirm already refuses a blank key. Enrol start used to mint a secret and
 * write pending hashes anyway — a secret that can never be sealed. This door
 * refuses before generateSecret / pending put. No invented AES key.
 * Execute, not a pin.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import type { Sql } from 'postgres';
import { AuthService } from './auth-service.js';
import { MemoryPendingTotpEnrolmentStore } from './pending-totp-store.js';
import type { RankService } from '../rank/rank-service.js';
import { ChallengeStore } from './webauthn.js';
import { createIdentityRouter } from '../router.js';

const EDGE_SECRET = 'identity-totp-enrol-public-door-edge-secret-32b';
const USER = '11111111-1111-4111-8111-111111111111';

const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const challenges = new ChallengeStore();

function throwSql(): never {
  throw new Error('sql must not run when IDENTITY_TOTP_SECRET_KEY is blank');
}

function blankSql(): Sql {
  return Object.assign(throwSql, { json: throwSql }) as unknown as Sql;
}

function userSql(user: { email: string; totp_secret: string | null }): Sql {
  const fn = async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('SELECT email, totp_secret')) return [user];
    throw new Error(`unexpected sql: ${q}`);
  };
  return Object.assign(fn, { json: (v: unknown) => v }) as unknown as Sql;
}

function makeAuth(key: string | undefined, sql: Sql = blankSql()) {
  const pending = new MemoryPendingTotpEnrolmentStore();
  const auth = new AuthService(
    sql,
    new MemoryEventBus('svc-identity'),
    {} as RankService,
    tokenConfig,
    undefined,
    key,
    challenges,
    pending,
  );
  return { auth, pending };
}

function principal(): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['identity:read', 'identity:write'],
    tier: 'none',
    mfa: false,
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

async function mountEnrol(auth: AuthService): Promise<FastifyInstance> {
  const router = createIdentityRouter(auth, {} as RankService, { registrationOpen: true });
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

describe('totp.enrol — refuse blank IDENTITY_TOTP_SECRET_KEY', () => {
  it('startTotpEnrolment refuses a blank key — no invented secret, no pending write', async () => {
    const { auth, pending } = makeAuth('');
    await expect(auth.startTotpEnrolment(USER, { mfa: false, privileged: false })).rejects.toMatchObject({ code: 'auth.totp_key_missing' });
    expect(pending.size).toBe(0);
  });

  it('startTotpEnrolment refuses a missing key', async () => {
    const { auth, pending } = makeAuth(undefined);
    await expect(auth.startTotpEnrolment(USER, { mfa: false, privileged: false })).rejects.toMatchObject({ code: 'auth.totp_key_missing' });
    expect(pending.size).toBe(0);
  });

  it('startTotpEnrolment refuses a short key — no invented AES material', async () => {
    const { auth, pending } = makeAuth('short');
    await expect(auth.startTotpEnrolment(USER, { mfa: false, privileged: false })).rejects.toMatchObject({ code: 'auth.totp_key_missing' });
    expect(pending.size).toBe(0);
  });

  it('totp.enrol over the wire is 412 when the key is blank — pending stays empty', async () => {
    const { auth, pending } = makeAuth('');
    const app = await mountEnrol(auth);
    try {
      const res = await app.inject({ method: 'POST', url: '/trpc/totp.enrol', headers: signedHeaders(), payload: {} });
      const body = res.json() as WireBody;
      expect(res.statusCode).toBe(412);
      expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
      expect(body.error?.message).toContain('IDENTITY_TOTP_SECRET_KEY');
      expect(pending.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('a real 32-byte key lets enrol start and writes pending hashes only', async () => {
    const key = randomBytes(32).toString('base64');
    const { auth, pending } = makeAuth(key, userSql({ email: 'owner@example.com', totp_secret: null }));
    const started = await auth.startTotpEnrolment(USER, { mfa: false, privileged: false });
    expect(started.secret.length).toBeGreaterThan(16);
    expect(started.uri).toContain('otpauth://');
    expect(started.recoveryCodes.length).toBeGreaterThan(0);
    expect(pending.size).toBe(1);
  });
});
