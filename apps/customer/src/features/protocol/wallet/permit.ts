/**
 * A token allowance by signature (EIP-2612 `permit`), built from what the token itself publishes. The token's signing
 * domain (EIP-5267 `eip712Domain()`), its decimals and the owner's next nonce are read through the person's own wallet
 * (`eth_call`), because the platform publishes no node for this network. Nothing here is invented: a token that does not
 * publish its domain, or publishes one for another chain or contract, is refused before any sheet or wallet prompt.
 */
import { ADDRESS, type TypedDataDocument } from './eip1193';

export const SELECTOR = {
  decimals: '0x313ce567',
  eip712Domain: '0x84b0196e',
  nonces: '0x7ecebe00',
} as const;

export type PermitRefusal =
  | 'token_invalid'
  | 'spender_invalid'
  | 'amount_invalid'
  | 'amount_precision'
  | 'expiry_invalid'
  | 'domain_missing'
  | 'domain_mismatch'
  | 'decimals_invalid'
  | 'nonce_invalid';

export class PermitRefused extends Error {
  constructor(readonly code: PermitRefusal) {
    super(code);
  }
}

export interface PermitDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

const WORD = 64;
function words(hex: string): string {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new PermitRefused('domain_missing');
  return hex.slice(2);
}
function word(body: string, index: number): string {
  const slice = body.slice(index * WORD, (index + 1) * WORD);
  if (slice.length !== WORD) throw new PermitRefused('domain_missing');
  return slice;
}
function uint(body: string, index: number): bigint {
  return BigInt(`0x${word(body, index)}`);
}
function dynString(body: string, offset: bigint): string {
  const start = Number(offset) * 2;
  const lengthHex = body.slice(start, start + WORD);
  if (lengthHex.length !== WORD) throw new PermitRefused('domain_missing');
  const length = Number(BigInt(`0x${lengthHex}`));
  const data = body.slice(start + WORD, start + WORD + length * 2);
  if (data.length !== length * 2) throw new PermitRefused('domain_missing');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Number.parseInt(data.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PermitRefused('domain_missing');
  }
}

/**
 * Decodes the EIP-5267 answer `(bytes1 fields, string name, string version, uint256 chainId, address verifyingContract,
 * bytes32 salt, uint256[] extensions)`. A permit domain declares exactly name, version, chainId and verifyingContract
 * (fields 0x0f); anything else is refused rather than guessed.
 */
export function decodeDomain(result: string): PermitDomain {
  const body = words(result);
  const fields = Number.parseInt(word(body, 0).slice(0, 2), 16);
  if (fields !== 0x0f) throw new PermitRefused('domain_missing');
  const chain = uint(body, 3);
  if (chain <= 0n || chain > BigInt(Number.MAX_SAFE_INTEGER)) throw new PermitRefused('domain_missing');
  const contractWord = word(body, 4);
  if (!/^0{24}/.test(contractWord)) throw new PermitRefused('domain_missing');
  return {
    name: dynString(body, uint(body, 1)),
    version: dynString(body, uint(body, 2)),
    chainId: Number(chain),
    verifyingContract: `0x${contractWord.slice(24)}`,
  };
}

export function decodeDecimals(result: string): number {
  let value: bigint;
  try {
    value = uint(words(result), 0);
  } catch {
    throw new PermitRefused('decimals_invalid');
  }
  if (value > 18n) throw new PermitRefused('decimals_invalid');
  return Number(value);
}

export function decodeNonce(result: string): bigint {
  try {
    return uint(words(result), 0);
  } catch {
    throw new PermitRefused('nonce_invalid');
  }
}

export function noncesCall(owner: string): string {
  return `${SELECTOR.nonces}${owner.slice(2).toLowerCase().padStart(WORD, '0')}`;
}

const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/** A decimal string of whole tokens in the token's own base units. More decimals than the token has is refused, never rounded. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const match = AMOUNT.exec(amount.trim());
  if (!match) throw new PermitRefused('amount_invalid');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) throw new PermitRefused('amount_precision');
  const units = BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units <= 0n) throw new PermitRefused('amount_invalid');
  // A permit value is a uint256.
  if (units >= 2n ** 256n) throw new PermitRefused('amount_invalid');
  return units;
}

export interface PermitInput {
  owner: string;
  token: string;
  spender: string;
  amount: string;
  /** Minutes from `now` until the signature stops working. */
  expiresInMinutes: string;
}

export function checkPermitInput(input: PermitInput): PermitRefusal | null {
  if (!ADDRESS.test(input.token.trim())) return 'token_invalid';
  if (!ADDRESS.test(input.spender.trim())) return 'spender_invalid';
  const amount = AMOUNT.exec(input.amount.trim());
  if (!amount || !/[1-9]/.test(input.amount)) return 'amount_invalid';
  if (!/^[1-9]\d{0,5}$/.test(input.expiresInMinutes.trim())) return 'expiry_invalid';
  return null;
}

/** The exact EIP-2612 document the wallet signs. The domain is the token's own, checked against the token and the chain. */
export function buildPermit(
  input: PermitInput,
  read: { domain: PermitDomain; decimals: number; nonce: bigint },
  chainId: number,
  now: Date,
): TypedDataDocument {
  const token = input.token.trim().toLowerCase();
  if (read.domain.chainId !== chainId || read.domain.verifyingContract.toLowerCase() !== token) throw new PermitRefused('domain_mismatch');
  const deadline = BigInt(Math.floor(now.getTime() / 1000)) + BigInt(input.expiresInMinutes.trim()) * 60n;
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: { name: read.domain.name, version: read.domain.version, chainId, verifyingContract: token },
    message: {
      owner: input.owner,
      spender: input.spender.trim(),
      value: toBaseUnits(input.amount, read.decimals).toString(),
      nonce: read.nonce.toString(),
      deadline: deadline.toString(),
    },
  };
}
