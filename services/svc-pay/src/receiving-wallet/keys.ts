import { HDKey, publicKeyToAddress } from 'viem/accounts';
import { MerchantOpsError } from '../merchant-ops/errors.js';

/**
 * A business's own receiving wallet, given as its extended public key (J-merchant-04, launch money model, OWNER 226).
 *
 * We derive one receiving address per payment from the key, on the wallet's external chain (`<key>/0/<index>`, the BIP-44
 * account layout every EVM wallet exports), so a payment is told apart on the chain by its own address while the business
 * alone holds the private key. A private key is refused before anything is stored: with it we could move the money, and
 * at launch nobody here may.
 */

/** secp256k1's field prime. */
const P = 2n ** 256n - 2n ** 32n - 977n;

const mod = (a: bigint) => ((a % P) + P) % P;
function powMod(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

/** The uncompressed point of a compressed secp256k1 public key (y² = x³ + 7), as `0x04…`. */
export function uncompressedPublicKey(compressed: Uint8Array): `0x04${string}` {
  if (compressed.length !== 33 || (compressed[0] !== 2 && compressed[0] !== 3)) throw new Error('not a compressed public key');
  const x = BigInt(`0x${Buffer.from(compressed.subarray(1)).toString('hex')}`);
  const rhs = mod(x ** 3n + 7n);
  let y = powMod(rhs, (P + 1n) / 4n);
  if (powMod(y, 2n) !== rhs) throw new Error('not a point on the curve');
  if ((y & 1n) !== BigInt(compressed[0]! & 1)) y = P - y;
  return `0x04${x.toString(16).padStart(64, '0')}${y.toString(16).padStart(64, '0')}`;
}

/**
 * The extended public key, read strictly: a private key refuses `pay.receiving_wallet_private_key`; anything that does
 * not read as an extended public key (bad checksum, wrong length) refuses `pay.receiving_wallet_invalid`.
 */
export function readExtendedPublicKey(raw: string): HDKey {
  const text = raw.trim();
  if (/^[xyzt]prv/i.test(text)) throw new MerchantOpsError('pay.receiving_wallet_private_key', 'bad_request');
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(text);
  } catch {
    throw new MerchantOpsError('pay.receiving_wallet_invalid', 'bad_request');
  }
  if (key.privateKey) throw new MerchantOpsError('pay.receiving_wallet_private_key', 'bad_request');
  if (!key.publicKey) throw new MerchantOpsError('pay.receiving_wallet_invalid', 'bad_request');
  return key;
}

/** The receiving address at `index` on the key's external chain, checksummed. */
export function receivingAddress(key: HDKey, index: number): `0x${string}` {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) throw new Error('child index out of range');
  const child = key.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error('no public key at that index');
  return publicKeyToAddress(uncompressedPublicKey(child.publicKey));
}
