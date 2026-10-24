import type { Sql } from 'postgres';
import type { PayCustodyDepositAddressInput, PayCustodyDepositAddressReply, PayCustodyDepositCatalogue } from '@intafaced/contracts';
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
 */

export const DEPOSIT_USER_REF_PREFIX = 'deposit-user:';

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
  enabled: boolean;
  halt_note: string | null;
}

export class CustodyDepositService {
  constructor(private readonly deps: CustodyDepositServiceDeps) {}

  async catalogue(): Promise<PayCustodyDepositCatalogue> {
    const [networks, settings] = await Promise.all([
      this.deps.registries.listRoutableNetworks(),
      this.deps.sql<SettingRow[]>`
        SELECT s.asset_id, s.network_id, s.label, s.minimum_deposit, s.estimated_arrival_minutes, s.enabled, s.halt_note
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
      });
    }
    return { entries, halted };
  }

  async address(input: PayCustodyDepositAddressInput): Promise<PayCustodyDepositAddressReply> {
    const { entries } = await this.catalogue();
    if (!entries.some((e) => e.assetId === input.assetId && e.networkId === input.networkId)) {
      return { state: 'refused', code: 'pay.deposit_pair_unpublished' };
    }
    const existing = await this.stored(input);
    if (existing) return { state: 'issued', address: existing };
    if (this.deps.chain.posture === 'absent') return { state: 'refused', code: 'pay.deposit_source_unset' };

    let derived: string;
    try {
      derived = await this.deps.chain.acceptanceAddress(`${DEPOSIT_USER_REF_PREFIX}${input.userId}`, input.assetId);
    } catch {
      return { state: 'refused', code: 'pay.deposit_source_unset' };
    }
    const inserted = await this.deps.sql<Array<{ address: string }>>`
      INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address)
      VALUES (${input.userId}, ${input.assetId}, ${input.networkId}, ${derived})
      ON CONFLICT (user_id, asset_id, network_id) DO NOTHING
      RETURNING address`;
    // A unique violation on (network, address) is not caught here: it means two people derived one address, which must be
    // seen and must issue nothing.
    const row = inserted[0] ? { address: inserted[0].address, memo: null } : await this.stored(input);
    if (!row) throw new Error('pay.deposit_address_not_stored');
    return { state: 'issued', address: { address: row.address, memo: null, qrPayload: null } };
  }

  private async stored(input: PayCustodyDepositAddressInput): Promise<{ address: string; memo: string | null; qrPayload: null } | null> {
    const rows = await this.deps.sql<Array<{ address: string; memo: string | null }>>`
      SELECT address, memo FROM pay.custody_deposit_addresses
       WHERE user_id = ${input.userId} AND asset_id = ${input.assetId} AND network_id = ${input.networkId}`;
    return rows[0] ? { address: rows[0].address, memo: rows[0].memo, qrPayload: null } : null;
  }
}
