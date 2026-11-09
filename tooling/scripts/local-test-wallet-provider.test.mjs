// Proves the LOCAL TEST embedded-wallet provider (J-wallet-22): it refuses outside the local test stack; it makes one
// wallet per person, bound to their passkey, and answers no key on the server side; and nothing is signed, exported or
// added without a fresh WebAuthn assertion from a passkey bound to that wallet, for that action and payload, from a
// listed origin, with the person present and verified. Each refusal below is a planted fault.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signWith } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createTestWalletProvider,
  loadViemAccounts,
  refuseTestProviderOutsideTest,
  serveTestWalletProvider,
} from './local-test-wallet-provider.mjs';

const ORIGIN = 'http://localhost:3210';
const accounts = await loadViemAccounts();
const sha256 = (d) => createHash('sha256').update(d).digest();

function passkey(id = 'cred-a') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    wire: {
      credentialId: Buffer.from(id).toString('base64url'),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      algorithm: -7,
    },
  };
}

/** A WebAuthn assertion as an authenticator makes one: rpIdHash, flags, counter; signed over authData || sha256(clientData). */
function assertion(pk, challenge, { origin = ORIGIN, rpId = new URL(origin).hostname, flags = 0x05, type = 'webauthn.get', signer } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin }));
  const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const signature = signWith('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), {
    key: signer ?? pk.privateKey,
    dsaEncoding: 'der',
  });
  return {
    credentialId: pk.wire.credentialId,
    clientDataJSON: clientDataJSON.toString('base64url'),
    authenticatorData: authData.toString('base64url'),
    signature: signature.toString('base64url'),
  };
}

function setup() {
  const provider = createTestWalletProvider({ origins: [ORIGIN], accounts });
  const pk = passkey();
  const made = provider.createWallet({ ownerRef: 'person-1', idempotencyKey: 'wallet:embedded:person-1', passkey: pk.wire });
  assert.equal(made.status, 200);
  return { provider, pk, wallet: made.body };
}

async function signWithPasskey(provider, wallet, pk, message, opts = {}) {
  const ch = provider.challenge({ walletId: wallet.walletId, action: 'sign', payload: { message } });
  assert.equal(ch.status, 200);
  return provider.act('sign', {
    walletId: wallet.walletId,
    payload: { message: opts.signedMessage ?? message },
    challenge: ch.body.challenge,
    assertion: assertion(pk, ch.body.challenge, opts),
  });
}

test('refuses to start outside APP_ENV dev or test', async () => {
  for (const env of [undefined, '', 'production', 'staging', 'DEV']) assert.throws(() => refuseTestProviderOutsideTest(env));
  await assert.rejects(serveTestWalletProvider({ host: '127.0.0.1', port: 0, appEnv: 'production', origins: [ORIGIN], accounts }));
});

test('one wallet per person, bound to their passkey; the server side never answers a key', () => {
  const { provider, wallet } = setup();
  assert.match(wallet.address, /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual(Object.keys(wallet).sort(), ['address', 'label', 'ownerRef', 'walletId']);
  // A replay, even with another passkey, gives the same wallet, never a second.
  const again = provider.createWallet({
    ownerRef: 'person-1',
    idempotencyKey: 'wallet:embedded:person-1',
    passkey: passkey('cred-b').wire,
  });
  assert.deepEqual(again.body, wallet);
  assert.equal(provider.wallets.size, 1);
  assert.deepEqual(provider.getWallet(wallet.walletId).body, wallet);
  // A key that is not the person's business key, or a malformed passkey, makes nothing.
  assert.equal(provider.createWallet({ ownerRef: 'p2', idempotencyKey: 'wallet:embedded:p1', passkey: passkey().wire }).status, 400);
  assert.equal(
    provider.createWallet({ ownerRef: 'p2', idempotencyKey: 'wallet:embedded:p2', passkey: { ...passkey().wire, publicKey: 'AAAA' } })
      .status,
    400,
  );
  assert.equal(provider.wallets.size, 1);
});

test('signs only after a passkey assertion bound to the wallet, and the signature is the wallet address’s own', async () => {
  const { provider, pk, wallet } = setup();
  const ok = await signWithPasskey(provider, wallet, pk, 'hello INTAFACED');
  assert.equal(ok.status, 200);
  const req = createRequire(new URL('../../services/svc-protocol/package.json', import.meta.url));
  const { verifyMessage } = await import(pathToFileURL(req.resolve('viem')).href);
  assert.equal(await verifyMessage({ address: wallet.address, message: 'hello INTAFACED', signature: ok.body.signature }), true);
});

test('planted faults: every bad assertion signs nothing', async () => {
  const { provider, pk, wallet } = setup();
  const other = passkey('cred-a'); // same credential id, a different key: the signature is not the bound passkey's
  const cases = [
    ['another passkey’s key', { signer: other.privateKey }, 'assertion_invalid'],
    ['an unlisted origin', { origin: 'http://evil.localhost:3210' }, 'assertion_invalid'],
    ['the wrong relying party', { rpId: 'example.com' }, 'assertion_invalid'],
    ['no user verification', { flags: 0x01 }, 'assertion_invalid'],
    ['a registration, not an assertion', { type: 'webauthn.create' }, 'assertion_invalid'],
    ['a different message than the challenge', { signedMessage: 'pay someone else' }, 'challenge_invalid'],
  ];
  for (const [name, opts, error] of cases) {
    const r = await signWithPasskey(provider, wallet, pk, 'hello', opts);
    assert.equal(r.status, 403, name);
    assert.equal(r.body.error, error, name);
    assert.equal(r.body.signature, undefined, name);
  }
  // A passkey never bound to the wallet.
  const stranger = passkey('cred-z');
  assert.equal((await signWithPasskey(provider, wallet, stranger, 'hello')).body.error, 'passkey_unknown');
  // A challenge answers once; a challenge for export never signs.
  const ch = provider.challenge({ walletId: wallet.walletId, action: 'sign', payload: { message: 'm' } });
  const body = {
    walletId: wallet.walletId,
    payload: { message: 'm' },
    challenge: ch.body.challenge,
    assertion: assertion(pk, ch.body.challenge),
  };
  assert.equal((await provider.act('sign', body)).status, 200);
  assert.equal((await provider.act('sign', body)).body.error, 'challenge_invalid');
  const ex = provider.challenge({ walletId: wallet.walletId, action: 'export' });
  const viaExport = await provider.act('sign', {
    walletId: wallet.walletId,
    payload: { message: 'm' },
    challenge: ex.body.challenge,
    assertion: assertion(pk, ex.body.challenge),
  });
  assert.equal(viaExport.body.error, 'challenge_invalid');
  // No assertion at all.
  const bare = provider.challenge({ walletId: wallet.walletId, action: 'sign', payload: { message: 'm' } });
  assert.equal(
    (await provider.act('sign', { walletId: wallet.walletId, payload: { message: 'm' }, challenge: bare.body.challenge })).status,
    403,
  );
});

test('export goes to the person after their passkey; a recovery passkey added with the first then signs too', async () => {
  const { provider, pk, wallet } = setup();
  const ex = provider.challenge({ walletId: wallet.walletId, action: 'export' });
  const exported = await provider.act('export', {
    walletId: wallet.walletId,
    challenge: ex.body.challenge,
    assertion: assertion(pk, ex.body.challenge),
  });
  assert.equal(exported.status, 200);
  assert.equal(accounts.privateKeyToAccount(exported.body.privateKey).address, wallet.address);
  assert.equal(exported.body.label, 'TEST');

  const second = passkey('cred-recovery');
  // Adding it with its own assertion (not one already bound) is refused.
  const self = provider.challenge({ walletId: wallet.walletId, action: 'recovery', payload: { passkey: second.wire } });
  const selfAdd = await provider.act('recovery', {
    walletId: wallet.walletId,
    payload: { passkey: second.wire },
    challenge: self.body.challenge,
    assertion: assertion(second, self.body.challenge),
  });
  assert.equal(selfAdd.body.error, 'passkey_unknown');
  const rc = provider.challenge({ walletId: wallet.walletId, action: 'recovery', payload: { passkey: second.wire } });
  const added = await provider.act('recovery', {
    walletId: wallet.walletId,
    payload: { passkey: second.wire },
    challenge: rc.body.challenge,
    assertion: assertion(pk, rc.body.challenge),
  });
  assert.deepEqual(added.body, { added: true, passkeys: 2 });
  assert.equal((await signWithPasskey(provider, wallet, second, 'from the new device')).status, 200);
});

test('over HTTP: health, the server routes, and the client routes', async () => {
  const { server, url } = await serveTestWalletProvider({ host: '127.0.0.1', port: 0, appEnv: 'test', origins: [ORIGIN], accounts });
  try {
    assert.equal((await (await fetch(`${url}/health`)).json()).label, 'TEST');
    const pk = passkey();
    const made = await fetch(`${url}/server/wallets`, {
      method: 'POST',
      body: JSON.stringify({ ownerRef: 'p', idempotencyKey: 'wallet:embedded:p', passkey: pk.wire }),
    });
    const wallet = await made.json();
    assert.equal(made.status, 200);
    assert.equal(JSON.stringify(wallet).includes('privateKey'), false);
    assert.equal((await fetch(`${url}/server/wallets/${wallet.walletId}`)).status, 200);
    assert.equal((await fetch(`${url}/server/wallets/nope`)).status, 404);
    const ch = await (
      await fetch(`${url}/client/challenge`, {
        method: 'POST',
        body: JSON.stringify({ walletId: wallet.walletId, action: 'sign', payload: { message: 'x' } }),
      })
    ).json();
    const signed = await fetch(`${url}/client/sign`, {
      method: 'POST',
      body: JSON.stringify({
        walletId: wallet.walletId,
        payload: { message: 'x' },
        challenge: ch.challenge,
        assertion: assertion(pk, ch.challenge),
      }),
    });
    assert.equal(signed.status, 200);
    assert.equal((await fetch(`${url}/client/sign`, { method: 'POST', body: 'not json' })).status, 400);
  } finally {
    server.close();
  }
});
