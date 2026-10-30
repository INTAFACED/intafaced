import { createHash, type Hash } from 'node:crypto';
import { MiningError } from './errors.js';
import { POW_DIMENSION_MAX, POW_DIMENSION_MIN, POW_TARGET_BITS_MAX, publishedInt, publishedText } from './env.js';

export { POW_DIMENSION_MAX, POW_DIMENSION_MIN, POW_TARGET_BITS_MAX };

/**
 * The pool's own proof-of-work check for a share: a reference matrix-multiplication (MatMul) work function.
 *
 * The job header is derived here from the window, the account and the rig, never taken from the rig. The share's nonce
 * and that header seed two n×n matrices of 32-bit words; the pool multiplies them itself (wrapping at 2^32) and hashes
 * the header with the product. A share passes only when that hash has at least the published number of leading zero
 * bits. The target is the owner's published parameter, never a target the rig sends.
 *
 * This is the pool's validator port with a pure reference check. It is not the token's live proof of work, and nothing
 * here is audited (the audit is external). The parameters are owner settings with no default: blank refuses
 * `mining.pow_spec_unset`. Only a testnet parameter set is accepted; a mainnet one refuses `audit.external`.
 */

export const POW_SPEC_UNSET = 'mining.pow_spec_unset';
export const POW_INVALID = 'mining.pow_invalid';
export const POW_MISSING = 'mining.pow_missing';
/** A share with a proof of work is weighed by the pool, never by the rig. */
export const POW_WEIGHT_FROM_CLIENT = 'mining.pow_weight_from_client';
export const AUDIT_EXTERNAL = 'audit.external';
/** A testnet window earns no credit, whatever its shares. */
export const TESTNET_NO_CREDIT = 'mining.testnet_no_credit';

const NONCE = /^[0-9a-f]{1,16}$/;

export type PowSpec = { readonly dimension: number; readonly targetBits: number; readonly testnet: true };

/** The three settings, all blank: the pool has no proof-of-work definition. Shares are then not checked at all. */
export function powSpecBlank(env: NodeJS.ProcessEnv): boolean {
  return [env.MINING_POW_DIMENSION, env.MINING_POW_TARGET_BITS, env.MINING_POW_TESTNET].every(
    (raw) => publishedText(raw, 12, false) === null,
  );
}

/** The published parameters. Any blank or unusable value refuses `mining.pow_spec_unset`; a mainnet set refuses `audit.external`. */
export function readPowSpec(env: NodeJS.ProcessEnv): PowSpec {
  const dimension = publishedInt(env.MINING_POW_DIMENSION, POW_DIMENSION_MIN, POW_DIMENSION_MAX);
  const targetBits = publishedInt(env.MINING_POW_TARGET_BITS, 1, POW_TARGET_BITS_MAX);
  const network = publishedText(env.MINING_POW_TESTNET, 5, false);
  if (dimension === null || dimension === 'invalid' || targetBits === null || targetBits === 'invalid') {
    throw new MiningError('Proof-of-work parameters are not published', POW_SPEC_UNSET);
  }
  if (network === 'false') throw new MiningError('A mainnet proof of work waits for the external audit', AUDIT_EXTERNAL);
  if (network !== 'true') throw new MiningError('Proof-of-work network is not published', POW_SPEC_UNSET);
  return { dimension, targetBits, testnet: true };
}

/** The published set, or null when all three settings are blank. Anything else unusable refuses as `readPowSpec` does. */
export function publishedPowSpec(env: NodeJS.ProcessEnv): PowSpec | null {
  return powSpecBlank(env) ? null : readPowSpec(env);
}

/** Feeds each part to the hash behind its 4-byte length, so no two lists of parts feed the same bytes. */
export function hashLengthPrefixed(hash: Hash, parts: readonly string[]): Hash {
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash;
}

/** The job header the pool gives one rig in one window. Each field is length-prefixed, so no two triples collide. */
export function powHeader(windowId: string, minerId: string, workerName: string): Buffer {
  return hashLengthPrefixed(createHash('sha256').update('intafaced:mining:pow:v1'), [windowId, minerId, workerName]).digest();
}

function matrix(label: 'A' | 'B', header: Buffer, nonce: string, n: number): Uint32Array {
  const words = new Uint32Array(n * n);
  for (let block = 0; block * 8 < words.length; block += 1) {
    const digest = createHash('sha256').update(`${label}|`).update(header).update(`|${nonce}|${block}`).digest();
    for (let at = 0; at < 8 && block * 8 + at < words.length; at += 1) words[block * 8 + at] = digest.readUInt32LE(at * 4);
  }
  return words;
}

/** C = A × B over 32-bit words, wrapping at 2^32. */
export function matMul(a: Uint32Array, b: Uint32Array, n: number): Uint32Array {
  const c = new Uint32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let sum = 0;
      for (let k = 0; k < n; k += 1) sum = (sum + Math.imul(a[i * n + k]!, b[k * n + j]!)) >>> 0;
      c[i * n + j] = sum;
    }
  }
  return c;
}

function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** The work digest of one nonce: sha256(header ‖ A×B), the product written as little-endian words. */
export function powDigest(spec: Pick<PowSpec, 'dimension'>, header: Buffer, nonce: string): Buffer {
  const n = spec.dimension;
  const product = matMul(matrix('A', header, nonce, n), matrix('B', header, nonce, n), n);
  const bytes = Buffer.alloc(product.length * 4);
  product.forEach((word, at) => bytes.writeUInt32LE(word, at * 4));
  return createHash('sha256').update(header).update(bytes).digest();
}

/** True when the nonce's work meets the published target. A nonce that is not 1 to 16 lower-case hex digits never passes. */
export function powValid(spec: PowSpec, header: Buffer, nonce: unknown): nonce is string {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return false;
  return leadingZeroBits(powDigest(spec, header, nonce)) >= spec.targetBits;
}

/** The first nonce from `start` that meets the target (TEST submitters and tests only; a real rig does its own search). */
export function grindPow(spec: PowSpec, header: Buffer, start = 0): string {
  for (let at = start; at < start + 2 ** 24; at += 1) {
    const nonce = at.toString(16);
    if (powValid(spec, header, nonce)) return nonce;
  }
  throw new Error('no nonce met the target in 2^24 tries');
}

/** The first nonce from `start` that does not meet the target (an invalid share, for tests). */
export function failingPow(spec: PowSpec, header: Buffer, start = 0): string {
  for (let at = start; ; at += 1) {
    const nonce = at.toString(16);
    if (!powValid(spec, header, nonce)) return nonce;
  }
}
