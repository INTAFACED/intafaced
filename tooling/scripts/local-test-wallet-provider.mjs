/**
 * LOCAL TEST embedded-wallet provider (J-wallet-22, OWNER 237): the labelled TEST stand-in for the owner's provider
 * (Turnkey or Privy, picked after the testnet trial). It is its own process, so its keys live only in its own memory:
 * never in a svc-* database, never in a log, and gone when it stops. Every wallet it makes is TEST.
 *
 * It behaves as the real providers do where it matters:
 *   - svc-protocol (the server side, loopback only, `/server/*`) asks it for the person's one wallet bound to their
 *     passkey, and reads a wallet back. Answers carry the wallet id, the address and the person, never a key.
 *   - The person's browser (the client side, `/client/*`, reached through the TEST stack's same-origin path
 *     `/__test-wallet-provider/client/*`) asks for a one-time challenge for one action, answers it with a WebAuthn
 *     assertion from a passkey bound to the wallet, and only then is a message signed, the key exported to the person,
 *     or a recovery passkey added. A session without that passkey cannot sign anything.
 * No seed phrase exists anywhere: the key is a fresh random secp256k1 key, and export hands the person the key itself.
 *
 * It refuses to start unless APP_ENV is exactly `dev` or `test`. Never part of a real environment.
 *
 *   node tooling/scripts/local-test-wallet-provider.mjs   (TEST_WALLET_PROVIDER_HOST, _PORT, _ORIGINS, APP_ENV)
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEST_WALLET_PROVIDER_LABEL = 'TEST wallet provider';
/** How long a client challenge can be answered. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ACTIONS = new Set(['sign', 'export', 'recovery']);

/** viem's account helpers, from svc-protocol's own install (the repo root has no viem of its own). */
export async function loadViemAccounts() {
  const req = createRequire(path.join(REPO, 'services', 'svc-protocol', 'package.json'));
  return import(pathToFileURL(req.resolve('viem/accounts')).href);
}

export function refuseTestProviderOutsideTest(appEnv) {
  if (appEnv !== 'dev' && appEnv !== 'test')
    throw new Error(`the TEST wallet provider runs only with APP_ENV=dev or test (got ${JSON.stringify(appEnv ?? null)})`);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => createHash('sha256').update(data).digest();
const isB64url = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

/** What the challenge commits to: the action and its exact payload, so an assertion for one thing never does another. */
export const payloadHash = (action, payload) => b64url(sha256(JSON.stringify([action, payload ?? null])));

/**
 * The provider's state and rules, with no HTTP. `origins` are the page origins a passkey assertion may come from; the
 * relying party is each origin's host name (WebAuthn: `localhost` on the TEST stack).
 */
export function createTestWalletProvider({ origins, accounts, now = () => Date.now(), random = randomBytes }) {
  const allowed = new Set(origins);
  const wallets = new Map(); // walletId -> { walletId, ownerRef, privateKey, address, passkeys: Map(credentialId -> KeyObject) }
  const byOwner = new Map();
  const challenges = new Map(); // challenge -> { walletId, action, hash, expiresAt }

  const publicWallet = (w) => ({ walletId: w.walletId, address: w.address, ownerRef: w.ownerRef, label: 'TEST' });

  function importPasskey(passkey) {
    if (!passkey || passkey.algorithm !== -7 || !isB64url(passkey.credentialId, 1400) || !isB64url(passkey.publicKey, 400))
      return null;
    try {
      const key = createPublicKey({ key: Buffer.from(passkey.publicKey, 'base64url'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
      return key;
    } catch {
      return null;
    }
  }

  /** Server side: the person's one wallet, bound to their passkey; the existing one when they already have it. */
  function createWallet({ ownerRef, idempotencyKey, passkey }) {
    if (typeof ownerRef !== 'string' || !ownerRef || idempotencyKey !== `wallet:embedded:${ownerRef}`)
      return { status: 400, body: { error: 'bad_request' } };
    const existing = byOwner.get(ownerRef);
    if (existing) return { status: 200, body: publicWallet(wallets.get(existing)) };
    const key = importPasskey(passkey);
    if (!key) return { status: 400, body: { error: 'passkey_invalid' } };
    const privateKey = `0x${random(32).toString('hex')}`;
    const wallet = {
      walletId: `testw_${random(12).toString('hex')}`,
      ownerRef,
      privateKey,
      address: accounts.privateKeyToAccount(privateKey).address,
      passkeys: new Map([[passkey.credentialId, key]]),
    };
    wallets.set(wallet.walletId, wallet);
    byOwner.set(ownerRef, wallet.walletId);
    return { status: 200, body: publicWallet(wallet) };
  }

  function getWallet(walletId) {
    const w = wallets.get(walletId);
    return w ? { status: 200, body: publicWallet(w) } : { status: 404, body: { error: 'not_found' } };
  }

  /** Client side: a one-time challenge for one action on one wallet, and the passkeys that may answer it. */
  function challenge({ walletId, action, payload }) {
    const w = wallets.get(walletId);
    if (!w) return { status: 404, body: { error: 'not_found' } };
    if (!ACTIONS.has(action)) return { status: 400, body: { error: 'bad_request' } };
    const value = b64url(random(32));
    challenges.set(value, { walletId, action, hash: payloadHash(action, payload), expiresAt: now() + CHALLENGE_TTL_MS });
    return { status: 200, body: { challenge: value, allowCredentials: [...w.passkeys.keys()] } };
  }

  /**
   * The WebAuthn assertion check every client action passes: the challenge is this one's, unused and in time, for this
   * action and payload; the page origin is listed; the relying party is that origin's host; the person was present and
   * verified; and the signature verifies under a passkey bound to the wallet. Spends the challenge either way.
   */
  function checkAssertion({ walletId, action, payload, challenge: value, assertion }) {
    const entry = typeof value === 'string' ? challenges.get(value) : undefined;
    if (entry) challenges.delete(value);
    if (!entry || entry.walletId !== walletId || entry.action !== action || entry.expiresAt <= now()) return 'challenge_invalid';
    if (entry.hash !== payloadHash(action, payload)) return 'challenge_invalid';
    const w = wallets.get(walletId);
    if (!w) return 'challenge_invalid';
    if (
      !assertion ||
      !isB64url(assertion.credentialId, 1400) ||
      !isB64url(assertion.clientDataJSON, 4000) ||
      !isB64url(assertion.authenticatorData, 4000) ||
      !isB64url(assertion.signature, 400)
    )
      return 'assertion_invalid';
    const key = w.passkeys.get(assertion.credentialId);
    if (!key) return 'passkey_unknown';
    let client;
    try {
      client = JSON.parse(Buffer.from(assertion.clientDataJSON, 'base64url').toString('utf8'));
    } catch {
      return 'assertion_invalid';
    }
    if (client?.type !== 'webauthn.get' || client.challenge !== value || !allowed.has(client.origin)) return 'assertion_invalid';
    const authData = Buffer.from(assertion.authenticatorData, 'base64url');
    if (authData.length < 37) return 'assertion_invalid';
    const rpIdHash = sha256(new URL(client.origin).hostname);
    if (!authData.subarray(0, 32).equals(rpIdHash)) return 'assertion_invalid';
    const flags = authData[32];
    // User present (0x01) and user verified (0x04): the passkey's own check passed on the person's device.
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return 'assertion_invalid';
    const signed = Buffer.concat([authData, sha256(Buffer.from(assertion.clientDataJSON, 'base64url'))]);
    let ok = false;
    try {
      ok = verifySignature('sha256', signed, { key, dsaEncoding: 'der' }, Buffer.from(assertion.signature, 'base64url'));
    } catch {
      ok = false;
    }
    return ok ? null : 'assertion_invalid';
  }

  async function act(action, body) {
    const { walletId, payload } = body ?? {};
    const refused = checkAssertion({ walletId, action, payload, challenge: body?.challenge, assertion: body?.assertion });
    if (refused) return { status: 403, body: { error: refused } };
    const w = wallets.get(walletId);
    if (action === 'sign') {
      if (typeof payload?.message !== 'string' || payload.message.length > 10_000) return { status: 400, body: { error: 'bad_request' } };
      const signature = await accounts.privateKeyToAccount(w.privateKey).signMessage({ message: payload.message });
      return { status: 200, body: { signature, address: w.address } };
    }
    if (action === 'export') return { status: 200, body: { privateKey: w.privateKey, address: w.address, label: 'TEST' } };
    // recovery: a second passkey the person registered, added only with an assertion from a passkey already bound.
    const key = importPasskey(payload?.passkey);
    if (!key) return { status: 400, body: { error: 'passkey_invalid' } };
    w.passkeys.set(payload.passkey.credentialId, key);
    return { status: 200, body: { added: true, passkeys: w.passkeys.size } };
  }

  return { createWallet, getWallet, challenge, act, wallets };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** The provider behind loopback HTTP. Nothing it answers or logs carries a key, except `export` to the person. */
export async function serveTestWalletProvider({ host, port, appEnv, origins, accounts }) {
  refuseTestProviderOutsideTest(appEnv);
  const provider = createTestWalletProvider({ origins, accounts: accounts ?? (await loadViemAccounts()) });
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://provider');
      const p = url.pathname;
      if (req.method === 'GET' && p === '/health') return send(200, { ok: true, label: 'TEST', name: TEST_WALLET_PROVIDER_LABEL });
      if (req.method === 'POST' && p === '/server/wallets') {
        const r = provider.createWallet(await readJson(req));
        return send(r.status, r.body);
      }
      const read = /^\/server\/wallets\/([A-Za-z0-9_-]{1,128})$/.exec(p);
      if (req.method === 'GET' && read) {
        const r = provider.getWallet(read[1]);
        return send(r.status, r.body);
      }
      if (req.method === 'POST' && p === '/client/challenge') {
        const r = provider.challenge(await readJson(req));
        return send(r.status, r.body);
      }
      const action = /^\/client\/(sign|export|recovery)$/.exec(p);
      if (req.method === 'POST' && action) {
        const r = await provider.act(action[1], await readJson(req));
        return send(r.status, r.body);
      }
      return send(404, { error: 'not_found' });
    } catch {
      return send(400, { error: 'bad_request' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${server.address().port}`;
  process.stdout.write(`${JSON.stringify({ msg: 'test-wallet-provider.listening', label: 'TEST', url })}\n`);
  return { server, url, provider };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveTestWalletProvider({
    host: process.env.TEST_WALLET_PROVIDER_HOST ?? '127.0.0.1',
    port: Number(process.env.TEST_WALLET_PROVIDER_PORT ?? '14561'),
    appEnv: process.env.APP_ENV,
    origins: (process.env.TEST_WALLET_PROVIDER_ORIGINS ?? 'http://localhost:3210').split(',').map((o) => o.trim()),
  }).catch((err) => {
    process.stderr.write(`test-wallet-provider: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
