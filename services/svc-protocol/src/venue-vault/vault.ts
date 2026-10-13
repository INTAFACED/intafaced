/**
 * VENUE VAULT (S-L6 / §27) — per-user encrypted external venue keys.
 *
 * This is key custody for *custodial venues*, not Protocol Plane balances.
 * Ciphertext never lands in `protocol.*` postgres (that schema is a read model
 * and forbids key material). The store is a seam: tests use memory; durable
 * HSM-backed persistence is Nitro residual.
 *
 * Non-negotiable: a withdrawal-capable key is refused at register. There is no
 * "store it and strip withdraw later" path.
 */
import { randomUUID } from 'node:crypto';
import { assertTradeOnly, type VenueKeyPermissions } from './permissions.js';
import { unwrapSecret, wrapSecret, VenueVaultUnwrapFailedError, type WrappedSecret } from './wrap.js';

export type VenueCredential = {
  readonly venueId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly permissions: VenueKeyPermissions;
};

export type StoredVenueKey = {
  readonly id: string;
  readonly userId: string;
  readonly venueId: string;
  readonly wrapped: WrappedSecret;
};

export interface VenueVaultStore {
  put(row: StoredVenueKey): Promise<void>;
  get(id: string): Promise<StoredVenueKey | null>;
  listByUser(userId: string): Promise<readonly StoredVenueKey[]>;
}

export class MemoryVenueVaultStore implements VenueVaultStore {
  readonly rows = new Map<string, StoredVenueKey>();

  async put(row: StoredVenueKey): Promise<void> {
    this.rows.set(row.id, row);
  }
  async get(id: string): Promise<StoredVenueKey | null> {
    return this.rows.get(id) ?? null;
  }
  async listByUser(userId: string): Promise<readonly StoredVenueKey[]> {
    return [...this.rows.values()].filter((r) => r.userId === userId);
  }
}

export class VenueVaultNotFoundError extends Error {
  readonly code = 'venue_vault.not_found' as const;
  constructor() {
    super('venue vault record not found for this user');
    this.name = 'VenueVaultNotFoundError';
  }
}

/** Unambiguous identity commitment for this ciphertext, including same-user records. */
function recordAad(userId: string, id: string, venueId: string): Buffer {
  return Buffer.from(JSON.stringify(['intafaced.venue-vault.v1', userId, id, venueId]), 'utf8');
}

export class VenueVault {
  constructor(
    private readonly store: VenueVaultStore,
    private readonly kek: Buffer,
  ) {}

  async register(userId: string, credential: VenueCredential): Promise<{ id: string }> {
    assertTradeOnly(credential.permissions);
    const plaintext = Buffer.from(
      JSON.stringify({
        apiKey: credential.apiKey,
        apiSecret: credential.apiSecret,
        permissions: credential.permissions,
        venueId: credential.venueId,
      }),
      'utf8',
    );
    const id = randomUUID();
    // Buffers are zeroed (best effort; JS strings cannot be wiped): the
    // JSON.stringify result and credential strings stay in memory until GC.
    let wrapped: WrappedSecret;
    try {
      wrapped = wrapSecret(this.kek, plaintext, recordAad(userId, id, credential.venueId));
    } finally {
      plaintext.fill(0);
    }
    await this.store.put({ id, userId, venueId: credential.venueId, wrapped });
    return { id };
  }

  async unwrapForTrade(userId: string, id: string): Promise<VenueCredential> {
    const row = await this.store.get(id);
    if (!row || row.id !== id || row.userId !== userId) throw new VenueVaultNotFoundError();
    const opened = unwrapSecret(this.kek, row.wrapped, recordAad(userId, id, row.venueId));
    let parsed: VenueCredential;
    // Buffers are zeroed (best effort; JS strings cannot be wiped): the strings
    // from toString() and JSON.parse stay in memory until GC.
    try {
      parsed = JSON.parse(opened.toString('utf8')) as VenueCredential;
      if (parsed.venueId !== row.venueId) throw new VenueVaultUnwrapFailedError();
    } finally {
      opened.fill(0);
    }
    // Defence in depth — a poisoned store still cannot yield withdraw keys.
    assertTradeOnly(parsed.permissions);
    return parsed;
  }
}
