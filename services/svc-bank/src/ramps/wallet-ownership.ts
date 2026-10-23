import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { BankError } from '../errors.js';
import { isEvmAddressRef, type UserWithdrawDestinations } from '../withdraw-destination.js';

/**
 * PRIVATE-WALLET OWNERSHIP PROOF (W-withdraw-17, J-wallet-04 #6). A customer proves they control a saved address by
 * signing a message with its key (EIP-191 `personal_sign`, EVM first). Nothing is paid out to prove anything.
 *
 * - `start` offers a message naming the address, a proof id and when the offer lapses (the owner's proof window,
 *   `BANK_WALLET_PROOF_WINDOW_MINUTES`). Each start is a new offer; an older one is simply superseded.
 * - `verify` recovers the signer from the signature. Another address is refused and the offer stays open; the saved
 *   address marks the proof verified for the owner's validity (`BANK_WALLET_PROOF_VALID_DAYS`).
 * - States, read from an entry's newest open offer and newest verified proof (a verified proof that still holds wins): `none`, `pending` (offer open), `verified` (still valid) and
 *   `expired` (the offer or the proof lapsed). Sending to the address is the withdraw path's to refuse (W-withdraw-17's
 *   send rule lives with J-wallet-05); this file only records and answers.
 *
 * Blank window or validity refuses with its own `_unset` code. Nothing is defaulted.
 */

export const BANK_WALLET_PROOF_WINDOW_ENV = 'BANK_WALLET_PROOF_WINDOW_MINUTES';
export const BANK_WALLET_PROOF_VALIDITY_ENV = 'BANK_WALLET_PROOF_VALID_DAYS';

export type OwnershipState = 'none' | 'pending' | 'verified' | 'expired';

export interface WalletProofRow {
  id: string;
  userId: string;
  destinationId: string;
  /** The saved address, lower-case, as it was when the proof started. */
  address: string;
  message: string;
  status: 'pending' | 'verified';
  createdAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
  validUntil: Date | null;
  signature: string | null;
}

export interface Ownership {
  state: OwnershipState;
  verifiedAt: string | null;
  validUntil: string | null;
  /** While pending: when the open offer lapses. */
  offerExpiresAt: string | null;
}

export interface WalletProofStore {
  insert(row: WalletProofRow): Promise<WalletProofRow>;
  get(userId: string, proofId: string): Promise<WalletProofRow | null>;
  /**
   * Marks a pending proof verified while its offer is still open at `verifiedAt`. Null when it was not pending any more
   * (a race with another verify) or the offer had lapsed by then.
   */
  markVerified(
    userId: string,
    proofId: string,
    patch: { signature: string; verifiedAt: Date; validUntil: Date },
  ): Promise<WalletProofRow | null>;
  /** Per entry of the customer's, the newest open-or-lapsed offer and the newest verified proof. */
  latest(userId: string): Promise<Map<string, EntryProofs>>;
}

/** An entry's newest offer still `pending` and newest `verified` proof, either missing. */
export interface EntryProofs {
  pending: WalletProofRow | null;
  verified: WalletProofRow | null;
}

/** Positive whole number of minutes or days, or the `_unset` refusal. */
function requirePositive(
  raw: string | undefined,
  env: string,
  code: 'bank.wallet_proof_window_unset' | 'bank.wallet_proof_validity_unset',
) {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9][0-9]{0,5}$/.test(trimmed)) {
    throw new BankError(`${env} is unset or not a positive whole number, so a wallet proof refuses rather than inventing one`, code);
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * What an entry's proofs say about it now. A still-valid verified proof wins over any newer offer, so opening the panel
 * again never hides a proof that holds; then an open offer; then whatever lapsed.
 */
export function ownershipOf(proofs: EntryProofs | undefined, now: Date): Ownership {
  const verified = proofs?.verified ?? null;
  const pending = proofs?.pending ?? null;
  const proved = verified
    ? {
        verifiedAt: verified.verifiedAt?.toISOString() ?? null,
        validUntil: verified.validUntil?.toISOString() ?? null,
      }
    : { verifiedAt: null, validUntil: null };
  if (verified?.validUntil && verified.validUntil > now) return { state: 'verified', ...proved, offerExpiresAt: null };
  if (pending && pending.expiresAt > now) return { state: 'pending', ...proved, offerExpiresAt: pending.expiresAt.toISOString() };
  if (verified || pending) return { state: 'expired', ...proved, offerExpiresAt: pending?.expiresAt.toISOString() ?? null };
  return { state: 'none', verifiedAt: null, validUntil: null, offerExpiresAt: null };
}

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const encoder = new TextEncoder();

/** The EIP-191 digest a wallet signs for `personal_sign`. */
function personalMessageHash(message: string): Uint8Array {
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

/**
 * The address that signed `message` (EIP-191, a 65-byte `r || s || v` signature, `v` 27/28 or 0/1), lower-case, or
 * null when the signature is not one.
 */
export function recoverPersonalSignAddress(message: string, signature: string): string | null {
  const sig = signature.trim();
  if (!SIGNATURE.test(sig)) return null;
  const bytes = Uint8Array.from(Buffer.from(sig.slice(2), 'hex'));
  const v = bytes[64]!;
  const bit = v >= 27 ? v - 27 : v;
  if (bit !== 0 && bit !== 1) return null;
  // The library's recoverable form puts the recovery bit first.
  const recoverable = new Uint8Array(65);
  recoverable[0] = bit;
  recoverable.set(bytes.subarray(0, 64), 1);
  try {
    const compressed = secp256k1.recoverPublicKey(recoverable, personalMessageHash(message), { prehash: false });
    const full = secp256k1.Point.fromBytes(compressed).toBytes(false);
    return `0x${Buffer.from(keccak_256(full.subarray(1)).subarray(-20)).toString('hex')}`;
  } catch {
    return null;
  }
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The exact text the customer signs. It names the address, the proof and its end, and says nothing moves. */
export function proofMessage(address: string, proofId: string, expiresAt: Date): string {
  return [
    'INTAFACED wallet ownership proof',
    `Address: ${address}`,
    `Proof: ${proofId}`,
    `Sign before: ${expiresAt.toISOString()}`,
    'Signing this proves you control this address. It moves no funds and approves nothing else.',
  ].join('\n');
}

export interface WalletProofDeps {
  destinations: UserWithdrawDestinations;
  proofs: WalletProofStore;
  windowRaw: () => string | undefined;
  validityRaw: () => string | undefined;
  now?: () => Date;
}

const NOT_FOUND = () => new BankError('That wallet proof could not be found. Start a new one', 'bank.wallet_proof_not_found');

export interface StartedProof {
  proofId: string;
  destinationId: string;
  message: string;
  expiresAt: string;
}

/**
 * Offer a message to sign for one of the customer's own saved crypto addresses. While an offer for the entry is still
 * open, that same offer is answered again, so opening the panel twice (or a retry) never piles up rows.
 */
export async function startWalletProof(deps: WalletProofDeps, input: { userId: string; destinationId: string }): Promise<StartedProof> {
  const minutes = requirePositive(deps.windowRaw(), BANK_WALLET_PROOF_WINDOW_ENV, 'bank.wallet_proof_window_unset');
  // Checked here too, so a blank validity refuses before an offer that could never be honoured is made.
  requirePositive(deps.validityRaw(), BANK_WALLET_PROOF_VALIDITY_ENV, 'bank.wallet_proof_validity_unset');
  const entry = (await deps.destinations.list(input.userId)).find((row) => row.destinationId === input.destinationId);
  if (!entry || entry.origin !== 'customer' || entry.kind !== 'crypto' || !isEvmAddressRef(entry.ref)) {
    throw new BankError('Only a wallet address saved in your address book can be proved', 'bank.wallet_proof_not_found');
  }
  const now = (deps.now ?? (() => new Date()))();
  const address = entry.ref.trim().toLowerCase();
  const open = (await deps.proofs.latest(input.userId)).get(entry.destinationId)?.pending;
  if (open && open.expiresAt > now && open.address === address) {
    return { proofId: open.id, destinationId: open.destinationId, message: open.message, expiresAt: open.expiresAt.toISOString() };
  }
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + minutes * 60_000);
  const row = await deps.proofs.insert({
    id,
    userId: input.userId,
    destinationId: entry.destinationId,
    address,
    message: proofMessage(address, id, expiresAt),
    status: 'pending',
    createdAt: now,
    expiresAt,
    verifiedAt: null,
    validUntil: null,
    signature: null,
  });
  return { proofId: row.id, destinationId: row.destinationId, message: row.message, expiresAt: row.expiresAt.toISOString() };
}

/** Check a signature for an open offer. The saved address must have signed it; anything else is refused by name. */
export async function verifyWalletProof(
  deps: WalletProofDeps,
  input: { userId: string; proofId: string; signature: string },
): Promise<{ proofId: string; destinationId: string } & Ownership> {
  const clock = deps.now ?? (() => new Date());
  const lapsed = () => new BankError('This proof expired before it was signed. Start a new one', 'bank.wallet_proof_expired');
  const row = await deps.proofs.get(input.userId, input.proofId);
  if (!row) throw NOT_FOUND();
  // The same signature again is the same answer.
  if (row.status === 'verified') {
    if (row.signature === input.signature.trim().toLowerCase())
      return { proofId: row.id, destinationId: row.destinationId, ...ownershipOf({ pending: null, verified: row }, clock()) };
    throw new BankError('This proof is already complete. Start a new one to prove the address again', 'bank.wallet_proof_conflict');
  }
  if (row.expiresAt <= clock()) throw lapsed();
  const entry = (await deps.destinations.list(input.userId)).find((e) => e.destinationId === row.destinationId);
  if (!entry || entry.ref.trim().toLowerCase() !== row.address) throw NOT_FOUND();
  const signer = recoverPersonalSignAddress(row.message, input.signature);
  if (!signer) {
    throw new BankError(
      'That is not a signature of the message. Paste the whole signature your wallet gave you',
      'bank.wallet_proof_signature_invalid',
    );
  }
  if (signer !== row.address) {
    throw new BankError(
      `This was signed by another address (${short(signer)}). Sign with the wallet that holds ${short(row.address)}`,
      'bank.wallet_proof_wrong_signer',
    );
  }
  const days = requirePositive(deps.validityRaw(), BANK_WALLET_PROOF_VALIDITY_ENV, 'bank.wallet_proof_validity_unset');
  // The clock is read after the lookups, and the store marks the proof only while the offer is still open at that time,
  // so a signature never lands after the "Sign before" the message promised.
  const now = clock();
  const done = await deps.proofs.markVerified(input.userId, row.id, {
    signature: input.signature.trim().toLowerCase(),
    verifiedAt: now,
    validUntil: new Date(now.getTime() + days * 86_400_000),
  });
  if (!done) {
    if (row.expiresAt <= now) throw lapsed();
    throw new BankError('This proof changed while it was checked. Refresh and try again', 'bank.wallet_proof_conflict');
  }
  return { proofId: done.id, destinationId: done.destinationId, ...ownershipOf({ pending: null, verified: done }, now) };
}

/** In-memory store for tests. Same rules as the Postgres store. */
export function memoryWalletProofs(): WalletProofStore {
  // Insertion order is the order offers were made, like the table's `seq`.
  const rows = new Map<string, WalletProofRow>();
  return {
    async insert(row) {
      rows.set(row.id, { ...row });
      return { ...row };
    },
    async get(userId, proofId) {
      const row = rows.get(proofId);
      return row && row.userId === userId ? { ...row } : null;
    },
    async markVerified(userId, proofId, patch) {
      const row = rows.get(proofId);
      if (!row || row.userId !== userId || row.status !== 'pending' || row.expiresAt <= patch.verifiedAt) return null;
      const done = { ...row, status: 'verified' as const, ...patch };
      rows.set(proofId, done);
      return { ...done };
    },
    async latest(userId) {
      const out = new Map<string, EntryProofs>();
      for (const row of rows.values()) {
        if (row.userId !== userId) continue;
        const entry = out.get(row.destinationId) ?? { pending: null, verified: null };
        entry[row.status] = { ...row };
        out.set(row.destinationId, entry);
      }
      return out;
    },
  };
}

interface ProofDbRow {
  id: string;
  user_id: string;
  destination_id: string;
  address: string;
  message: string;
  status: 'pending' | 'verified';
  created_at: Date;
  expires_at: Date;
  verified_at: Date | null;
  valid_until: Date | null;
  signature: string | null;
}

const fromDb = (row: ProofDbRow): WalletProofRow => ({
  id: row.id,
  userId: row.user_id,
  destinationId: row.destination_id,
  address: row.address,
  message: row.message,
  status: row.status,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  verifiedAt: row.verified_at,
  validUntil: row.valid_until,
  signature: row.signature,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `bank.wallet_ownership_proofs` (migration 0055). */
export function sqlWalletProofs(sql: Sql): WalletProofStore {
  return {
    async insert(row) {
      const rows = await sql<ProofDbRow[]>`
        INSERT INTO bank.wallet_ownership_proofs (id, user_id, destination_id, address, message, status, created_at, expires_at)
        VALUES (${row.id}::uuid, ${row.userId}, ${row.destinationId}::uuid, ${row.address}, ${row.message}, 'pending',
                ${row.createdAt}, ${row.expiresAt})
        RETURNING *
      `;
      return fromDb(rows[0]!);
    },
    async get(userId, proofId) {
      if (!UUID_RE.test(proofId)) return null;
      const rows = await sql<ProofDbRow[]>`
        SELECT * FROM bank.wallet_ownership_proofs WHERE id = ${proofId}::uuid AND user_id = ${userId}
      `;
      return rows[0] ? fromDb(rows[0]) : null;
    },
    async markVerified(userId, proofId, patch) {
      const rows = await sql<ProofDbRow[]>`
        UPDATE bank.wallet_ownership_proofs
           SET status = 'verified', signature = ${patch.signature}, verified_at = ${patch.verifiedAt}, valid_until = ${patch.validUntil}
         WHERE id = ${proofId}::uuid AND user_id = ${userId} AND status = 'pending' AND expires_at > ${patch.verifiedAt}
        RETURNING *
      `;
      return rows[0] ? fromDb(rows[0]) : null;
    },
    async latest(userId) {
      const rows = await sql<ProofDbRow[]>`
        SELECT DISTINCT ON (destination_id, status) *
          FROM bank.wallet_ownership_proofs
         WHERE user_id = ${userId}
         ORDER BY destination_id, status, seq DESC
      `;
      const out = new Map<string, EntryProofs>();
      for (const row of rows) {
        const entry = out.get(row.destination_id) ?? { pending: null, verified: null };
        entry[row.status] = fromDb(row);
        out.set(row.destination_id, entry);
      }
      return out;
    },
  };
}
