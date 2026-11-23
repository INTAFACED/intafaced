import { getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import type { ChainIdentityReader } from '../chain/identity.js';

/**
 * ACCOUNT REGISTRY — address ↔ user id. A read model, not custody.
 *
 * The registry answers one question: "which smart account belongs to this
 * INTAFACED user?". That is a convenience for the product surfaces, and it is
 * all it is. Deleting this table would cost users their account list in the UI
 * and cost them nothing else — their funds are at an address derived from their
 * own key, on a chain we do not run, reachable with no help from us.
 *
 * That property is worth stating precisely because it is what "non-custodial"
 * has to mean in practice: not that we promise not to touch the funds, but that
 * the entire platform could disappear and the user would lose nothing but a
 * convenience.
 */

export interface AccountRecord {
  readonly id: string;
  readonly userId: string;
  readonly chainId: number;
  readonly address: Address;
  readonly owner: Address;
  readonly userSalt: Hex;
  readonly deployed: boolean;
  /** The genesis of the chain `deployed` was seen on; null when not deployed or stored before the column. */
  readonly deployedGenesisHash?: Hex | null;
  /** When the user proved control of the owner key. Null = unverified claim. */
  readonly verifiedAt: Date | null;
}

export interface AccountUpsert {
  userId: string;
  chainId: number;
  address: Address;
  owner: Address;
  userSalt: Hex;
  deployed: boolean;
  /** The genesis of the chain `deployed` was read on (set with `deployed: true`). */
  deployedGenesisHash?: Hex | null;
  verifiedAt: Date | null;
}

/**
 * Storage seam. `PostgresAccountStore` is the production implementation;
 * `MemoryAccountStore` is what the tests use, so registry logic is provable
 * without a database.
 */
export interface AccountStore {
  findByAddress(chainId: number, address: Address): Promise<AccountRecord | null>;
  markDeployed(chainId: number, address: Address, at: Date, genesisHash: Hex | null): Promise<void>;
}

export class MemoryAccountStore implements AccountStore {
  readonly rows = new Map<string, AccountRecord>();
  #seq = 0;

  #key(chainId: number, address: Address): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  /** Seeds a row. Nothing in the service writes one any more (the claim call is gone); tests seed with this. */
  async upsert(record: AccountUpsert): Promise<AccountRecord> {
    const key = this.#key(record.chainId, record.address);
    const existing = this.rows.get(key);
    const next: AccountRecord = {
      id: existing?.id ?? `mem-${++this.#seq}`,
      userId: record.userId,
      chainId: record.chainId,
      address: toChecksum(record.address),
      owner: toChecksum(record.owner),
      userSalt: record.userSalt,
      deployed: record.deployed || (existing?.deployed ?? false),
      deployedGenesisHash: record.deployed ? (record.deployedGenesisHash ?? null) : (existing?.deployedGenesisHash ?? null),
      verifiedAt: record.verifiedAt ?? existing?.verifiedAt ?? null,
    };
    this.rows.set(key, next);
    return next;
  }

  async findByAddress(chainId: number, address: Address): Promise<AccountRecord | null> {
    return this.rows.get(this.#key(chainId, address)) ?? null;
  }

  async markDeployed(chainId: number, address: Address, _at: Date, genesisHash: Hex | null): Promise<void> {
    const key = this.#key(chainId, address);
    const existing = this.rows.get(key);
    if (existing) this.rows.set(key, { ...existing, deployed: true, deployedGenesisHash: genesisHash });
  }
}

export interface RegistryConfig {
  readonly chainId: number;
}

export class AccountRegistry {
  constructor(
    private readonly store: AccountStore,
    private readonly config: RegistryConfig,
    /**
     * Which chain `deployed` is read on. A deployment seen on another genesis (a TEST chain since started again) is
     * not one on this chain, so the account reads as not deployed. Absent: the stored flag is returned as it is.
     */
    private readonly identity?: ChainIdentityReader,
  ) {}

  /** The genesis a deployment is stored with, read afresh: a deployment is never labelled with a chain since gone. */
  async #genesis(): Promise<Hex | null> {
    return this.identity ? (await this.identity({ fresh: true })).genesisHash : null;
  }

  async ownerOfRecord(address: Address): Promise<AccountRecord | null> {
    // Whether the address has a row, which the chain observer asks for every event. It never reads the chain, so a block 0
    // read that fails cannot drop an event; `deployed` here is the stored flag.
    return this.store.findByAddress(this.config.chainId, address);
  }

  async recordDeployment(address: Address, at: Date = new Date()): Promise<void> {
    // The deployment is recorded even when block 0 cannot be read right now: the event is not dropped, and the row is
    // stored with no genesis, as one from before the column.
    const genesis = await this.#genesis().catch(() => null);
    await this.store.markDeployed(this.config.chainId, address, at, genesis);
  }
}
