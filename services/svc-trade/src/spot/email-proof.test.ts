import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_SIGNATURE_HEADER,
  createServiceSigner,
  createServiceVerifier,
  verifyServiceRequest,
  type Keyring,
} from '@intafaced/contracts';
import { assertEmailProved, createEmailProofClient } from './email-proof.js';
import { StubEmailProof } from './testing.js';
import type { Principal } from '@intafaced/auth';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { OtcDeskService } from '../controls/test-admission.js';
import { FixedOtcStake } from '../otc/stake-source.js';
import { createObservedOtcMidSource } from '../otc/mid-source.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'email-proof-test-internal-secret-32c';

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
}

const client = () => createEmailProofClient('http://identity.example/', SECRET);

describe('createEmailProofClient', () => {
  it('reads a signed GET for the asked user and returns the proof', async () => {
    let url = '';
    let headers = new Headers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        url = String(input);
        headers = new Headers(init?.headers);
        return new Response(JSON.stringify({ userId: USER, emailProof: 'missing' }), { status: 200 });
      }),
    );
    await expect(client().get(USER)).resolves.toBe('missing');
    expect(url).toBe(`http://identity.example/internal/email-proof/${USER}`);
    expect(headers.get(SERVICE_SIGNATURE_HEADER)).toBeTruthy();
  });

  it('returns accepted for a proved email', async () => {
    answer(200, { userId: USER, emailProof: 'accepted' });
    await expect(client().get(USER)).resolves.toBe('accepted');
  });

  it.each([
    ['404 unknown user', 404, { error: 'account not found', code: 'identity.account_not_found' }],
    ['401 bad credentials', 401, { code: 'identity.unauthenticated' }],
    ['500', 500, 'boom'],
    ['an off-contract body', 200, { userId: USER, emailProof: 'yes' }],
    ['an extra field', 200, { userId: USER, emailProof: 'accepted', email: 'a@b.c' }],
    ['a body that is not JSON', 200, 'not json'],
    ['an answer about another user', 200, { userId: OTHER, emailProof: 'accepted' }],
  ])('fails closed on %s', async (_label, status, body) => {
    answer(status, body);
    await expect(client().get(USER)).rejects.toMatchObject({ code: 'trade.identity_unavailable' });
  });

  it('fails closed when identity is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(client().get(USER)).rejects.toMatchObject({ code: 'trade.identity_unavailable' });
  });

  it('signs with svc-trade’s own key when S2S keys are on', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyring: Keyring = [
      {
        kid: 'svc-trade.a',
        svc: 'svc-trade',
        use: 's2s',
        x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      },
    ];
    const signer = createServiceSigner({
      service: 'svc-trade',
      kid: 'svc-trade.a',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      keyring,
    });
    let sent: { url: URL; headers: Record<string, string> } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent = { url: new URL(String(input)), headers: init?.headers as Record<string, string> };
        return new Response(JSON.stringify({ userId: USER, emailProof: 'accepted' }), { status: 200 });
      }),
    );
    await createEmailProofClient('http://identity.test', SECRET, { signer, mode: 'keypair' }).get(USER);
    const verdict = verifyServiceRequest(
      { method: 'GET', url: sent!.url.pathname, headers: sent!.headers, body: '' },
      { verifier: createServiceVerifier({ self: 'svc-identity', keyring, bootSecond: 0 }), legacySecret: SECRET, mode: 'keypair' },
    );
    expect(verdict).toEqual({ service: 'svc-trade', scheme: 'keypair', rejected: null });
  });
});

describe('assertEmailProved', () => {
  it('passes a proved user and refuses a missing proof', async () => {
    const source = new StubEmailProof();
    await expect(assertEmailProved(source, USER)).resolves.toBeUndefined();
    source.missing.add(USER);
    await expect(assertEmailProved(source, USER)).rejects.toMatchObject({ code: 'trade.email_proof_required' });
  });

  it('refuses when no source is wired', async () => {
    await expect(assertEmailProved(undefined, USER)).rejects.toMatchObject({ code: 'trade.identity_unavailable' });
  });
});

describe('OTC accept', () => {
  it('refuses a new accept while the email is unproved, before anything is bound', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'ep-otc-btc' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10000'), rail: 'test', railRef: 'ep-otc-u' }));
    const now = new Date('2026-08-07T12:00:00.000Z');
    const emailProof = new StubEmailProof();
    const svc = new OtcDeskService(ledger, new FixedOtcStake(parseAmount('1000')), {
      // The house desk is the one provider these requests ask (CB-otc-01).
      makerDirectory: { published: true, makers: [{ id: 'house', name: 'House desk', route: 'platform' }], selectCap: 1 },
      law: {
        published: true,
        spreadBps: 50,
        minStake: parseAmount('500'),
        counterparty: 'platform',
        quoteTtlMs: 60_000,
        maxMidAgeSeconds: 60,
        // A zero desk minimum is an owner value: these quotes are not held by the CB-otc-07 minimum.
        minNotional: { USDT: 0n },
        assets: ['BTC'],
        minTier: 'basic',
      },
      midSource: createObservedOtcMidSource('BTC/USDT:200', () => now),
      now: () => now,
      emailProof,
    });
    const principal = { userId: USER, tier: 'basic' } as Principal;
    const quote = await svc.quote(principal, { side: 'buy', baseAsset: 'BTC', quoteAsset: 'USDT', qty: '1', makerIds: ['house'] });
    emailProof.missing.add(USER);
    await expect(svc.accept(principal, { quoteId: quote.quoteId })).rejects.toMatchObject({ code: 'trade.email_proof_required' });
    emailProof.missing.delete(USER);
    await expect(svc.accept(principal, { quoteId: quote.quoteId })).resolves.toBeTruthy();
  });
});

describe('boot wiring', () => {
  it('index.ts builds the identity client and hands it to TradeService', () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    expect(index).toMatch(/const emailProof = createEmailProofClient\(env\.IDENTITY_URL, env\.INTERNAL_SERVICE_SECRET, outS2s\);/);
    const ctor = index.slice(index.indexOf('const trade = new TradeService('));
    expect(ctor.slice(0, ctor.indexOf('});'))).toMatch(/\n  emailProof,\n/);
    for (const service of ['const positions = new PositionService(', 'const otc = new OtcDeskService(']) {
      const opts = index.slice(index.indexOf(service));
      expect(opts.slice(0, opts.indexOf('});'))).toMatch(/\n  emailProof,\n/);
    }
  });
});
