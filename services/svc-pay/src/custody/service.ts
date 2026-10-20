import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { CustodyError } from './errors.js';
import type {
  AccountView,
  EntityCreateInput,
  EntityListInput,
  EntityView,
  OwnerLookup,
  VaultCreateInput,
  VaultView,
  WalletTypeView,
  WalletView,
} from './schemas.js';

/**
 * The custody account model (W-custody-ops-01): entities, vault accounts and the wallets inside them. It holds no
 * balance and moves no value; the ledger stays the only book. Every write appends to `pay.custody_events` in the same
 * transaction. A vault is renamed or hidden, never deleted, and the reconciliation read lists hidden vaults too.
 */
export interface CustodyServiceDeps {
  readonly sql: Sql;
}

interface EntityRow {
  entity_id: string;
  display_name: string;
  ownership: 'entity_owned' | 'customer_attributed';
  environment: 'sandbox' | 'testnet' | 'mainnet';
  customer_ref: string | null;
  created_at: Date;
  created_by: string;
}
interface VaultRow {
  vault_id: string;
  entity_id: string;
  client_ref: string;
  name: string;
  hidden: boolean;
  version: number;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}
interface WalletRow {
  wallet_id: string;
  vault_id: string;
  entity_id: string;
  network_id: string;
  asset_code: string;
  address: string | null;
  created_at: Date;
  created_by: string;
}

const entityView = (r: EntityRow): EntityView => ({
  entityId: r.entity_id,
  displayName: r.display_name,
  ownership: r.ownership,
  environment: r.environment,
  testBadge: r.environment !== 'mainnet',
  customerRef: r.customer_ref,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
});
const vaultView = (r: VaultRow): VaultView => ({
  vaultId: r.vault_id,
  entityId: r.entity_id,
  clientRef: r.client_ref,
  name: r.name,
  hidden: r.hidden,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by,
});
const walletView = (r: WalletRow): WalletView => ({
  walletId: r.wallet_id,
  vaultId: r.vault_id,
  entityId: r.entity_id,
  networkId: r.network_id,
  assetCode: r.asset_code,
  address: r.address,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
});

export class CustodyService {
  constructor(private readonly deps: CustodyServiceDeps) {}

  /** The networks and assets a wallet can be for: the network registry, as it stands. Empty until a founder adds one. */
  async walletTypes(): Promise<WalletTypeView[]> {
    const rows = await this.deps.sql<Array<{ network_id: string; display_name: string; enabled: boolean; asset_codes: unknown }>>`
      SELECT network_id, display_name, enabled, asset_codes FROM pay.network_registry ORDER BY network_id`;
    return rows.map((r) => ({
      networkId: r.network_id,
      displayName: r.display_name,
      enabled: r.enabled,
      assetCodes: (Array.isArray(r.asset_codes) ? r.asset_codes : []).filter((c): c is string => typeof c === 'string'),
    }));
  }

  async createEntity(actor: string, input: EntityCreateInput): Promise<EntityView> {
    if ((input.ownership === 'customer_attributed') !== (input.customerRef !== undefined)) {
      throw new CustodyError(
        'custody.entity_differs',
        input.ownership === 'customer_attributed'
          ? 'a customer-attributed entity names its customer'
          : 'an entity-owned entity names no customer',
      );
    }
    return transaction(this.deps.sql, async (tx) => {
      const inserted = await tx<EntityRow[]>`
        INSERT INTO pay.custody_entities (entity_id, display_name, ownership, environment, customer_ref, created_by)
        VALUES (${input.entityId}, ${input.displayName}, ${input.ownership}, ${input.environment}, ${input.customerRef ?? null}, ${actor})
        ON CONFLICT DO NOTHING
        RETURNING *`;
      if (inserted[0]) {
        await this.event(tx, 'entity', input.entityId, 'create', actor, {
          ownership: input.ownership,
          environment: input.environment,
        });
        return entityView(inserted[0]);
      }
      const [existing] = await tx<EntityRow[]>`SELECT * FROM pay.custody_entities WHERE entity_id = ${input.entityId}`;
      if (!existing) {
        throw new CustodyError('custody.customer_already_has_entity', 'this customer already has an entity in this environment');
      }
      const same =
        existing.display_name === input.displayName &&
        existing.ownership === input.ownership &&
        existing.environment === input.environment &&
        existing.customer_ref === (input.customerRef ?? null);
      if (!same) throw new CustodyError('custody.entity_differs', `entity "${input.entityId}" already exists with other details`);
      return entityView(existing);
    });
  }

  async listEntities(input: EntityListInput): Promise<EntityView[]> {
    const rows = await this.deps.sql<EntityRow[]>`
      SELECT * FROM pay.custody_entities
       WHERE (${input.after ?? null}::text IS NULL OR entity_id > ${input.after ?? null})
         AND (${input.environment ?? null}::text IS NULL OR environment = ${input.environment ?? null})
       ORDER BY entity_id LIMIT ${input.limit}`;
    return rows.map(entityView);
  }

  /** The ownership read: entity-owned versus customer-attributed, with counts only. */
  async listAccounts(input: EntityListInput): Promise<AccountView[]> {
    const rows = await this.deps.sql<Array<EntityRow & { vaults: string; hidden_vaults: string; wallets: string }>>`
      SELECT e.*,
             (SELECT count(*) FROM pay.custody_vaults v WHERE v.entity_id = e.entity_id) AS vaults,
             (SELECT count(*) FROM pay.custody_vaults v WHERE v.entity_id = e.entity_id AND v.hidden) AS hidden_vaults,
             (SELECT count(*) FROM pay.custody_wallets w JOIN pay.custody_vaults v ON v.vault_id = w.vault_id
               WHERE v.entity_id = e.entity_id) AS wallets
        FROM pay.custody_entities e
       WHERE (${input.after ?? null}::text IS NULL OR e.entity_id > ${input.after ?? null})
         AND (${input.environment ?? null}::text IS NULL OR e.environment = ${input.environment ?? null})
       ORDER BY e.entity_id LIMIT ${input.limit}`;
    return rows.map((r) => ({
      ...entityView(r),
      vaults: Number(r.vaults),
      hiddenVaults: Number(r.hidden_vaults),
      wallets: Number(r.wallets),
    }));
  }

  async getAccount(entityId: string): Promise<AccountView> {
    const rows = await this.deps.sql<Array<EntityRow & { vaults: string; hidden_vaults: string; wallets: string }>>`
      SELECT e.*,
             (SELECT count(*) FROM pay.custody_vaults v WHERE v.entity_id = e.entity_id) AS vaults,
             (SELECT count(*) FROM pay.custody_vaults v WHERE v.entity_id = e.entity_id AND v.hidden) AS hidden_vaults,
             (SELECT count(*) FROM pay.custody_wallets w JOIN pay.custody_vaults v ON v.vault_id = w.vault_id
               WHERE v.entity_id = e.entity_id) AS wallets
        FROM pay.custody_entities e WHERE e.entity_id = ${entityId}`;
    const r = rows[0];
    if (!r) throw new CustodyError('custody.entity_not_found', `no entity "${entityId}"`);
    return { ...entityView(r), vaults: Number(r.vaults), hiddenVaults: Number(r.hidden_vaults), wallets: Number(r.wallets) };
  }

  /** The same business key twice is one vault; the same key with another name is a conflict, never a second vault. */
  async createVault(actor: string, input: VaultCreateInput): Promise<VaultView> {
    return transaction(this.deps.sql, async (tx) => {
      const [entity] = await tx<
        Array<{ entity_id: string }>
      >`SELECT entity_id FROM pay.custody_entities WHERE entity_id = ${input.entityId}`;
      if (!entity) throw new CustodyError('custody.entity_not_found', `no entity "${input.entityId}"`);
      const [existing] = await tx<VaultRow[]>`
        SELECT * FROM pay.custody_vaults WHERE entity_id = ${input.entityId} AND client_ref = ${input.clientRef}`;
      if (existing) {
        if (existing.name !== input.name) {
          throw new CustodyError('custody.vault_differs', `reference "${input.clientRef}" already names a vault called "${existing.name}"`);
        }
        return vaultView(existing);
      }
      await this.requireFreeName(tx, input.entityId, input.name, null);
      const [row] = await tx<VaultRow[]>`
        INSERT INTO pay.custody_vaults (entity_id, client_ref, name, created_by, updated_by)
        VALUES (${input.entityId}, ${input.clientRef}, ${input.name}, ${actor}, ${actor})
        RETURNING *`;
      await this.event(tx, 'vault', row!.vault_id, 'create', actor, { entityId: input.entityId, name: input.name });
      return vaultView(row!);
    });
  }

  async renameVault(actor: string, vaultId: string, name: string, expectedVersion: number): Promise<VaultView> {
    return transaction(this.deps.sql, async (tx) => {
      const current = await this.lockVault(tx, vaultId, expectedVersion);
      if (current.name === name) return vaultView(current);
      await this.requireFreeName(tx, current.entity_id, name, vaultId);
      const [row] = await tx<VaultRow[]>`
        UPDATE pay.custody_vaults SET name = ${name}, version = version + 1, updated_at = now(), updated_by = ${actor}
         WHERE vault_id = ${vaultId} RETURNING *`;
      await this.event(tx, 'vault', vaultId, 'rename', actor, { from: current.name, to: name });
      return vaultView(row!);
    });
  }

  /** Hiding only takes a vault out of the default list. The reconciliation read always lists it. */
  async setVaultHidden(actor: string, vaultId: string, hidden: boolean, expectedVersion: number): Promise<VaultView> {
    return transaction(this.deps.sql, async (tx) => {
      const current = await this.lockVault(tx, vaultId, expectedVersion);
      if (current.hidden === hidden) return vaultView(current);
      const [row] = await tx<VaultRow[]>`
        UPDATE pay.custody_vaults SET hidden = ${hidden}, version = version + 1, updated_at = now(), updated_by = ${actor}
         WHERE vault_id = ${vaultId} RETURNING *`;
      await this.event(tx, 'vault', vaultId, hidden ? 'hide' : 'unhide', actor, {});
      return vaultView(row!);
    });
  }

  async listVaults(entityId: string, visibility: 'visible' | 'hidden' | 'all', limit: number, after?: string): Promise<VaultView[]> {
    const rows = await this.deps.sql<VaultRow[]>`
      SELECT * FROM pay.custody_vaults
       WHERE entity_id = ${entityId}
         AND (${after ?? null}::uuid IS NULL OR vault_id > ${after ?? null})
         AND (${visibility} = 'all' OR hidden = (${visibility} = 'hidden'))
       ORDER BY vault_id LIMIT ${limit}`;
    return rows.map(vaultView);
  }

  /** Every vault of every entity, hidden ones included. Nothing can filter a vault out of this read. */
  async reconciliationVaults(limit: number, after?: string): Promise<VaultView[]> {
    const rows = await this.deps.sql<VaultRow[]>`
      SELECT * FROM pay.custody_vaults WHERE (${after ?? null}::uuid IS NULL OR vault_id > ${after ?? null})
       ORDER BY vault_id LIMIT ${limit}`;
    return rows.map(vaultView);
  }

  /** A wallet is a network and asset inside a vault. It has no address until address assignment fills it in. */
  async addWallet(actor: string, vaultId: string, networkId: string, assetCode: string): Promise<WalletView> {
    return transaction(this.deps.sql, async (tx) => {
      const [vault] = await tx<VaultRow[]>`SELECT * FROM pay.custody_vaults WHERE vault_id = ${vaultId}`;
      if (!vault) throw new CustodyError('custody.vault_not_found', 'no such vault');
      const [network] = await tx<
        Array<{ asset_codes: unknown }>
      >`SELECT asset_codes FROM pay.network_registry WHERE network_id = ${networkId}`;
      if (!network) throw new CustodyError('custody.network_unknown', `network "${networkId}" is not in the registry`);
      const codes = Array.isArray(network.asset_codes) ? network.asset_codes : [];
      if (!codes.includes(assetCode)) {
        throw new CustodyError('custody.asset_not_on_network', `${assetCode} is not listed on network "${networkId}"`);
      }
      const inserted = await tx<Array<{ wallet_id: string }>>`
        INSERT INTO pay.custody_wallets (vault_id, network_id, asset_code, created_by)
        VALUES (${vaultId}, ${networkId}, ${assetCode}, ${actor})
        ON CONFLICT (vault_id, network_id, asset_code) DO NOTHING RETURNING wallet_id`;
      if (inserted[0]) {
        await this.event(tx, 'wallet', inserted[0].wallet_id, 'create', actor, { vaultId, networkId, assetCode });
      }
      const [row] = await tx<WalletRow[]>`
        SELECT w.wallet_id, w.vault_id, v.entity_id, w.network_id, w.asset_code, w.address, w.created_at, w.created_by
          FROM pay.custody_wallets w JOIN pay.custody_vaults v ON v.vault_id = w.vault_id
         WHERE w.vault_id = ${vaultId} AND w.network_id = ${networkId} AND w.asset_code = ${assetCode}`;
      return walletView(row!);
    });
  }

  async listWallets(vaultId: string, limit: number, after?: string): Promise<WalletView[]> {
    const rows = await this.deps.sql<WalletRow[]>`
      SELECT w.wallet_id, w.vault_id, v.entity_id, w.network_id, w.asset_code, w.address, w.created_at, w.created_by
        FROM pay.custody_wallets w JOIN pay.custody_vaults v ON v.vault_id = w.vault_id
       WHERE w.vault_id = ${vaultId} AND (${after ?? null}::uuid IS NULL OR w.wallet_id > ${after ?? null})
       ORDER BY w.wallet_id LIMIT ${limit}`;
    return rows.map(walletView);
  }

  async getWallet(walletId: string): Promise<WalletView> {
    const [row] = await this.deps.sql<WalletRow[]>`
      SELECT w.wallet_id, w.vault_id, v.entity_id, w.network_id, w.asset_code, w.address, w.created_at, w.created_by
        FROM pay.custody_wallets w JOIN pay.custody_vaults v ON v.vault_id = w.vault_id WHERE w.wallet_id = ${walletId}`;
    if (!row) throw new CustodyError('custody.wallet_not_found', 'no such wallet');
    return walletView(row);
  }

  /** The owner of an address, or a typed not-found. An address no wallet holds is never guessed at. */
  async lookupByAddress(networkId: string, address: string): Promise<OwnerLookup> {
    const [row] = await this.deps.sql<WalletRow[]>`
      SELECT w.wallet_id, w.vault_id, v.entity_id, w.network_id, w.asset_code, w.address, w.created_at, w.created_by
        FROM pay.custody_wallets w JOIN pay.custody_vaults v ON v.vault_id = w.vault_id
       WHERE w.network_id = ${networkId} AND w.address = ${address}`;
    if (!row) throw new CustodyError('custody.address_not_found', 'no wallet holds this address on this network');
    const [vault] = await this.deps.sql<VaultRow[]>`SELECT * FROM pay.custody_vaults WHERE vault_id = ${row.vault_id}`;
    const [entity] = await this.deps.sql<EntityRow[]>`SELECT * FROM pay.custody_entities WHERE entity_id = ${row.entity_id}`;
    return { wallet: walletView(row), vault: vaultView(vault!), entity: entityView(entity!) };
  }

  private async lockVault(tx: Sql, vaultId: string, expectedVersion: number): Promise<VaultRow> {
    const [row] = await tx<VaultRow[]>`SELECT * FROM pay.custody_vaults WHERE vault_id = ${vaultId} FOR UPDATE`;
    if (!row) throw new CustodyError('custody.vault_not_found', 'no such vault');
    if (row.version !== expectedVersion) {
      throw new CustodyError('custody.version_conflict', `the vault is at version ${row.version}, not ${expectedVersion}`);
    }
    return row;
  }

  private async requireFreeName(tx: Sql, entityId: string, name: string, exceptVaultId: string | null): Promise<void> {
    const taken = await tx<Array<{ vault_id: string }>>`
      SELECT vault_id FROM pay.custody_vaults
       WHERE entity_id = ${entityId} AND lower(btrim(name)) = lower(btrim(${name}))
         AND (${exceptVaultId}::uuid IS NULL OR vault_id <> ${exceptVaultId})`;
    if (taken[0]) throw new CustodyError('custody.name_taken', `a vault called "${name}" already exists for this entity`);
  }

  private async event(tx: Sql, kind: string, subjectId: string, action: string, actor: string, detail: Record<string, unknown>) {
    await tx`
      INSERT INTO pay.custody_events (subject_kind, subject_id, action, actor_id, detail)
      VALUES (${kind}, ${subjectId}, ${action}, ${actor}, ${tx.json(detail as never)})`;
  }
}
