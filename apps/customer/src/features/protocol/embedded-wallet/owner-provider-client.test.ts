import { describe, expect, it } from 'vitest';
import { hashMessage, hashTypedData, recoverMessageAddress, recoverTypedDataAddress, type TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { OWNER_PROVIDER_API, joinSignature, ownerProviderClient, stampChallenge, type WalletAssertion } from './provider-client';

/**
 * J-wallet-22 #8: a wallet at the owner's provider signs the venue's challenge (EIP-191) and the trading
 * session's approval (EIP-712) at the provider, after the person's passkey answers a challenge that commits to the
 * exact request. The fake provider below signs with a real secp256k1 key the way the provider answers (r, s, v hex).
 */
const KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(KEY);
const WALLET = { address: ACCOUNT.address, providerWalletId: 'sub-org-1/wallet-1' };
const ASSERTION: WalletAssertion = { credentialId: 'Y3JlZA', clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' };
const TYPED: TypedDataDefinition = {
  domain: {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: 421614,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
  types: {
    'HyperliquidTransaction:ApproveAgent': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'agentAddress', type: 'address' },
      { name: 'agentName', type: 'string' },
      { name: 'nonce', type: 'uint64' },
    ],
  },
  primaryType: 'HyperliquidTransaction:ApproveAgent',
  message: { hyperliquidChain: 'Testnet', agentAddress: '0x1111111111111111111111111111111111111111', agentName: 'TEST', nonce: 1n },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A provider that signs the payload it was sent with `key`, answering `status` and the activity's `activityStatus`. */
function provider(opts: { key?: `0x${string}`; status?: number; activityStatus?: string } = {}) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: init.body });
    const payload = JSON.parse(init.body).parameters.payload as `0x${string}`;
    const sig = await sign({ hash: payload, privateKey: opts.key ?? KEY });
    const result = { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.yParity === 1 ? '01' : '00' };
    const activity = { status: opts.activityStatus ?? 'ACTIVITY_STATUS_COMPLETED', result: { signRawPayloadResult: result } };
    return new Response(JSON.stringify({ activity }), { status: opts.status ?? 200 });
  };
  return { sent, fetch };
}

function passkey(answer: { ok: true; data: WalletAssertion } | { ok: false; failure: 'passkey' } = { ok: true, data: ASSERTION }) {
  const challenges: Array<[string, readonly string[]]> = [];
  const assert = async (challenge: string, allow: readonly string[]) => {
    challenges.push([challenge, allow]);
    return answer;
  };
  return { challenges, assert };
}

describe('the owner’s provider signs after the person’s passkey', () => {
  it('J-wallet-22 #8: the venue challenge is signed by the wallet, the passkey committing to the exact request', async () => {
    const p = provider();
    const k = passkey();
    const client = ownerProviderClient({ wallet: WALLET, assert: k.assert, fetch: p.fetch });
    const signed = await client.signMessage(WALLET.providerWalletId, 'Sign in to the venue: TEST nonce 7');
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.data.address).toBe(ACCOUNT.address);
    expect(
      await recoverMessageAddress({ message: 'Sign in to the venue: TEST nonce 7', signature: signed.data.signature as `0x${string}` }),
    ).toBe(ACCOUNT.address);
    expect(p.sent).toHaveLength(1);
    const [req] = p.sent;
    expect(req?.url).toBe(`${OWNER_PROVIDER_API}/public/v1/submit/sign_raw_payload`);
    const body = JSON.parse(req!.body);
    expect(body).toMatchObject({
      type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
      organizationId: 'sub-org-1',
      parameters: {
        signWith: ACCOUNT.address,
        payload: hashMessage('Sign in to the venue: TEST nonce 7'),
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NO_OP',
      },
    });
    // The passkey answered a challenge made from this exact body, and that assertion is the request's stamp.
    expect(k.challenges).toEqual([[await stampChallenge(req!.body), []]]);
    expect(JSON.parse(req!.headers['X-Stamp-WebAuthn']!)).toEqual({
      authenticatorData: 'AA',
      clientDataJson: 'e30',
      credentialId: 'Y3JlZA',
      signature: 'AA',
    });
  });

  it('J-wallet-22 #8: the trading session’s approval (EIP-712) is signed by the wallet', async () => {
    const p = provider();
    const client = ownerProviderClient({ wallet: WALLET, assert: passkey().assert, fetch: p.fetch });
    const signed = await client.signTypedData(WALLET.providerWalletId, TYPED);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(await recoverTypedDataAddress({ ...TYPED, signature: signed.data.signature as `0x${string}` })).toBe(ACCOUNT.address);
    expect(JSON.parse(p.sent[0]!.body).parameters.payload).toBe(hashTypedData(TYPED));
  });

  it('the challenge is the UTF-8 hex SHA-256 of the body, as the provider checks it', async () => {
    // sha256("abc") = ba7816bf...; the challenge is those 64 hex characters as bytes, base64url.
    const expected = Buffer.from('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'utf8').toString('base64url');
    expect(await stampChallenge('abc')).toBe(expected);
  });

  it('joins r, s and v into one 65-byte signature, refusing a malformed answer', () => {
    expect(joinSignature({ r: '1', s: '2', v: '00' })).toBe(`0x${'1'.padStart(64, '0')}${'2'.padStart(64, '0')}1b`);
    expect(joinSignature({ r: 'a', s: 'b', v: '01' })?.endsWith('1c')).toBe(true);
    expect(joinSignature({ r: 'zz', s: '2', v: '00' })).toBeNull();
    expect(joinSignature({ r: '1', s: '2', v: '02' })).toBeNull();
    expect(joinSignature(null)).toBeNull();
  });

  it('planted faults keep their typed failures; nothing is sent without the passkey', async () => {
    const noPasskey = provider();
    expect(
      await ownerProviderClient({
        wallet: WALLET,
        assert: passkey({ ok: false, failure: 'passkey' }).assert,
        fetch: noPasskey.fetch,
      }).signMessage(WALLET.providerWalletId, 'm'),
    ).toEqual({ ok: false, failure: 'passkey' });
    expect(noPasskey.sent).toHaveLength(0);

    const cases: Array<[Parameters<typeof provider>[0], string]> = [
      [{ status: 500 }, 'down'],
      [{ status: 401 }, 'refused'],
      // A provider over its signing quota answers 429: its own limit, not the person's passkey.
      [{ status: 429 }, 'busy'],
      [{ activityStatus: 'ACTIVITY_STATUS_FAILED' }, 'refused'],
      // A signature from any other key never passes as the wallet's.
      [{ key: generatePrivateKey() }, 'refused'],
    ];
    for (const [opts, failure] of cases) {
      const client = ownerProviderClient({ wallet: WALLET, assert: passkey().assert, fetch: provider(opts).fetch });
      expect(await client.signMessage(WALLET.providerWalletId, 'm'), JSON.stringify(opts)).toEqual({ ok: false, failure });
      expect(await client.signTypedData(WALLET.providerWalletId, TYPED), JSON.stringify(opts)).toEqual({ ok: false, failure });
    }

    expect(
      await ownerProviderClient({
        wallet: WALLET,
        assert: passkey().assert,
        fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      }).signMessage(WALLET.providerWalletId, 'm'),
    ).toEqual({
      ok: false,
      failure: 'down',
    });

    // No wallet, or another wallet's id: refused before the passkey is asked.
    const k = passkey();
    expect(await ownerProviderClient({ assert: k.assert, fetch: provider().fetch }).signMessage('sub-org-1/wallet-1', 'm')).toEqual({
      ok: false,
      failure: 'refused',
    });
    expect(
      await ownerProviderClient({ wallet: WALLET, assert: k.assert, fetch: provider().fetch }).signMessage('other/wallet', 'm'),
    ).toEqual({
      ok: false,
      failure: 'refused',
    });
    expect(k.challenges).toHaveLength(0);
  });
});
