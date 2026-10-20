/**
 * S-L3 residual — ERC-5564 scheme 1 (secp256k1 + view tags) off-chain.
 *
 * Recipients scan StealthAnnouncer logs with a viewing key. The service never
 * holds that key; this module is the library a wallet runs locally. There is
 * no user id, no profile handle, and no join from announcement → Fiat Plane.
 *
 * Hash-to-scalar is keccak256 of the SEC1 uncompressed shared point
 * (`0x04 || Sx || Sy`), reduced mod n — the encoding used by the scheme-1
 * implementations that pin the ERC's unspecified `h(s)`.
 *
 * `presentationAddress` (keccak of spending-key-id || ephemeral) is a separate
 * P0 unlinkable-presentation helper. It is not an ECDH match. Do not mix the two.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { STEALTH_SCHEME_ID } from './presentation.js';

/** ERC-5564 secp256k1. Same integer as `STEALTH_SCHEME_ID`. */
export const EIP5564_SECP256K1_SCHEME_ID = STEALTH_SCHEME_ID;

export type StealthMetaAddress = Hex;
export type StealthAnnouncement = {
  schemeId: bigint;
  stealthAddress: Address;
  ephemeralPubKey: Hex;
  metadata: Hex;
};

export type GeneratedStealthAddress = {
  schemeId: bigint;
  stealthAddress: Address;
  ephemeralPubKey: Hex;
  viewTag: number;
  metadata: Hex;
};

export type StealthScanHit = {
  stealthAddress: Address;
  ephemeralPubKey: Hex;
  viewTag: number;
};

const CURVE_N = secp256k1.Point.Fn.ORDER;
const COMPRESSED_PUB_LEN = 33;
const UNCOMPRESSED_PUB_LEN = 65;

function requirePriv(key: Hex): Uint8Array {
  const bytes = hexToBytes(key);
  if (bytes.length !== 32) throw new Error('stealth.bad_private_key');
  const n = BigInt(key);
  if (n === 0n || n >= CURVE_N) throw new Error('stealth.bad_private_key');
  return bytes;
}

function pointFromPub(pub: Hex) {
  const bytes = hexToBytes(pub);
  if (bytes.length !== COMPRESSED_PUB_LEN && bytes.length !== UNCOMPRESSED_PUB_LEN) {
    throw new Error('stealth.bad_public_key');
  }
  return secp256k1.Point.fromBytes(bytes);
}

function compressPub(pub: Hex): Hex {
  return bytesToHex(pointFromPub(pub).toBytes(true));
}

function hashSharedPoint(uncompressed: Uint8Array): { scalar: bigint; viewTag: number } {
  if (uncompressed.length !== UNCOMPRESSED_PUB_LEN || uncompressed[0] !== 0x04) {
    throw new Error('stealth.bad_shared_secret');
  }
  const digest = keccak256(bytesToHex(uncompressed));
  const viewTag = Number.parseInt(digest.slice(2, 4), 16);
  const scalar = BigInt(digest) % CURVE_N;
  if (scalar === 0n) throw new Error('stealth.hash_to_zero');
  return { scalar, viewTag };
}

function sharedFromPrivAndPub(priv: Uint8Array, pub: Hex): Uint8Array {
  return secp256k1.getSharedSecret(priv, hexToBytes(compressPub(pub)), false);
}

function stealthFromSpendAndScalar(spendingPub: Hex, scalar: bigint): Address {
  const stealth = pointFromPub(spendingPub).add(secp256k1.Point.BASE.multiply(scalar));
  return publicKeyToAddress(bytesToHex(stealth.toBytes(false)));
}

function viewTagFromMetadata(metadata: Hex): number | null {
  const bytes = hexToBytes(metadata);
  return bytes.length === 0 ? null : bytes[0]!;
}

/** Compressed spending pub || compressed viewing pub (66 bytes), or 33 bytes when they are the same key. */
export function stealthMetaAddress(spendingPub: Hex, viewingPub: Hex): StealthMetaAddress {
  const spend = hexToBytes(compressPub(spendingPub));
  const view = hexToBytes(compressPub(viewingPub));
  const out = new Uint8Array(spend.length + view.length);
  out.set(spend, 0);
  out.set(view, spend.length);
  return bytesToHex(out);
}

export function parseStealthMetaAddress(meta: StealthMetaAddress): { spendingPub: Hex; viewingPub: Hex } {
  const bytes = hexToBytes(meta);
  if (bytes.length === COMPRESSED_PUB_LEN) {
    const pub = bytesToHex(bytes);
    return { spendingPub: pub, viewingPub: pub };
  }
  if (bytes.length === COMPRESSED_PUB_LEN * 2) {
    return {
      spendingPub: bytesToHex(bytes.slice(0, COMPRESSED_PUB_LEN)),
      viewingPub: bytesToHex(bytes.slice(COMPRESSED_PUB_LEN)),
    };
  }
  throw new Error('stealth.bad_meta_address');
}

export function publicKeyFromPrivate(privateKey: Hex, compressed = true): Hex {
  return bytesToHex(secp256k1.getPublicKey(requirePriv(privateKey), compressed));
}

export function generateStealthAddress(meta: StealthMetaAddress, ephemeralPrivateKey?: Hex): GeneratedStealthAddress {
  const { spendingPub, viewingPub } = parseStealthMetaAddress(meta);
  const ephPriv = ephemeralPrivateKey ? requirePriv(ephemeralPrivateKey) : secp256k1.utils.randomSecretKey();
  const ephemeralPubKey = bytesToHex(secp256k1.getPublicKey(ephPriv, true));
  const { scalar, viewTag } = hashSharedPoint(sharedFromPrivAndPub(ephPriv, viewingPub));
  const stealthAddress = stealthFromSpendAndScalar(spendingPub, scalar);
  return {
    schemeId: EIP5564_SECP256K1_SCHEME_ID,
    stealthAddress,
    ephemeralPubKey,
    viewTag,
    metadata: bytesToHex(Uint8Array.of(viewTag)),
  };
}

export function checkStealthAddress(announcement: StealthAnnouncement, viewingPrivateKey: Hex, spendingPub: Hex): boolean {
  if (announcement.schemeId !== EIP5564_SECP256K1_SCHEME_ID) return false;
  let shared: Uint8Array;
  try {
    shared = sharedFromPrivAndPub(requirePriv(viewingPrivateKey), announcement.ephemeralPubKey);
  } catch {
    return false;
  }
  const { scalar, viewTag } = hashSharedPoint(shared);
  const announcedTag = viewTagFromMetadata(announcement.metadata);
  if (announcedTag !== null && announcedTag !== viewTag) return false;
  return stealthFromSpendAndScalar(spendingPub, scalar).toLowerCase() === announcement.stealthAddress.toLowerCase();
}

/**
 * Scan announcer logs. Aggregate-only: the result is stealth addresses the
 * viewing key recognises, never a user id.
 */
export function scanAnnouncements(
  announcements: readonly StealthAnnouncement[],
  viewingPrivateKey: Hex,
  spendingPub: Hex,
): StealthScanHit[] {
  const hits: StealthScanHit[] = [];
  for (const announcement of announcements) {
    if (!checkStealthAddress(announcement, viewingPrivateKey, spendingPub)) continue;
    hits.push({
      stealthAddress: announcement.stealthAddress,
      ephemeralPubKey: announcement.ephemeralPubKey,
      viewTag: viewTagFromMetadata(announcement.metadata) ?? 0,
    });
  }
  return hits;
}

export function computeStealthKey(announcement: StealthAnnouncement, viewingPrivateKey: Hex, spendingPrivateKey: Hex): Hex {
  if (!checkStealthAddress(announcement, viewingPrivateKey, publicKeyFromPrivate(spendingPrivateKey))) {
    throw new Error('stealth.not_for_viewer');
  }
  const { scalar } = hashSharedPoint(sharedFromPrivAndPub(requirePriv(viewingPrivateKey), announcement.ephemeralPubKey));
  const stealth = (BigInt(spendingPrivateKey) + scalar) % CURVE_N;
  return `0x${stealth.toString(16).padStart(64, '0')}` as Hex;
}
