import { getAddress } from 'viem';

/**
 * Which payment and asset own an HD-derived deposit address.
 *
 * Not money. `index` is the BIP-44 address slot that derived `address`,
 * never an amount. The book is the occupancy record the collision walk
 * reads, so a new process cannot hand a payer's address to a different
 * payment or show them a different address than the one already assigned.
 */

export interface DepositAddressAssignment {
  readonly paymentId: string;
  readonly assetId: string;
  readonly address: string;
  /** HD derivation slot. Not an amount. */
  readonly index: number;
}

export type DepositAddressClaim =
  | { readonly kind: 'bound'; readonly entry: DepositAddressAssignment }
  | { readonly kind: 'taken'; readonly entry: DepositAddressAssignment };

export interface DepositAddressBook {
  findByPayment(paymentId: string, assetId: string): Promise<DepositAddressAssignment | null>;
  findByAddress(address: string): Promise<DepositAddressAssignment | null>;
  /** Every assignment. The watcher hydrates its process map from this. */
  list(): Promise<readonly DepositAddressAssignment[]>;
  /**
   * Bind this payment and asset to this address.
   * `bound` is the row this payment owns (the one just inserted, or the
   * earlier one — a payment is never moved).
   * `taken` means the address already belongs to a different payment.
   */
  claim(entry: DepositAddressAssignment): Promise<DepositAddressClaim>;
}

export function depositBookKey(paymentId: string, assetId: string): string {
  return `${paymentId}\0${assetId}`;
}

/** Shared by tests and a single process. Not crash-safe — Postgres is. */
export class MemoryDepositAddressBook implements DepositAddressBook {
  private readonly byPayment = new Map<string, DepositAddressAssignment>();
  private readonly byAddress = new Map<string, DepositAddressAssignment>();

  async findByPayment(paymentId: string, assetId: string): Promise<DepositAddressAssignment | null> {
    return this.byPayment.get(depositBookKey(paymentId, assetId)) ?? null;
  }

  async findByAddress(address: string): Promise<DepositAddressAssignment | null> {
    return this.byAddress.get(normalizeAddress(address).toLowerCase()) ?? null;
  }

  async list(): Promise<readonly DepositAddressAssignment[]> {
    return [...this.byPayment.values()];
  }

  async claim(entry: DepositAddressAssignment): Promise<DepositAddressClaim> {
    assertHdIndex(entry.index);
    const address = normalizeAddress(entry.address);
    const key = depositBookKey(entry.paymentId, entry.assetId);
    const mine = this.byPayment.get(key);
    if (mine) return { kind: 'bound', entry: mine };

    const holder = this.byAddress.get(address.toLowerCase());
    if (holder) return { kind: 'taken', entry: holder };

    const stored: DepositAddressAssignment = {
      paymentId: entry.paymentId,
      assetId: entry.assetId,
      address,
      index: entry.index,
    };
    this.byPayment.set(key, stored);
    this.byAddress.set(address.toLowerCase(), stored);
    return { kind: 'bound', entry: stored };
  }
}

/**
 * Minimal postgres.js surface used by the durable book (keeps tests mockable).
 * Call signature is intentionally loose so real `postgres.Sql` is assignable.
 */
export type DepositAddressSql = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...values: any[]): Promise<readonly any[]>;
};

type DepositAddressRow = {
  payment_id: string;
  asset_id: string;
  address: string;
  hd_index: string | number | bigint;
};

/**
 * Postgres-backed book. Unique (payment, asset) and unique address are the
 * lock: two replicas cannot bind one deposit address to two payments, and a
 * restarted process reads the row it showed the payer.
 */
export class PostgresDepositAddressBook implements DepositAddressBook {
  constructor(private readonly sql: DepositAddressSql) {}

  async findByPayment(paymentId: string, assetId: string): Promise<DepositAddressAssignment | null> {
    const rows = (await this.sql`
      SELECT payment_id, asset_id, address, hd_index
        FROM pay.crypto_deposit_addresses
       WHERE payment_id = ${paymentId} AND asset_id = ${assetId}
    `) as ReadonlyArray<DepositAddressRow>;
    const row = rows[0];
    return row ? rowToAssignment(row) : null;
  }

  async findByAddress(address: string): Promise<DepositAddressAssignment | null> {
    const normalized = normalizeAddress(address);
    const rows = (await this.sql`
      SELECT payment_id, asset_id, address, hd_index
        FROM pay.crypto_deposit_addresses
       WHERE address = ${normalized}
    `) as ReadonlyArray<DepositAddressRow>;
    const row = rows[0];
    return row ? rowToAssignment(row) : null;
  }

  async list(): Promise<readonly DepositAddressAssignment[]> {
    const rows = (await this.sql`
      SELECT payment_id, asset_id, address, hd_index
        FROM pay.crypto_deposit_addresses
    `) as ReadonlyArray<DepositAddressRow>;
    return rows.map(rowToAssignment);
  }

  async claim(entry: DepositAddressAssignment): Promise<DepositAddressClaim> {
    assertHdIndex(entry.index);
    const address = normalizeAddress(entry.address);
    const inserted = (await this.sql`
      INSERT INTO pay.crypto_deposit_addresses (payment_id, asset_id, address, hd_index)
      VALUES (${entry.paymentId}, ${entry.assetId}, ${address}, ${entry.index})
      ON CONFLICT DO NOTHING
      RETURNING payment_id, asset_id, address, hd_index
    `) as ReadonlyArray<DepositAddressRow>;
    const row = inserted[0];
    if (row) return { kind: 'bound', entry: rowToAssignment(row) };

    const mine = await this.findByPayment(entry.paymentId, entry.assetId);
    if (mine) return { kind: 'bound', entry: mine };

    const holder = await this.findByAddress(address);
    if (holder) return { kind: 'taken', entry: holder };

    throw new Error('deposit address claim conflicted but no assignment row was found');
  }
}

function normalizeAddress(address: string): string {
  return getAddress(address);
}

function assertHdIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`deposit address index must be a uint32 (got ${index})`);
  }
}

function readHdIndex(raw: string | number | bigint): number {
  const value = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`deposit address hd_index must be a non-negative integer (got ${String(raw)})`);
  }
  return value;
}

function rowToAssignment(row: DepositAddressRow): DepositAddressAssignment {
  return {
    paymentId: row.payment_id,
    assetId: row.asset_id,
    address: normalizeAddress(row.address),
    index: readHdIndex(row.hd_index),
  };
}
