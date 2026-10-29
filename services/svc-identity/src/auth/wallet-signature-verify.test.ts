import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import {
  retainRawBody,
  serviceAuthHeadersForBody,
  WALLET_SIGNATURE_VERIFY_PATH,
  walletSignatureVerifySchema,
  type WalletSignatureVerifyRequest,
} from '@intafaced/contracts';
import { registerWalletSignatureVerifyRoute, verifyWalletSignature } from './wallet-signature-verify.js';

const SECRET = 'w'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
// TEST keys, made up for this file; they hold nothing.
const LINKED = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const STRANGER = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const MESSAGE = '{"proposalId":"p-1","userId":"11111111-1111-4111-8111-111111111111","ballot":{"kind":"abstain"}}';

const walletsOf =
  (addresses: string[], usable = true) =>
  async () => ({ usable, wallets: addresses.map((a) => a.toLowerCase()) });
/** secp256k1 group order: n - s with v flipped is the same signer's malleable twin. */
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

async function request(signer = LINKED, message = MESSAGE): Promise<WalletSignatureVerifyRequest> {
  return { userId: USER, message, signature: await signer.signMessage({ message }) };
}

describe('verifyWalletSignature', () => {
  it('answers linked with the lower-case signer when one of the account wallets signed the exact message', async () => {
    const answer = await verifyWalletSignature(walletsOf([LINKED.address]), await request());
    expect(answer).toEqual({ state: 'linked', address: LINKED.address.toLowerCase() });
    expect(walletSignatureVerifySchema.parse(answer)).toEqual(answer);
  });

  it('answers not_linked when another wallet signed, or the message differs from what was signed', async () => {
    expect(await verifyWalletSignature(walletsOf([LINKED.address]), await request(STRANGER))).toEqual({ state: 'not_linked' });
    const signed = await request();
    expect(await verifyWalletSignature(walletsOf([LINKED.address]), { ...signed, message: `${MESSAGE} ` })).toEqual({
      state: 'not_linked',
    });
  });

  it('answers no_wallet when the account has no linked wallet', async () => {
    expect(await verifyWalletSignature(walletsOf([]), await request())).toEqual({ state: 'no_wallet' });
  });

  it('answers account_inactive, before any wallet, when the account may not act', async () => {
    expect(await verifyWalletSignature(walletsOf([LINKED.address], false), await request())).toEqual({ state: 'account_inactive' });
  });

  it('answers invalid for the non-canonical twins of a good signature (v 0 or 1, high s)', async () => {
    const good = await request();
    const r = good.signature.slice(2, 66);
    const s = BigInt(`0x${good.signature.slice(66, 130)}`);
    const v = good.signature.slice(130);
    const lowV = `0x${r}${s.toString(16).padStart(64, '0')}${v === '1b' ? '00' : '01'}`;
    const highS = `0x${r}${(ORDER - s).toString(16).padStart(64, '0')}${v === '1b' ? '1c' : '1b'}`;
    expect(await verifyWalletSignature(walletsOf([LINKED.address]), { ...good, signature: lowV })).toEqual({ state: 'invalid' });
    expect(await verifyWalletSignature(walletsOf([LINKED.address]), { ...good, signature: highS })).toEqual({ state: 'invalid' });
  });

  it('answers invalid when no signer can be recovered', async () => {
    const answer = await verifyWalletSignature(walletsOf([LINKED.address]), {
      userId: USER,
      message: MESSAGE,
      signature: `0x${'0'.repeat(130)}`,
    });
    expect(answer).toEqual({ state: 'invalid' });
  });
});

async function app(verify: (input: WalletSignatureVerifyRequest) => Promise<unknown>) {
  const server = Fastify({ logger: false });
  retainRawBody(server);
  registerWalletSignatureVerifyRoute(server, { verify: verify as never, internalSecret: SECRET });
  await server.ready();
  return server;
}

function post(payload: unknown, service = 'svc-token') {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url: WALLET_SIGNATURE_VERIFY_PATH,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, raw) },
    payload: raw,
  };
}

describe('POST /internal/wallet-signatures/verify', () => {
  it('needs service credentials, and only svc-token may ask', async () => {
    const asked: WalletSignatureVerifyRequest[] = [];
    const server = await app(async (input) => {
      asked.push(input);
      return { state: 'no_wallet' };
    });
    const body = await request();
    const anonymous = await server.inject({ method: 'POST', url: WALLET_SIGNATURE_VERIFY_PATH, payload: body });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('identity.unauthenticated');
    const other = await server.inject(post(body, 'svc-bank'));
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('identity.wallet_signature_reader_refused');
    expect(asked).toHaveLength(0);

    const ok = await server.inject(post(body));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ state: 'no_wallet' });
    expect(asked).toEqual([body]);
  });

  it('refuses a malformed request before any wallet is read', async () => {
    let calls = 0;
    const server = await app(async () => {
      calls += 1;
      return { state: 'no_wallet' };
    });
    const body = await request();
    for (const bad of [
      { ...body, userId: 'not-a-guid' },
      { ...body, message: '' },
      { ...body, message: 'x'.repeat(4097) },
      { ...body, signature: '0x1234' },
      { ...body, extra: true },
    ]) {
      const res = await server.inject(post(bad));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('identity.wallet_signature_request_invalid');
    }
    expect(calls).toBe(0);
  });
});
