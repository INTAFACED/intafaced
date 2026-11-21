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

test('export answers the key once (J-dex-protocol-08 #9): a later request, or a second challenge issued before it, gets no key', async () => {
  const { provider, pk, wallet } = setup();
  const exportWith = (ch) =>
    provider.act('export', { walletId: wallet.walletId, challenge: ch.body.challenge, assertion: assertion(pk, ch.body.challenge) });
  // Two challenges issued before any export: the race a second tab makes.
  const first = provider.challenge({ walletId: wallet.walletId, action: 'export' });
  const raced = provider.challenge({ walletId: wallet.walletId, action: 'export' });
  assert.equal(raced.status, 200);
  const shown = await exportWith(first);
  assert.equal(shown.status, 200);
  assert.equal(accounts.privateKeyToAccount(shown.body.privateKey).address, wallet.address);
  // The raced challenge, answered by a valid passkey assertion, is refused with no key.
  const late = await exportWith(raced);
  assert.equal(late.status, 410);
  assert.equal(late.body.error, 'export_spent');
  assert.equal(late.body.privateKey, undefined);
  assert.match(late.body.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  // A new request is refused at the challenge: no passkey prompt, no key.
  const again = provider.challenge({ walletId: wallet.walletId, action: 'export' });
  assert.equal(again.status, 410);
  assert.equal(again.body.error, 'export_spent');
  assert.equal(again.body.challenge, undefined);
  assert.equal(JSON.stringify(again.body).includes(shown.body.privateKey.slice(2)), false);
  // The wallet still signs: only the export is spent.
  assert.equal((await signWithPasskey(provider, wallet, pk, 'still mine')).status, 200);
});

test('a refused export does not spend it: a failed passkey check leaves the one export for the person', async () => {
  const { provider, pk, wallet } = setup();
  const stranger = passkey('cred-z');
  const ch = provider.challenge({ walletId: wallet.walletId, action: 'export' });
  const refused = await provider.act('export', {
    walletId: wallet.walletId,
    challenge: ch.body.challenge,
    assertion: assertion(stranger, ch.body.challenge),
  });
  assert.equal(refused.status, 403);
  const next = provider.challenge({ walletId: wallet.walletId, action: 'export' });
  assert.equal(next.status, 200);
  const shown = await provider.act('export', {
    walletId: wallet.walletId,
    challenge: next.body.challenge,
    assertion: assertion(pk, next.body.challenge),
  });
  assert.equal(shown.status, 200);
});

test('its state survives a restart through its own file, and unanswered challenges never pile up', async () => {
  const { mkdtempSync, readFileSync, statSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'test-wallet-provider-'));
  const stateFile = join(dir, 'state.json');
  try {
    const first = await serveTestWalletProvider({ host: '127.0.0.1', port: 0, appEnv: 'test', origins: [ORIGIN], accounts, stateFile });
    const pk = passkey();
    const made = first.provider.createWallet({ ownerRef: 'p', idempotencyKey: 'wallet:embedded:p', passkey: pk.wire }).body;
    first.server.close();
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).label, 'TEST');
    const again = await serveTestWalletProvider({ host: '127.0.0.1', port: 0, appEnv: 'test', origins: [ORIGIN], accounts, stateFile });
    try {
      assert.deepEqual(again.provider.getWallet(made.walletId).body, made);
      // The same passkey still signs for it after the restart.
      assert.equal((await signWithPasskey(again.provider, made, pk, 'after restart')).status, 200);
      for (let i = 0; i < 50; i++) again.provider.challenge({ walletId: made.walletId, action: 'export' });
      assert.ok(again.provider.challenges.size <= 8);
      // An export given out before a restart stays given out after it.
      const ch = again.provider.challenge({ walletId: made.walletId, action: 'export' });
      const shown = await again.provider.act('export', {
        walletId: made.walletId,
        challenge: ch.body.challenge,
        assertion: assertion(pk, ch.body.challenge),
      });
      assert.equal(shown.status, 200);
      const third = await serveTestWalletProvider({ host: '127.0.0.1', port: 0, appEnv: 'test', origins: [ORIGIN], accounts, stateFile });
      try {
        assert.equal(third.provider.challenge({ walletId: made.walletId, action: 'export' }).body.error, 'export_spent');
      } finally {
        third.server.close();
      }
    } finally {
      again.server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signs a venue action’s EIP-712 typed data only after a passkey assertion for that exact payload (J-wallet-22 #8)', async () => {
  const { provider, pk, wallet } = setup();
  const req = createRequire(new URL('../../services/svc-protocol/package.json', import.meta.url));
  const { recoverTypedDataAddress } = await import(pathToFileURL(req.resolve('viem')).href);
  const typedData = {
    domain: { name: 'INTAFACED TEST venue simulator', version: '1', chainId: 1337000 },
    types: {
      Action: [
        { name: 'kind', type: 'string' },
        { name: 'payload', type: 'string' },
      ],
    },
    primaryType: 'Action',
    message: { kind: 'approve_agent', payload: '{"agentAddress":"0x00000000000000000000000000000000000000a1"}' },
  };
  const ch = provider.challenge({ walletId: wallet.walletId, action: 'signtyped', payload: { typedData } });
  assert.equal(ch.status, 200);
  const signed = await provider.act('signtyped', {
    walletId: wallet.walletId,
    payload: { typedData },
    challenge: ch.body.challenge,
    assertion: assertion(pk, ch.body.challenge),
  });
  assert.equal(signed.status, 200);
  assert.equal(
    (await recoverTypedDataAddress({ ...typedData, signature: signed.body.signature })).toLowerCase(),
    wallet.address.toLowerCase(),
  );

  // Planted faults: an assertion for one payload never signs another, and a message challenge never signs typed data.
  const other = {
    ...typedData,
    message: { ...typedData.message, payload: '{"agentAddress":"0x00000000000000000000000000000000000000b2"}' },
  };
  const ch2 = provider.challenge({ walletId: wallet.walletId, action: 'signtyped', payload: { typedData } });
  const swapped = await provider.act('signtyped', {
    walletId: wallet.walletId,
    payload: { typedData: other },
    challenge: ch2.body.challenge,
    assertion: assertion(pk, ch2.body.challenge),
  });
  assert.equal(swapped.body.error, 'challenge_invalid');
  const ch3 = provider.challenge({ walletId: wallet.walletId, action: 'sign', payload: { typedData } });
  const crossed = await provider.act('signtyped', {
    walletId: wallet.walletId,
    payload: { typedData },
    challenge: ch3.body.challenge,
    assertion: assertion(pk, ch3.body.challenge),
  });
  assert.equal(crossed.body.error, 'challenge_invalid');
  // Without the passkey's own check (user verified), nothing is signed.
  const ch4 = provider.challenge({ walletId: wallet.walletId, action: 'signtyped', payload: { typedData } });
  const unverified = await provider.act('signtyped', {
    walletId: wallet.walletId,
    payload: { typedData },
    challenge: ch4.body.challenge,
    assertion: assertion(pk, ch4.body.challenge, { flags: 0x01 }),
  });
  assert.equal(unverified.status, 403);
});
