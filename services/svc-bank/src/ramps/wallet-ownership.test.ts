import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { memoryWithdrawDestinations } from '../withdraw-destination.js';
import {
  memoryWalletProofs,
  ownershipOf,
  proofMessage,
  recoverPersonalSignAddress,
  startWalletProof,
  verifyWalletProof,
  type WalletProofDeps,
} from './wallet-ownership.js';

/** W-withdraw-17: proving a saved wallet by signing a message. */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
// Well-known public development keys (the first two accounts of common local EVM chains). They hold nothing; TEST only.
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const STRANGER_KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const encoder = new TextEncoder();

/** What a wallet's `personal_sign` returns: the EIP-191 digest signed, as `r || s || v` with v 27/28. */
function personalSign(message: string, keyHex: string): string {
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const recovered = secp256k1.sign(keccak_256(joined), Buffer.from(keyHex, 'hex'), { prehash: false, format: 'recovered' });
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1), 0);
  out[64] = recovered[0]! + 27;
  return `0x${Buffer.from(out).toString('hex')}`;
}

/** The same signature with v written 0/1, as some wallets return it. */
const withLowV = (sig: string) => `${sig.slice(0, 130)}${(Number.parseInt(sig.slice(130), 16) - 27).toString(16).padStart(2, '0')}`;

function rig(over: Partial<WalletProofDeps> = {}) {
  let now = new Date('2026-10-23T10:00:00.000Z');
  const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5' });
  const deps: WalletProofDeps = {
    destinations,
    proofs: memoryWalletProofs(),
    windowRaw: () => '30',
    validityRaw: () => '180',
    now: () => now,
    ...over,
  };
  return {
    deps,
    destinations,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    save: (ref = KEY_ADDRESS, userId = USER) =>
      destinations.save({ userId, assetId: 'USDT', network: 'erc20', ref, label: `TEST ${ref.slice(-4)}` }),
  };
}

describe('recoverPersonalSignAddress', () => {
  it('recovers the signer of an independent test vector (made with another EVM library)', () => {
    const signature =
      '0x9b3af850907666f6c0672b1a2da3be092826caf4f4b7dc07e779717088a1bd5e43d05c9f345c22e271108a2b31edd49c1c81d6f7036f52d48dcf594961288de21b';
    expect(recoverPersonalSignAddress('INTAFACED wallet proof TEST vector', signature)).toBe(KEY_ADDRESS);
    expect(personalSign('INTAFACED wallet proof TEST vector', KEY)).toBe(signature);
  });

  it('takes v as 0/1 too, and answers another address for another message', () => {
    const sig = personalSign('one', KEY);
    expect(recoverPersonalSignAddress('one', withLowV(sig))).toBe(KEY_ADDRESS);
    expect(recoverPersonalSignAddress('two', sig)).not.toBe(KEY_ADDRESS);
  });

  it('answers null for anything that is not a 65-byte signature', () => {
    const sig = personalSign('m', KEY);
    for (const bad of ['', '0x', 'hello', `0x${'00'.repeat(65)}`, `0x${'ab'.repeat(64)}`, `${sig}00`, `${sig.slice(0, 130)}1d`]) {
      expect(recoverPersonalSignAddress('m', bad)).toBeNull();
    }
  });
});

describe('ownershipOf', () => {
  const base = {
    id: 'p',
    userId: USER,
    destinationId: 'd',
    address: KEY_ADDRESS,
    message: 'm',
    createdAt: new Date('2026-10-23T10:00:00Z'),
    expiresAt: new Date('2026-10-23T10:30:00Z'),
    verifiedAt: null,
    validUntil: null,
    signature: null,
  };

  it('reads none, pending, verified and expired', () => {
    expect(ownershipOf(undefined, new Date()).state).toBe('none');
    expect(ownershipOf({ ...base, status: 'pending' }, new Date('2026-10-23T10:10:00Z')).state).toBe('pending');
    expect(ownershipOf({ ...base, status: 'pending' }, new Date('2026-10-23T10:30:00Z')).state).toBe('expired');
    const verified = {
      ...base,
      status: 'verified' as const,
      verifiedAt: base.createdAt,
      validUntil: new Date('2026-11-01T00:00:00Z'),
      signature: '0x',
    };
    expect(ownershipOf(verified, new Date('2026-10-30T00:00:00Z'))).toMatchObject({
      state: 'verified',
      validUntil: '2026-11-01T00:00:00.000Z',
    });
    expect(ownershipOf(verified, new Date('2026-11-01T00:00:00Z')).state).toBe('expired');
  });
});

describe('startWalletProof and verifyWalletProof', () => {
  it('offers a message naming the address and the proof, then verifies the saved address signing it', async () => {
    const r = rig();
    const entry = await r.save();
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    expect(started.message).toBe(proofMessage(KEY_ADDRESS, started.proofId, new Date(started.expiresAt)));
    expect(started.message).toContain(KEY_ADDRESS);
    expect(started.message).toContain(started.proofId);
    expect(started.message).toMatch(/moves no funds/);
    expect(started.expiresAt).toBe('2026-10-23T10:30:00.000Z');
    expect((await r.deps.proofs.latest(USER)).get(entry.destinationId)?.status).toBe('pending');

    r.advance(60_000);
    const done = await verifyWalletProof(r.deps, {
      userId: USER,
      proofId: started.proofId,
      signature: personalSign(started.message, KEY),
    });
    expect(done).toMatchObject({
      state: 'verified',
      verifiedAt: '2026-10-23T10:01:00.000Z',
      validUntil: '2027-04-21T10:01:00.000Z',
    });
  });

  it('refuses another signer by name and keeps the offer open, so the right wallet can still sign', async () => {
    const r = rig();
    const entry = await r.save();
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    await expect(
      verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: personalSign(started.message, STRANGER_KEY) }),
    ).rejects.toMatchObject({ code: 'bank.wallet_proof_wrong_signer', message: expect.stringMatching(/0x7099…79c8.*0xf39f…2266/) });
    expect((await r.deps.proofs.latest(USER)).get(entry.destinationId)?.status).toBe('pending');
    await expect(
      verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: personalSign(started.message, KEY) }),
    ).resolves.toMatchObject({ state: 'verified' });
  });

  it('refuses a signature of other text, and text that is not a signature', async () => {
    const r = rig();
    const entry = await r.save();
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    await expect(
      verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: personalSign('something else', KEY) }),
    ).rejects.toMatchObject({ code: 'bank.wallet_proof_wrong_signer' });
    await expect(verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: 'not a signature' })).rejects.toMatchObject(
      { code: 'bank.wallet_proof_signature_invalid' },
    );
  });

  it('refuses a lapsed offer and records nothing', async () => {
    const r = rig();
    const entry = await r.save();
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    r.advance(30 * 60_000);
    await expect(
      verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: personalSign(started.message, KEY) }),
    ).rejects.toMatchObject({ code: 'bank.wallet_proof_expired' });
    const latest = (await r.deps.proofs.latest(USER)).get(entry.destinationId);
    expect(latest?.status).toBe('pending');
    expect(ownershipOf(latest, new Date('2026-10-23T10:30:00Z')).state).toBe('expired');
  });

  it("does not find another customer's entry or proof", async () => {
    const r = rig();
    const entry = await r.save();
    await expect(startWalletProof(r.deps, { userId: OTHER, destinationId: entry.destinationId })).rejects.toMatchObject({
      code: 'bank.wallet_proof_not_found',
    });
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    await expect(
      verifyWalletProof(r.deps, { userId: OTHER, proofId: started.proofId, signature: personalSign(started.message, KEY) }),
    ).rejects.toMatchObject({ code: 'bank.wallet_proof_not_found' });
  });

  it('proves only a saved wallet entry, not the legacy bank slot', async () => {
    const r = rig();
    const bank = await r.destinations.persist({ userId: USER, kind: 'bank', ref: 'DE89370400440532013000' });
    await expect(startWalletProof(r.deps, { userId: USER, destinationId: bank.destinationId })).rejects.toMatchObject({
      code: 'bank.wallet_proof_not_found',
    });
  });

  it('answers the same signature again with the same proof, and refuses a different one', async () => {
    const r = rig();
    const entry = await r.save();
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    const signature = personalSign(started.message, KEY);
    const first = await verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature });
    r.advance(31 * 60_000);
    expect(
      await verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: `0x${signature.slice(2).toUpperCase()}` }),
    ).toEqual(first);
    await expect(
      verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: withLowV(signature) }),
    ).rejects.toMatchObject({ code: 'bank.wallet_proof_conflict' });
  });

  it.each([
    ['window', { windowRaw: () => undefined }, 'bank.wallet_proof_window_unset'],
    ['window as zero', { windowRaw: () => '0' }, 'bank.wallet_proof_window_unset'],
    ['validity', { validityRaw: () => ' ' }, 'bank.wallet_proof_validity_unset'],
    ['validity as a fraction', { validityRaw: () => '1.5' }, 'bank.wallet_proof_validity_unset'],
  ] as const)('refuses to offer a proof while the owner %s is blank, and stores nothing', async (_name, over, code) => {
    const r = rig(over);
    const entry = await r.save();
    await expect(startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId })).rejects.toMatchObject({ code });
    expect((await r.deps.proofs.latest(USER)).size).toBe(0);
  });

  it('refuses to verify when the validity was unpublished after the offer, and leaves it pending', async () => {
    let validity: string | undefined = '180';
    const r = rig({ validityRaw: () => validity });
    const entry = await r.save();
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    validity = undefined;
    await expect(
      verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: personalSign(started.message, KEY) }),
    ).rejects.toMatchObject({ code: 'bank.wallet_proof_validity_unset' });
    expect((await r.deps.proofs.latest(USER)).get(entry.destinationId)?.status).toBe('pending');
  });

  it('refuses a proof whose entry was removed', async () => {
    const r = rig();
    const entry = await r.save();
    const started = await startWalletProof(r.deps, { userId: USER, destinationId: entry.destinationId });
    await r.destinations.remove({ userId: USER, destinationId: entry.destinationId, idempotencyKey: 'rm' });
    await expect(
      verifyWalletProof(r.deps, { userId: USER, proofId: started.proofId, signature: personalSign(started.message, KEY) }),
    ).rejects.toMatchObject({ code: 'bank.wallet_proof_not_found' });
  });
});
