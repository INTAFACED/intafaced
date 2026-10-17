import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { BankError } from './errors.js';

/**
 * User withdraw destination — the ref a later offramp must already have
 * BEFORE `withdrawHold`.
 *
 * Shape is IBAN / IFSC / EVM. This file does not invent a PSP and does not
 * live-wire a bank rail. Value still leaves through ledger-client recipes
 * after this ref is loaded.
 */

export const WITHDRAW_DESTINATION_KINDS = ['crypto', 'bank'] as const;
export type WithdrawDestinationKind = (typeof WITHDRAW_DESTINATION_KINDS)[number];

export type WithdrawDestination = {
  destinationId: string;
  kind: WithdrawDestinationKind;
  ref: string;
  label: string | null;
  addedAt: Date;
  updatedAt: Date;
};

export type UserWithdrawDestinations = {
  persist(input: { userId: string; kind: string; ref: string; label?: string }): Promise<WithdrawDestination>;
  require(input: { userId: string; kind: string }): Promise<WithdrawDestination>;
  list(userId: string): Promise<WithdrawDestination[]>;
  remove(input: { userId: string; destinationId: string; idempotencyKey: string }): Promise<{ destinationId: string; removed: true }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A label the customer typed. Omit means "leave the stored label". */
export function assertDestinationLabel(label: string): string {
  if (label.trim() !== label || label.length < 1 || label.length > 64 || /[\u0000-\u001f]/.test(label)) {
    throw new BankError(
      'Withdraw destination label must be 1–64 characters with no surrounding whitespace or control characters',
      'bank.ramp_invalid_destination',
    );
  }
  return label;
}

type PersistableWithdrawDestination = { kind: WithdrawDestinationKind; ref: string };

/** EVM address: 0x + 40 hex digits. Checksum optional (structural only). */
export function isEvmAddressRef(ref: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(ref.trim());
}

/**
 * IBAN structural check: country + check digits + BBAN, length 15–34, mod-97 = 1.
 * Spaces ignored. Does not prove the account exists or is reachable.
 */
export function isIbanRef(ref: string): boolean {
  const compact = ref.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) {
    if (ch >= 'A' && ch <= 'Z') expanded += String(ch.charCodeAt(0) - 55);
    else expanded += ch;
  }
  let remainder = 0;
  for (const d of expanded) {
    remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * IFSC structural check (India): 4 letters + 0 + 6 alphanumeric = 11 chars.
 * Does not prove the bank branch exists or a partner rail is live.
 */
export function isIfscRef(ref: string): boolean {
  const compact = ref.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(compact);
}

export function isBankDestinationRef(ref: string): boolean {
  return isIbanRef(ref) || isIfscRef(ref);
}

export function destKindForRamp(rampKind: 'crypto' | 'fiat'): WithdrawDestinationKind {
  return rampKind === 'fiat' ? 'bank' : 'crypto';
}

function asKind(kind: string): WithdrawDestinationKind {
  const trimmed = kind.trim();
  if (trimmed === 'crypto' || trimmed === 'bank') return trimmed;
  throw new BankError(
    `Withdraw destination kind must be crypto (EVM) or bank (IBAN/IFSC), got '${trimmed}'`,
    'bank.ramp_invalid_destination',
  );
}

/** Assert kind+shape. Does not register or enable any rail. Clock is the store's. */
export function assertPersistableWithdrawDestination(destination: { kind: string; ref: string }): PersistableWithdrawDestination {
  const kind = asKind(destination.kind);
  const ref = destination.ref?.trim() ?? '';
  if (!ref) {
    throw new BankError('Withdraw destination requires a non-empty ref', 'bank.ramp_invalid_destination');
  }
  if (kind === 'crypto') {
    if (!isEvmAddressRef(ref)) {
      throw new BankError(
        `Crypto withdraw dest must be a 20-byte EVM address (0x + 40 hex), got '${ref.slice(0, 24)}${ref.length > 24 ? '…' : ''}'`,
        'bank.ramp_invalid_destination',
      );
    }
    return { kind, ref };
  }
  if (!isBankDestinationRef(ref)) {
    throw new BankError(
      'Bank withdraw dest must be a structural IBAN (mod-97) or IFSC (11-char India scheme).',
      'bank.ramp_invalid_destination',
    );
  }
  return { kind, ref };
}

/**
 * Router-test default: assert on persist, never invent a stored ref.
 * A later withdraw without a dest refuses closed — no invented ref.
 */
export function assertOnlyWithdrawDestinations(): UserWithdrawDestinations {
  return {
    async persist(input) {
      const dest = assertPersistableWithdrawDestination(input);
      const label = input.label === undefined ? null : assertDestinationLabel(input.label);
      return { ...dest, destinationId: '00000000-0000-4000-8000-000000000000', label, addedAt: new Date(0), updatedAt: new Date(0) };
    },
    async require(input) {
      throw new BankError(
        `User ${input.userId} has no persisted withdraw destination for kind ${input.kind}`,
        'bank.withdraw_destination_missing',
      );
    },
    async list() {
      return [];
    },
    async remove(input) {
      throw new BankError(
        `User ${input.userId} has no persisted withdraw destination ${input.destinationId}`,
        'bank.withdraw_destination_missing',
      );
    },
  };
}

/** In-memory store for tests. Persist stores; require refuses closed if none stored. Same-ref persist still bumps `updatedAt`. */
export function memoryWithdrawDestinations(options: { now?: () => Date } = {}): UserWithdrawDestinations {
  const rows = new Map<string, WithdrawDestination>();
  const removals = new Map<string, string>();
  const clock = options.now ?? (() => new Date());
  const key = (userId: string, kind: string) => `${userId}:${kind}`;
  return {
    async persist(input) {
      const dest = assertPersistableWithdrawDestination(input);
      const existing = rows.get(key(input.userId, dest.kind));
      const label = input.label === undefined ? (existing?.label ?? null) : assertDestinationLabel(input.label);
      const stored: WithdrawDestination = {
        destinationId: existing?.destinationId ?? randomUUID(),
        ...dest,
        label,
        addedAt: existing?.addedAt ?? clock(),
        updatedAt: clock(),
      };
      rows.set(key(input.userId, dest.kind), stored);
      return stored;
    },
    async require(input) {
      const kind = asKind(input.kind);
      const dest = rows.get(key(input.userId, kind));
      if (!dest) {
        throw new BankError(
          `User ${input.userId} has no persisted withdraw destination for kind ${kind}`,
          'bank.withdraw_destination_missing',
        );
      }
      return dest;
    },
    async list(userId) {
      return [...rows.entries()]
        .filter(([rowKey]) => rowKey === `${userId}:crypto` || rowKey === `${userId}:bank`)
        .map(([, row]) => row)
        .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
    },
    async remove(input) {
      const idempotencyKey = input.idempotencyKey.trim();
      if (!idempotencyKey || idempotencyKey.length > 128) {
        throw new BankError('Destination removal needs an idempotency key', 'bank.ramp_invalid_destination');
      }
      const removalKey = `${input.userId}:${idempotencyKey}`;
      const prior = removals.get(removalKey);
      if (prior) {
        if (prior !== input.destinationId) {
          throw new BankError('Idempotency key was already used for a different destination', 'bank.ramp_conflict');
        }
        return { destinationId: input.destinationId, removed: true as const };
      }
      const rowKey = [...rows.entries()].find(
        ([candidate, row]) =>
          (candidate === `${input.userId}:crypto` || candidate === `${input.userId}:bank`) && row.destinationId === input.destinationId,
      )?.[0];
      if (!rowKey) {
        throw new BankError(
          `User ${input.userId} has no persisted withdraw destination ${input.destinationId}`,
          'bank.withdraw_destination_missing',
        );
      }
      rows.delete(rowKey);
      removals.set(removalKey, input.destinationId);
      return { destinationId: input.destinationId, removed: true as const };
    },
  };
}

export class UserWithdrawDestinationStore implements UserWithdrawDestinations {
  constructor(private readonly sql: Sql) {}

  async persist(input: { userId: string; kind: string; ref: string; label?: string }): Promise<WithdrawDestination> {
    const dest = assertPersistableWithdrawDestination(input);
    const label = input.label === undefined ? null : assertDestinationLabel(input.label);
    const keepLabel = input.label === undefined;
    const rows = await this.sql<DestinationRow[]>`
      INSERT INTO bank.user_withdraw_destinations (user_id, kind, ref, label)
      VALUES (${input.userId}, ${dest.kind}, ${dest.ref}, ${label})
      ON CONFLICT (user_id, kind)
      DO UPDATE SET
        ref = excluded.ref,
        label = CASE WHEN ${keepLabel} THEN bank.user_withdraw_destinations.label ELSE excluded.label END,
        updated_at = now()
      RETURNING destination_id, kind, ref, label, created_at, updated_at
    `;
    return toDestination(rows[0]!);
  }

  async require(input: { userId: string; kind: string }): Promise<WithdrawDestination> {
    const kind = asKind(input.kind);
    const rows = await this.sql<DestinationRow[]>`
      SELECT destination_id, kind, ref, label, created_at, updated_at
        FROM bank.user_withdraw_destinations
       WHERE user_id = ${input.userId} AND kind = ${kind}
    `;
    const row = rows[0];
    if (!row) {
      throw new BankError(
        `User ${input.userId} has no persisted withdraw destination for kind ${kind}`,
        'bank.withdraw_destination_missing',
      );
    }
    return toDestination(row);
  }

  async list(userId: string): Promise<WithdrawDestination[]> {
    const rows = await this.sql<DestinationRow[]>`
      SELECT destination_id, kind, ref, label, created_at, updated_at
        FROM bank.user_withdraw_destinations
       WHERE user_id = ${userId}
       ORDER BY created_at ASC
    `;
    return rows.map(toDestination);
  }

  async remove(input: {
    userId: string;
    destinationId: string;
    idempotencyKey: string;
  }): Promise<{ destinationId: string; removed: true }> {
    const destinationId = input.destinationId.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(destinationId)) {
      throw new BankError('destinationId must be a uuid', 'bank.ramp_invalid_destination');
    }
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new BankError('Destination removal needs an idempotency key', 'bank.ramp_invalid_destination');
    }
    return transaction(this.sql, async (tx) => {
      const prior = await tx<Array<{ destination_id: string }>>`
        SELECT destination_id FROM bank.withdraw_destination_removals
         WHERE user_id = ${input.userId} AND idempotency_key = ${idempotencyKey}
         FOR UPDATE
      `;
      if (prior[0]) {
        if (prior[0].destination_id !== destinationId) {
          throw new BankError('Idempotency key was already used for a different destination', 'bank.ramp_conflict');
        }
        return { destinationId, removed: true as const };
      }
      const deleted = await tx<Array<{ destination_id: string }>>`
        DELETE FROM bank.user_withdraw_destinations
         WHERE user_id = ${input.userId} AND destination_id = ${destinationId}::uuid
         RETURNING destination_id
      `;
      if (!deleted[0]) {
        throw new BankError(
          `User ${input.userId} has no persisted withdraw destination ${destinationId}`,
          'bank.withdraw_destination_missing',
        );
      }
      await tx`
        INSERT INTO bank.withdraw_destination_removals (user_id, idempotency_key, destination_id)
        VALUES (${input.userId}, ${idempotencyKey}, ${destinationId}::uuid)
      `;
      return { destinationId, removed: true as const };
    });
  }
}

interface DestinationRow {
  destination_id: string;
  kind: string;
  ref: string;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}

function toDestination(row: DestinationRow): WithdrawDestination {
  return {
    destinationId: row.destination_id,
    kind: asKind(row.kind),
    ref: row.ref,
    label: row.label,
    addedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
