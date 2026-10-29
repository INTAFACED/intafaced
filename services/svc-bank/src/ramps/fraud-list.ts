/**
 * The owner's destination fraud list (W-withdraw-03, J-wallet-05 #2).
 *
 * The compliance desk lists a withdrawal address as fraud, on one network or on every network (`*`). An address on the
 * list is never saved to a customer's address book (`bank.destination_fraud_listed`, before anything is written), the
 * add form's check says so before it asks for a confirmation code, and a saved entry that is listed later reads as
 * `blocked` before a send.
 *
 * A list is content, not a magnitude: no row lists nothing, so an empty list refuses nothing and is not a blank owner
 * value to refuse on. A list that cannot be read is different: an unknown answer is not "not listed", so the save and the
 * check refuse `bank.destination_fraud_list_unreadable`.
 *
 * An EVM address is matched in lower case, however it was typed or listed; any other address exactly as written.
 *
 * Every change names the revision it was made against and needs a second person (an identity approval bound to the
 * network, the address, the listed state and the new revision), consumed before the write. The history row carries the
 * business key `ops-fraud-list:<network>:<address>:<revision>`, so a retry replays and a different change on the same
 * revision refuses `bank.ops_revision_conflict`. The history is append-only (a database trigger refuses edits).
 */
import { scopedProcedure } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BankError } from '../errors.js';
import { isEvmAddressRef } from '../withdraw-destination.js';

/** Every network: a listing that applies whatever network the address is saved on. */
export const ANY_NETWORK = '*';

export const SET_FRAUD_LISTING_ACTION = 'bank.ops.setDestinationFraudListing';

/** What the address book asks of the list. */
export interface DestinationFraudListPort {
  /**
   * Whether `ref` is listed on `network` or on every network. A null network (an entry stored without one) matches a listing on
   * any network, since the network it would be sent on is not known. Throws `bank.destination_fraud_list_unreadable` when unknown.
   */
  isListed(network: string | null, ref: string): Promise<boolean>;
}

export interface FraudListing {
  network: string;
  address: string;
  listed: boolean;
  /** 0 when the address has never been on the list. */
  revision: number;
  reason: string | null;
  approvedBy: string | null;
  updatedAt: string | null;
}

export interface FraudListingChange {
  network: string;
  address: string;
  listed: boolean;
  /** The revision the desk read. The change becomes revision + 1. */
  expectedRevision: number;
  reason: string;
  /** Consumes the second person's approval; returns who proposed and who approved. */
  consume: () => Promise<{ requesterId: string; approverId: string }>;
}

interface ListRow {
  network: string;
  address_key: string;
  listed: boolean;
  revision: number;
  reason: string;
  approved_by: string;
  updated_at: Date;
}

interface HistoryRow {
  network: string;
  address_key: string;
  revision: number;
  listed: boolean;
  reason: string;
  requested_by: string;
  approved_by: string;
}

/** The key an address is listed and matched under: an EVM address in lower case, anything else exactly as written. */
export function fraudAddressKey(ref: string): string {
  const trimmed = ref.trim();
  return isEvmAddressRef(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** `*` or a network id as the address book stores it (lower case). */
export function fraudNetworkKey(network: string): string {
  const trimmed = network.trim();
  if (trimmed === ANY_NETWORK) return ANY_NETWORK;
  const key = trimmed.toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(key)) {
    throw new BankError(`"${network}" is not a network id or ${ANY_NETWORK}`, 'bank.validation_failed');
  }
  return key;
}

export function fraudChangeKey(network: string, address: string, revision: number): string {
  return `ops-fraud-list:${network}:${address}:${revision}`;
}

function toListing(row: ListRow): FraudListing {
  return {
    network: row.network,
    address: row.address_key,
    listed: row.listed,
    revision: Number(row.revision),
    reason: row.reason,
    approvedBy: row.approved_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The address-book and send refusal for a listed address. Nothing was saved or sent. */
export function refuseFraudListed(): never {
  throw new BankError(
    'This address is on the fraud list, so it cannot be saved or sent to. Nothing was saved or sent',
    'bank.destination_fraud_listed',
  );
}

function unreadable(): BankError {
  // The database detail is not a customer message; the code says enough to try again later.
  return new BankError(
    'The fraud list could not be read, so the address was refused rather than assumed safe',
    'bank.destination_fraud_list_unreadable',
  );
}

export class DestinationFraudList implements DestinationFraudListPort {
  constructor(private readonly sql: Sql) {}

  async isListed(network: string | null, ref: string): Promise<boolean> {
    const key = fraudAddressKey(ref);
    const networks = network === null ? null : [ANY_NETWORK, network.trim().toLowerCase()];
    try {
      const rows = await this.sql<Array<{ listed: boolean }>>`
        SELECT listed FROM bank.destination_fraud_list
         WHERE address_key = ${key} AND (${networks}::text[] IS NULL OR network = ANY(${networks}::text[])) AND listed
         LIMIT 1
      `;
      return rows.length > 0;
    } catch {
      throw unreadable();
    }
  }

  /** Addresses that have ever been on the list (one address's rows when `address` is given), listed ones first, at most `limit`. */
  async list(limit: number, address?: string): Promise<FraudListing[]> {
    const key = address === undefined ? null : fraudAddressKey(address);
    const rows = await this.sql<ListRow[]>`
      SELECT network, address_key, listed, revision, reason, approved_by, updated_at
        FROM bank.destination_fraud_list
       WHERE (${key}::text IS NULL OR address_key = ${key})
       ORDER BY listed DESC, network, address_key LIMIT ${limit}
    `;
    return rows.map(toListing);
  }

  async state(network: string, address: string): Promise<FraudListing> {
    const rows = await this.sql<ListRow[]>`
      SELECT network, address_key, listed, revision, reason, approved_by, updated_at
        FROM bank.destination_fraud_list WHERE network = ${network} AND address_key = ${address}
    `;
    return rows[0] ? toListing(rows[0]) : { network, address, listed: false, revision: 0, reason: null, approvedBy: null, updatedAt: null };
  }

  async set(change: FraudListingChange): Promise<FraudListing & { replayed: boolean }> {
    const network = fraudNetworkKey(change.network);
    const address = fraudAddressKey(change.address);
    if (address.length === 0 || address.length > 256 || /\s/.test(address)) {
      throw new BankError('The address must be 1 to 256 characters with no spaces', 'bank.validation_failed');
    }
    const reason = change.reason.trim();
    if (reason.length < 10) {
      throw new BankError(
        'A fraud list change needs a reason of at least 10 characters (bank.ops_reason_too_short)',
        'bank.ops_reason_too_short',
      );
    }
    if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0) {
      throw new BankError('expectedRevision must be the revision the desk read (0 for never listed)', 'bank.validation_failed');
    }
    const revision = change.expectedRevision + 1;

    const prior = await this.history(this.sql, network, address, revision);
    const current = await this.state(network, address);
    // A retry replays only while its revision is still the current one; a later change makes it stale, not true.
    if (prior) {
      if (current.revision !== revision) throw this.conflict(network, address, change.expectedRevision, current.revision);
      return this.replay(prior, change.listed, reason);
    }

    if (current.revision !== change.expectedRevision) throw this.conflict(network, address, change.expectedRevision, current.revision);

    const { requesterId, approverId } = await change.consume();

    return transaction(this.sql, async (tx) => {
      const locked = await tx<Array<{ revision: number }>>`
        SELECT revision FROM bank.destination_fraud_list WHERE network = ${network} AND address_key = ${address} FOR UPDATE
      `;
      const now = locked[0] ? Number(locked[0].revision) : 0;
      if (now !== change.expectedRevision) {
        const raced = await this.history(tx, network, address, revision);
        if (raced) return this.replay(raced, change.listed, reason);
        throw this.conflict(network, address, change.expectedRevision, now);
      }
      const inserted = await tx<Array<{ network: string }>>`
        INSERT INTO bank.destination_fraud_list_history
          (network, address_key, revision, change_key, listed, reason, requested_by, approved_by)
        VALUES (${network}, ${address}, ${revision}, ${fraudChangeKey(network, address, revision)}, ${change.listed}, ${reason},
                ${requesterId}, ${approverId})
        ON CONFLICT DO NOTHING
        RETURNING network
      `;
      if (inserted.length === 0) {
        // A first-revision race: no row to lock, and the other change won the key.
        const raced = await this.history(tx, network, address, revision);
        if (raced) return this.replay(raced, change.listed, reason);
        throw this.conflict(network, address, change.expectedRevision, revision);
      }
      const rows = await tx<ListRow[]>`
        INSERT INTO bank.destination_fraud_list (network, address_key, listed, revision, reason, approved_by, updated_at)
        VALUES (${network}, ${address}, ${change.listed}, ${revision}, ${reason}, ${approverId}, now())
        ON CONFLICT (network, address_key) DO UPDATE
          SET listed = EXCLUDED.listed, revision = EXCLUDED.revision, reason = EXCLUDED.reason,
              approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at
        RETURNING network, address_key, listed, revision, reason, approved_by, updated_at
      `;
      return { ...toListing(rows[0]!), replayed: false };
    });
  }

  /** One address's changes, newest first. */
  async historyOf(network: string, address: string, limit: number) {
    const rows = await this.sql<Array<HistoryRow & { change_key: string; created_at: Date }>>`
      SELECT network, address_key, revision, change_key, listed, reason, requested_by, approved_by, created_at
        FROM bank.destination_fraud_list_history
       WHERE network = ${fraudNetworkKey(network)} AND address_key = ${fraudAddressKey(address)}
       ORDER BY revision DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      network: r.network,
      address: r.address_key,
      revision: Number(r.revision),
      changeKey: r.change_key,
      listed: r.listed,
      reason: r.reason,
      requestedBy: r.requested_by,
      approvedBy: r.approved_by,
      at: r.created_at.toISOString(),
    }));
  }

  private async history(sql: Sql, network: string, address: string, revision: number): Promise<HistoryRow | null> {
    const rows = await sql<HistoryRow[]>`
      SELECT network, address_key, revision, listed, reason, requested_by, approved_by
        FROM bank.destination_fraud_list_history WHERE change_key = ${fraudChangeKey(network, address, revision)}
    `;
    return rows[0] ?? null;
  }

  private replay(prior: HistoryRow, listed: boolean, reason: string): FraudListing & { replayed: boolean } {
    if (prior.listed !== listed || prior.reason !== reason) {
      throw this.conflict(prior.network, prior.address_key, Number(prior.revision) - 1, Number(prior.revision));
    }
    return {
      network: prior.network,
      address: prior.address_key,
      listed: prior.listed,
      revision: Number(prior.revision),
      reason: prior.reason,
      approvedBy: prior.approved_by,
      updatedAt: null,
      replayed: true,
    };
  }

  private conflict(network: string, address: string, expected: number, actual: number): BankError {
    return new BankError(
      `The fraud listing of ${address} on ${network} changed underneath this request (expected revision ${expected}, found ${actual}); read it again`,
      'bank.ops_revision_conflict',
    );
  }
}

/** An in-memory list for tests that build the bank without a database. */
export function memoryFraudList(listed: Array<{ network: string; address: string }> = []): DestinationFraudListPort {
  const keys = new Set(listed.map((l) => `${fraudNetworkKey(l.network)}|${fraudAddressKey(l.address)}`));
  return {
    async isListed(network, ref) {
      const key = fraudAddressKey(ref);
      if (network === null) return [...keys].some((k) => k.endsWith(`|${key}`));
      return keys.has(`${ANY_NETWORK}|${key}`) || keys.has(`${network.trim().toLowerCase()}|${key}`);
    },
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const listing = z.object({
  network: z.string(),
  address: z.string(),
  listed: z.boolean(),
  revision: z.number().int(),
  reason: z.string().nullable(),
  approvedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/**
 * Desk read: addresses ever listed (or one address's rows), at most `limit`, and one address's history when asked, with its
 * own limit. Neither page size has a default (blank is not 50).
 */
export function destinationFraudListProcedure(list: () => DestinationFraudList, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500),
          address: z.string().min(1).max(256).optional(),
          historyFor: z
            .object({ network: z.string().min(1).max(32), address: z.string().min(1).max(256) })
            .strict()
            .optional(),
          historyLimit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    )
    .output(
      z.object({
        entries: z.array(listing),
        history: z.array(
          listing
            .omit({ updatedAt: true })
            .extend({ requestedBy: z.string(), reason: z.string(), approvedBy: z.string(), changeKey: z.string(), at: z.string() }),
        ),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        if (input.historyFor !== undefined && input.historyLimit === undefined) {
          throw new BankError('historyLimit is required with historyFor; blank is not 50', 'bank.validation_failed');
        }
        const service = list();
        const entries = await service.list(input.limit, input.address);
        const history = input.historyFor
          ? await service.historyOf(input.historyFor.network, input.historyFor.address, input.historyLimit!)
          : [];
        return { entries, history };
      }),
    );
}

/** List or delist one address: compliance's door, with a second person's approval bound to the exact change. */
export function setDestinationFraudListingProcedure(
  list: () => DestinationFraudList,
  consumeOpsApprovalPair: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<{ approvalId: string; requesterId: string; approverId: string }>,
  guard: Guard,
) {
  return scopedProcedure('admin:compliance')
    .input(
      z
        .object({
          network: z.string().min(1).max(32),
          address: z.string().min(1).max(256),
          listed: z.boolean(),
          expectedRevision: z.number().int().min(0),
          reason: z.string().max(500),
          approvalId: z.string().max(128).nullish(),
          operationId: z.string().max(128).nullish(),
        })
        .strict(),
    )
    .output(listing.extend({ replayed: z.boolean() }))
    .mutation(({ input }) =>
      guard(() =>
        list().set({
          network: input.network,
          address: input.address,
          listed: input.listed,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          consume: () => consumeOpsApprovalPair(input, SET_FRAUD_LISTING_ACTION, fraudListingFields(input)),
        }),
      ),
    );
}

/** The fields the approval is bound to (the reason too), normalised so the desk and the stack's tools hash the same change. */
export function fraudListingFields(input: { network: string; address: string; listed: boolean; expectedRevision: number; reason: string }) {
  return {
    network: fraudNetworkKey(input.network),
    address: fraudAddressKey(input.address),
    listed: String(input.listed),
    revision: String(input.expectedRevision + 1),
    // The approver approves the reason the history keeps, not only the change.
    reason: input.reason.trim(),
  };
}
