import { describe, expect, it } from 'vitest';
import { createL1ActionHash } from '@nktkas/hyperliquid/signing';
import vectors from './fixtures/hl-python-sdk-signing-vectors.json' with { type: 'json' };
import { assertSigningAgrees, SigningCrossCheckError } from './cross-check.js';
import { actionHash, l1TypedData, recoverTypedDataSigner, USER_SIGNED_TYPES, userSignedTypedData } from './signing.js';
import type { MsgpackValue } from './msgpack.js';

const hex32 = (h: string) => h.replace(/^0x/, '').padStart(64, '0');
const sig = (s: { r: string; s: string; v: number }) => `0x${hex32(s.r)}${hex32(s.s)}${s.v.toString(16)}` as const;

describe('@nktkas/hyperliquid, pinned, against the Hyperliquid Python SDK vectors (CI cross-check)', () => {
  it('builds the same L1 action hash as our encoder for every SDK vector, and the SDK test key recovers from it', async () => {
    expect(vectors.l1.length).toBeGreaterThan(0);
    for (const v of vectors.l1) {
      const vault = (v as { vaultAddress: string | null }).vaultAddress;
      const ours = actionHash(v.action as unknown as MsgpackValue, vault, BigInt(v.nonce));
      const theirs = createL1ActionHash({
        action: v.action as Record<string, unknown>,
        nonce: v.nonce,
        ...(vault ? { vaultAddress: vault as `0x${string}` } : {}),
      });
      expect(theirs.toLowerCase(), v.test).toBe(ours.toLowerCase());
      const signer = await recoverTypedDataSigner(l1TypedData(theirs), sig(v.testnet));
      expect(signer, v.test).toBe(vectors.signerAddress.toLowerCase());
    }
  });
});

describe('the runtime cross-check refuses any disagreement', () => {
  const action = {
    type: 'order',
    orders: [{ a: 1, b: true, p: '2000', s: '0.5', r: false, t: { limit: { tif: 'Gtc' } } }],
    grouping: 'na',
  };

  it('passes when both builds agree, and refuses an L1 hash that differs (a changed order, as a poisoned build would make)', async () => {
    const good = l1TypedData(actionHash(action as MsgpackValue, null, 1700000000000n));
    await expect(assertSigningAgrees({ action, vaultAddress: null, nonce: '1700000000000', typedData: good })).resolves.toBeUndefined();
    // The wallet would sign this hash; the action sent would be a sell. The check refuses before either happens.
    const changed = { ...action, orders: [{ ...action.orders[0], b: false }] };
    await expect(
      assertSigningAgrees({ action: changed, vaultAddress: null, nonce: '1700000000000', typedData: good }),
    ).rejects.toBeInstanceOf(SigningCrossCheckError);
    // A different vault, or nonce, is a different hash too.
    await expect(
      assertSigningAgrees({ action, vaultAddress: '0x1111111111111111111111111111111111111111', nonce: '1700000000000', typedData: good }),
    ).rejects.toBeInstanceOf(SigningCrossCheckError);
    await expect(assertSigningAgrees({ action, vaultAddress: null, nonce: '1700000000001', typedData: good })).rejects.toBeInstanceOf(
      SigningCrossCheckError,
    );
  });

  it('refuses a user-signed withdrawal whose destination or amount differs between the action and the typed data', async () => {
    const fields = { destination: '0x2222222222222222222222222222222222222222', amount: '2' };
    const withdraw = {
      type: 'withdraw3',
      signatureChainId: '0x66eee',
      hyperliquidChain: 'Testnet',
      ...fields,
      time: 1700000000000,
    };
    const typed = userSignedTypedData('HyperliquidTransaction:Withdraw', USER_SIGNED_TYPES['HyperliquidTransaction:Withdraw'], {
      hyperliquidChain: 'Testnet',
      ...fields,
      time: 1700000000000n,
    });
    await expect(
      assertSigningAgrees({ action: withdraw, vaultAddress: null, nonce: '1700000000000', typedData: typed }),
    ).resolves.toBeUndefined();
    const elsewhere = { ...withdraw, destination: '0x3333333333333333333333333333333333333333' };
    await expect(assertSigningAgrees({ action: elsewhere, vaultAddress: null, nonce: '1700000000000', typedData: typed })).rejects.toThrow(
      /field destination differs/,
    );
    await expect(
      assertSigningAgrees({ action: { ...withdraw, amount: '200' }, vaultAddress: null, nonce: '1700000000000', typedData: typed }),
    ).rejects.toThrow(/field amount differs/);
  });
});
