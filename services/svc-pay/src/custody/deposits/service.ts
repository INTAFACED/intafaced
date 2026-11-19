import type { Sql } from 'postgres';
import type {
  PayCustodyDepositAddress,
  PayCustodyDepositAddressInput,
  PayCustodyDepositAddressReply,
  PayCustodyDepositCatalogue,
} from '@intafaced/contracts';
import type { CryptoChainPort } from '../../rails/chain-port.js';
import type { RegistryReader } from '../../registries/read-api.js';

/**
 * Customer crypto deposit addresses (W-deposit-01). NO BALANCE LIVES HERE: this issues an address and credits nothing.
 *
 * - The CATALOGUE is the owner's settings (`custody_deposit_settings`) joined to a network the registry calls routable (enabled,
 *   confirmation count set) that lists the asset. A pair the owner switched off on such a network, once it had been switched on
 *   or given a note, is listed as `halted` with the owner's note and takes no address; one never launched is not mentioned. A pair missing from either side is not published, so a blank minimum or
 *   confirmation count never reaches a customer. `memoRequired` and `sharedAddressGroup` are always false and null: the one
 *   chain behind the port routes by address and attributes a deposit by address, so a shared address would credit the wrong
 *   asset. A memo-routed or shared-address network needs a source that can attribute them (W-deposit-05).
 * - An ADDRESS is derived by the chain port from `deposit-user:<userId>` and the asset, so it is the same on every replica,
 *   and is then stored. The first stored address is the one every later call returns. If the store refuses because another
 *   row on that network already holds the address, this throws and issues nothing: an address is never given to two people.
 * - EXTRA ADDRESSES (W-deposit-02). Index 0 is the first address, which never expires. An extra index is derived from
 *   `deposit-user-extra:<index>:<userId>` (a prefix no first-address reference has, the index before the free-text id, so no
 *   two references are equal) and stored with the expiry svc-bank sent the first time it was asked; a later call for the same
 *   index returns the stored address and its stored expiry, whatever expiry it carries. A new extra address whose expiry has
 *   already passed is refused. How many a person may hold is the owner's cap, which svc-bank enforces before it asks. The
 *   reply names the index and expiry only for an extra address, so a reader on the older contract still reads index 0.
 */

export const DEPOSIT_USER_REF_PREFIX = 'deposit-user:';
export const DEPOSIT_USER_EXTRA_REF_PREFIX = 'deposit-user-extra:';

/** The chain reference an address is derived from. Index 0 keeps the reference every address issued before extras had. */
export function depositUserRef(userId: string, addressIndex: number): string {
  return addressIndex === 0 ? `${DEPOSIT_USER_REF_PREFIX}${userId}` : `${DEPOSIT_USER_EXTRA_REF_PREFIX}${addressIndex}:${userId}`;
}

type StoredAddress = PayCustodyDepositAddress;

const ADDRESS_UNIQUE_INDEX = 'custody_deposit_addresses_network_address_uq';

/** A unique violation on the (network, address) index: some row on that network already holds the address. */
function isAddressClash(error: unknown): boolean {
  const pg = error as { code?: string; constraint_name?: string } | null;
  return pg?.code === '23505' && pg.constraint_name === ADDRESS_UNIQUE_INDEX;
}

export interface CustodyDepositServiceDeps {
  readonly sql: Sql;
  readonly chain: Pick<CryptoChainPort, 'acceptanceAddress' | 'posture'>;
  readonly registries: Pick<RegistryReader, 'listRoutableNetworks'>;
}

interface SettingRow {
  asset_id: string;
  network_id: string;
  label: string;
  minimum_deposit: string;
  estimated_arrival_minutes: number;
  unsupported_cases: string[];
  enabled: boolean;
  halt_note: string | null;
}

export class CustodyDepositService {
  constructor(private readonly deps: CustodyDepositServiceDeps) {}

  async catalogue(): Promise<PayCustodyDepositCatalogue> {
    const [networks, settings] = await Promise.all([
      this.deps.registries.listRoutableNetworks(),
      this.deps.sql<SettingRow[]>`
        SELECT s.asset_id, s.network_id, s.label, s.minimum_deposit, s.estimated_arrival_minutes, s.unsupported_cases, s.enabled,
               s.halt_note
          FROM pay.custody_deposit_settings s
         WHERE s.enabled
            -- Switched off after it was on, or given a note for customers. A pair created off and never switched on has not
            -- launched: customers are not told about it.
            OR s.halt_note IS NOT NULL
            OR EXISTS (
                 SELECT 1 FROM pay.custody_deposit_setting_events e
                  WHERE e.asset_id = s.asset_id AND e.network_id = s.network_id AND e.after->>'enabled' = 'true')
         ORDER BY s.asset_id, s.network_id`,
    ]);
    const byNetwork = new Map(networks.map((n) => [n.networkId, n]));
    const entries: PayCustodyDepositCatalogue['entries'] = [];
    const halted: NonNullable<PayCustodyDepositCatalogue['halted']> = [];
    for (const row of settings) {
      const network = byNetwork.get(row.network_id);
      if (!network || network.confirmationsRequired === null || !network.assetCodes.includes(row.asset_id)) continue;
      // Switched off by the owner (after launch) on a network that would otherwise take it: named, with the owner's note, and
      // given no address.
      if (!row.enabled) {
        halted.push({ assetId: row.asset_id, networkId: row.network_id, label: row.label, haltNote: row.halt_note });
        continue;
      }
      entries.push({
        assetId: row.asset_id,
        networkId: row.network_id,
        label: row.label,
        minimumDeposit: row.minimum_deposit,
        confirmationsRequired: network.confirmationsRequired,
        estimatedArrivalMinutes: row.estimated_arrival_minutes,
        memoRequired: false,
        sharedAddressGroup: null,
        // Sent only when the owner published some: no list is no key, as the contract has it (an empty list is refused there).
        ...(row.unsupported_cases.length > 0 ? { unsupported: row.unsupported_cases } : {}),
      });
    }
    return { entries, halted };
  }

  async address(input: PayCustodyDepositAddressInput): Promise<PayCustodyDepositAddressReply> {
    const { entries } = await this.catalogue();
    if (!entries.some((e) => e.assetId === input.assetId && e.networkId === input.networkId)) {
      return { state: 'refused', code: 'pay.deposit_pair_unpublished' };
    }
    const index = input.addressIndex ?? 0;
    // The contract already refuses an extra address without an expiry and a first address with one; this keeps the store honest.
    const expiresAt = input.expiresAt ?? null;
    if ((index === 0) !== (expiresAt === null)) throw new Error('pay.deposit_address_expiry_mismatch');
    const existing = await this.stored(input.userId, input.assetId, input.networkId, index);
    if (existing) return { state: 'issued', address: existing };
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) return { state: 'refused', code: 'pay.deposit_address_expiry_past' };
    if (this.deps.chain.posture === 'absent') return { state: 'refused', code: 'pay.deposit_source_unset' };

    let derived: string;
    try {
      derived = await this.deps.chain.acceptanceAddress(depositUserRef(input.userId, index), input.assetId);
    } catch {
      return { state: 'refused', code: 'pay.deposit_source_unset' };
    }
    try {
      await this.deps.sql`
        INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at)
        VALUES (${input.userId}, ${input.assetId}, ${input.networkId}, ${index}, ${derived}, ${expiresAt})
        ON CONFLICT (user_id, asset_id, network_id, address_index) DO NOTHING`;
    } catch (error) {
      // Two first calls for one person can both pass the read above and insert at once. Postgres then checks the
      // (network, address) index before the key ON CONFLICT names, so the loser sees a unique violation instead of nothing.
      // When the row that won is this person's own, with this address, that is the lost race: return it. Anyone else holding
      // the address means two people derived one address, which must be seen and must issue nothing.
      if (!isAddressClash(error)) throw error;
      const won = await this.stored(input.userId, input.assetId, input.networkId, index);
      if (!won || won.address.toLowerCase() !== derived.toLowerCase()) throw error;
      return { state: 'issued', address: won };
    }
    // A lost insert race on the key returns the row that won, with its own expiry.
    const row = await this.stored(input.userId, input.assetId, input.networkId, index);
    if (!row) throw new Error('pay.deposit_address_not_stored');
    return { state: 'issued', address: row };
  }

  private async stored(userId: string, assetId: string, networkId: string, index: number): Promise<StoredAddress | null> {
    const rows = await this.deps.sql<Array<{ address: string; memo: string | null; address_index: number; expires_at: Date | null }>>`
      SELECT address, memo, address_index, expires_at FROM pay.custody_deposit_addresses
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND network_id = ${networkId} AND address_index = ${index}`;
    const row = rows[0];
    if (!row) return null;
    const first = { address: row.address, memo: row.memo, qrPayload: null };
    return row.address_index === 0
      ? first
      : { ...first, addressIndex: row.address_index, expiresAt: row.expires_at?.toISOString() ?? null };
  }
}
