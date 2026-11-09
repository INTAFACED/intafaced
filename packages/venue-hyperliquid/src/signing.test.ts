import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, hashTypedData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeMsgpack, MsgpackEncodeError, type MsgpackValue } from './msgpack.js';
import {
  actionHash,
  assertTestnetChain,
  assertTestnetUrl,
  HyperliquidNetworkRefusedError,
  l1TypedData,
  L1_DOMAIN,
  L1_TYPES,
  recoverTypedDataSigner,
  splitSignature,
  flatTypedDataDigest,
  userSignedTypedData,
  usdSendAction,
  usdClassTransferAction,
  typedDataDigest,
  USER_SIGNED_TYPES,
  type Eip712Field,
  type HlTypedData,
} from './signing.js';

/**
 * Hyperliquid's own published signing vectors (the official Python SDK's
 * tests/signing_test.py, pinned commit in the fixture).
 *
 * No key is stored. Each vector is checked by recovering the SDK test key's
 * address from the SDK's own published signature over the digest WE compute:
 * one byte different in the msgpack, the nonce, the vault flag or the typed
 * data gives a different digest, and the recovered address no longer matches.
 */
interface Sig {
  r: string;
  s: string;
  v: number;
}
interface Vectors {
  source: string;
  signerAddress: string;
  phantomAgent: { action: MsgpackValue; nonce: number; vaultAddress: string | null; connectionIdMainnet: string };
  l1: { test: string; action: MsgpackValue; nonce: number; vaultAddress: string | null; mainnet: Sig; testnet: Sig }[];
  userSigned: {
    test: string;
    primaryType: string;
    hyperliquidChain: string;
    signatureChainId: string;
    types: Eip712Field[];
    message: Record<string, string | number>;
    signature: Sig;
  }[];
}

const vectors = JSON.parse(readFileSync(new URL('./fixtures/hl-python-sdk-signing-vectors.json', import.meta.url), 'utf8')) as Vectors;

/** The SDK prints r and s with leading zeros dropped: pad them back to 32 bytes. */
function joinSig(sig: Sig): Hex {
  const word = (h: string) => BigInt(h).toString(16).padStart(64, '0');
  return `0x${word(sig.r)}${word(sig.s)}${sig.v.toString(16)}` as Hex;
}

async function expectSdkSigned(typed: HlTypedData, sig: Sig): Promise<void> {
  const signature = joinSig(sig);
  expect(splitSignature(signature).v).toBe(sig.v);
  expect(await recoverTypedDataSigner(typed, signature)).toBe(vectors.signerAddress);
}

describe('Hyperliquid signing vectors (official Python SDK)', () => {
  it('the fixture names its source and holds no key', () => {
    expect(vectors.source).toMatch(
      /^https:\/\/github\.com\/hyperliquid-dex\/hyperliquid-python-sdk\/blob\/[0-9a-f]{40}\/tests\/signing_test\.py$/,
    );
    expect(vectors.signerAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(Object.keys(vectors)).not.toContain('privateKey');
  });

  it('phantom agent: the connection id matches production', () => {
    const v = vectors.phantomAgent;
    expect(actionHash(v.action, v.vaultAddress, BigInt(v.nonce))).toBe(v.connectionIdMainnet);
  });

  for (const v of vectors.l1) {
    it(`L1 testnet signature: ${v.test}`, async () => {
      const typed = l1TypedData(actionHash(v.action, v.vaultAddress, BigInt(v.nonce)));
      expect(typed.message.source).toBe('b');
      await expectSdkSigned(typed, v.testnet);
    });

    // The mainnet vector proves the same hash under source "a". The adapter itself refuses "a" (below), so the typed
    // data is built here by hand and never reaches the venue.
    it(`L1 hash, checked by its mainnet vector too: ${v.test}`, async () => {
      const connectionId = actionHash(v.action, v.vaultAddress, BigInt(v.nonce));
      await expectSdkSigned(
        { domain: L1_DOMAIN, types: L1_TYPES, primaryType: 'Agent', message: { source: 'a', connectionId } },
        v.mainnet,
      );
    });
  }

  for (const v of vectors.userSigned) {
    it(`user-signed testnet signature: ${v.test}`, async () => {
      const message: Record<string, string | bigint> = { hyperliquidChain: v.hyperliquidChain };
      for (const [k, value] of Object.entries(v.message)) message[k] = typeof value === 'number' ? BigInt(value) : value;
      const typed = userSignedTypedData(v.primaryType, v.types, message, v.signatureChainId);
      expect(typed.domain.chainId).toBe(421614);
      await expectSdkSigned(typed, v.signature);
    });
  }

  it('usdSendAction builds the bytes the SDK signed for test_sign_usd_transfer_action (testnet, Arbitrum Sepolia)', async () => {
    const v = vectors.userSigned.find((u) => u.test === 'test_sign_usd_transfer_action')!;
    const { action, typedData } = usdSendAction(String(v.message.destination), String(v.message.amount), BigInt(v.message.time!));
    expect(typedData.message.hyperliquidChain).toBe('Testnet');
    expect(typedData.domain.chainId).toBe(421614);
    expect(typedData.types[typedData.primaryType]).toEqual(USER_SIGNED_TYPES['HyperliquidTransaction:UsdSend']);
    expect(action).toEqual({
      type: 'usdSend',
      signatureChainId: '0x66eee',
      hyperliquidChain: 'Testnet',
      destination: v.message.destination,
      amount: '1',
      time: v.message.time,
    });
    await expectSdkSigned(typedData, v.signature);
  });

  it('usdSendAction refuses a zero or malformed amount and a bad destination', () => {
    expect(() => usdSendAction('0x5e9ee1089755c3435139848e47e6635505d5a13a', '0', 1n)).toThrow(/positive/);
    expect(() => usdSendAction('0x5e9ee1089755c3435139848e47e6635505d5a13a', '1e3', 1n)).toThrow(/positive/);
    expect(() => usdSendAction('0x5e9e', '1', 1n)).toThrow(/not an address/);
  });

  // usdClassTransfer: the SDK's signing_test.py at the pinned commit has no vector for it, so its digest is checked
  // against EIP-712 written out by hand here (type string, domain and struct, with `bool` as a 32-byte word), and a
  // signature from a TEST key round-trips. The SDK's own code (exchange.py `usd_class_transfer`,
  // signing.py `USD_CLASS_TRANSFER_SIGN_TYPES`) is what the types and the action's fields follow.
  it('usdClassTransferAction: the SDK fields and types, and a digest equal to EIP-712 encoded by hand', async () => {
    const { action, typedData } = usdClassTransferAction('12.5', true, 1_700_000_000_123n);
    expect(action).toEqual({
      type: 'usdClassTransfer',
      signatureChainId: '0x66eee',
      hyperliquidChain: 'Testnet',
      amount: '12.5',
      toPerp: true,
      nonce: 1_700_000_000_123,
    });
    expect(typedData.primaryType).toBe('HyperliquidTransaction:UsdClassTransfer');
    expect(typedData.types[typedData.primaryType]).toEqual([
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' },
      { name: 'nonce', type: 'uint64' },
    ]);
    const word = (types: string[], values: unknown[]) =>
      keccak256(
        encodeAbiParameters(
          types.map((type) => ({ type })),
          values as never,
        ),
      );
    const domain = word(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toHex('HyperliquidSignTransaction')),
        keccak256(toHex('1')),
        421614n,
        '0x0000000000000000000000000000000000000000',
      ],
    );
    const struct = word(
      ['bytes32', 'bytes32', 'bytes32', 'bool', 'uint256'],
      [
        keccak256(toHex('HyperliquidTransaction:UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)')),
        keccak256(toHex('Testnet')),
        keccak256(toHex('12.5')),
        true,
        1_700_000_000_123n,
      ],
    );
    expect(typedDataDigest(typedData)).toBe(keccak256(concat(['0x1901', domain, struct])));
    // toPerp is in the signed bytes: flipping it is a different digest.
    expect(typedDataDigest(usdClassTransferAction('12.5', false, 1_700_000_000_123n).typedData)).not.toBe(typedDataDigest(typedData));
    // A TEST key (derived from a label, never a real key) signs the digest and is recovered from it.
    const key = keccak256(toHex('intafaced TEST usdClassTransfer'));
    const signer = privateKeyToAccount(key);
    const signature = await signer.sign({ hash: typedDataDigest(typedData) });
    expect(await recoverTypedDataSigner(typedData, signature)).toBe(signer.address.toLowerCase());
  });

  it('usdClassTransferAction refuses a zero or malformed amount', () => {
    expect(() => usdClassTransferAction('0', true, 1n)).toThrow(/positive/);
    expect(() => usdClassTransferAction('-1', false, 1n)).toThrow(/positive/);
    expect(() => usdClassTransferAction('1e3', false, 1n)).toThrow(/positive/);
  });

  it('a vector checked against the wrong digest does not recover the SDK key (the check can fail)', async () => {
    const v = vectors.l1[0]!;
    const wrong = l1TypedData(actionHash(v.action, v.vaultAddress, BigInt(v.nonce) + 1n));
    expect(await recoverTypedDataSigner(wrong, joinSig(v.testnet))).not.toBe(vectors.signerAddress);
  });
});

describe('mainnet is refused', () => {
  it('a mainnet or any other base URL is refused', () => {
    expect(() => assertTestnetUrl('https://api.hyperliquid.xyz')).toThrow(HyperliquidNetworkRefusedError);
    expect(() => assertTestnetUrl('https://api.hyperliquid-testnet.xyz.evil.example')).toThrow(HyperliquidNetworkRefusedError);
    expect(() => assertTestnetUrl('http://api.hyperliquid-testnet.xyz')).toThrow(HyperliquidNetworkRefusedError);
    expect(assertTestnetUrl('https://api.hyperliquid-testnet.xyz/')).toBe('https://api.hyperliquid-testnet.xyz');
  });

  it('hyperliquidChain "Mainnet" is refused, typed', () => {
    expect(() => assertTestnetChain('Mainnet')).toThrow(HyperliquidNetworkRefusedError);
    try {
      userSignedTypedData('HyperliquidTransaction:Withdraw', vectors.userSigned[1]!.types, {
        hyperliquidChain: 'Mainnet',
        destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a',
        amount: '1',
        time: 1n,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HyperliquidNetworkRefusedError);
      expect((error as HyperliquidNetworkRefusedError).code).toBe('mainnet_refused');
    }
  });

  it('the phantom agent source "a" (mainnet) is refused', () => {
    expect(() => l1TypedData(toHex(new Uint8Array(32)), 'a')).toThrow(HyperliquidNetworkRefusedError);
  });
});

describe('msgpack encoder', () => {
  it('writes the smallest integer forms msgpack-python writes', () => {
    const hex = (v: MsgpackValue) => toHex(encodeMsgpack(v));
    expect(hex(0)).toBe('0x00');
    expect(hex(127)).toBe('0x7f');
    expect(hex(128)).toBe('0xcc80');
    expect(hex(256)).toBe('0xcd0100');
    expect(hex(65536)).toBe('0xce00010000');
    expect(hex(100000000000)).toBe('0xcf000000174876e800');
    expect(hex(-1)).toBe('0xff');
    expect(hex(-33)).toBe('0xd0df');
    expect(hex(-129)).toBe('0xd1ff7f');
    expect(hex(18446744073709551615n)).toBe('0xcfffffffffffffffff');
  });

  it('writes strings, arrays and maps in insertion order', () => {
    expect(toHex(encodeMsgpack({ b: 1, a: 'x' }))).toBe('0x82a16201a161a178');
    expect(toHex(encodeMsgpack('a'.repeat(32)))).toBe(`0xd920${'61'.repeat(32)}`);
    expect(toHex(encodeMsgpack([null, true, false]))).toBe('0x93c0c3c2');
  });

  it('refuses floats, unsafe integers, integer-like keys and non-plain values', () => {
    expect(() => encodeMsgpack(1.5)).toThrow(MsgpackEncodeError);
    expect(() => encodeMsgpack(2 ** 60)).toThrow(MsgpackEncodeError);
    expect(() => encodeMsgpack({ '1': 1 })).toThrow(MsgpackEncodeError);
    expect(() => encodeMsgpack(new Date(0) as unknown as MsgpackValue)).toThrow(MsgpackEncodeError);
    expect(() => encodeMsgpack(undefined as unknown as MsgpackValue)).toThrow(MsgpackEncodeError);
  });

  it('the written-out EIP-712 digest equals viem on the L1 struct', () => {
    const typed = l1TypedData(actionHash({ type: 'dummy', num: 1 }, null, 7n));
    expect(flatTypedDataDigest(typed.domain, 'Agent', typed.types.Agent, typed.message)).toBe(hashTypedData(typed));
  });

  it('key order changes the hash (why insertion order matters)', () => {
    const a = actionHash({ type: 'dummy', num: 1 }, null, 0n);
    const b = actionHash({ num: 1, type: 'dummy' }, null, 0n);
    expect(a).not.toBe(b);
    expect(hashTypedData(l1TypedData(a))).not.toBe(hashTypedData(l1TypedData(b)));
  });
});
