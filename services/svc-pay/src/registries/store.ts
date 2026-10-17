import type { Sql } from 'postgres';
import type { NetworkState, VenueState, WalletRouteState } from './policy.js';
import type { RegistryKind } from './schemas.js';

/**
 * Row access for the three registries and their audit trail. SQL only, no
 * rules: every decision lives in policy.ts and service.ts.
 *
 * A reader (`FOR UPDATE` false) never locks. A writer reads the current row
 * with `FOR UPDATE` inside its transaction and compares the version before it
 * writes, so two founders editing one entry cannot overwrite each other.
 */

export interface Stamp {
  version: number;
  updatedAt: Date;
  updatedBy: string;
}
export type Stored<S> = S & Stamp;
export type StoredWalletRoute = Stored<WalletRouteState> & { routeId: string };

interface VenueRow {
  venue_id: string;
  display_name: string;
  mode: 'disabled' | 'testnet';
  priority: number;
  enabled: boolean;
  min_order: string | null;
  max_order: string | null;
  supported_pairs: string[];
  version: number;
  updated_at: Date;
  updated_by: string;
}
interface NetworkRow {
  network_id: string;
  display_name: string;
  asset_codes: string[];
  confirmations_required: number | null;
  enabled: boolean;
  fee_estimate_source: NetworkState['feeEstimateSource'];
  fee_estimate_amount: string | null;
  version: number;
  updated_at: Date;
  updated_by: string;
}
interface WalletRouteRow {
  route_id: string;
  asset_code: string;
  network_id: string;
  payout_allowed: boolean;
  merchant_allow: string[];
  merchant_deny: string[];
  max_single_payout: string | null;
  version: number;
  updated_at: Date;
  updated_by: string;
}

const stamp = (r: { version: number; updated_at: Date; updated_by: string }): Stamp => ({
  version: r.version,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const venueOf = (r: VenueRow): Stored<VenueState> => ({
  venueId: r.venue_id,
  displayName: r.display_name,
  mode: r.mode,
  priority: r.priority,
  enabled: r.enabled,
  minOrder: r.min_order,
  maxOrder: r.max_order,
  supportedPairs: r.supported_pairs,
  ...stamp(r),
});
const networkOf = (r: NetworkRow): Stored<NetworkState> => ({
  networkId: r.network_id,
  displayName: r.display_name,
  assetCodes: r.asset_codes,
  confirmationsRequired: r.confirmations_required,
  enabled: r.enabled,
  feeEstimateSource: r.fee_estimate_source,
  feeEstimateAmount: r.fee_estimate_amount,
  ...stamp(r),
});
const routeOf = (r: WalletRouteRow): StoredWalletRoute => ({
  routeId: r.route_id,
  assetCode: r.asset_code,
  networkId: r.network_id,
  payoutAllowed: r.payout_allowed,
  merchantAllow: r.merchant_allow,
  merchantDeny: r.merchant_deny,
  maxSinglePayout: r.max_single_payout,
  ...stamp(r),
});

/** The routing state of a stored entry: no version, timestamps or actor. */
export function stateOf<S extends object>(s: S & Stamp): S {
  const { version: _v, updatedAt: _u, updatedBy: _b, ...rest } = s;
  return rest as unknown as S;
}
export function walletRouteState(r: StoredWalletRoute): WalletRouteState {
  return {
    assetCode: r.assetCode,
    networkId: r.networkId,
    payoutAllowed: r.payoutAllowed,
    merchantAllow: r.merchantAllow,
    merchantDeny: r.merchantDeny,
    maxSinglePayout: r.maxSinglePayout,
  };
}

// ── venues ──────────────────────────────────────────────────────────────────
export async function listVenues(sql: Sql): Promise<Array<Stored<VenueState>>> {
  const rows = await sql<VenueRow[]>`SELECT * FROM pay.venue_registry ORDER BY priority ASC, venue_id ASC`;
  return rows.map(venueOf);
}
export async function getVenue(sql: Sql, venueId: string, lock = false): Promise<Stored<VenueState> | null> {
  const rows = lock
    ? await sql<VenueRow[]>`SELECT * FROM pay.venue_registry WHERE venue_id = ${venueId} FOR UPDATE`
    : await sql<VenueRow[]>`SELECT * FROM pay.venue_registry WHERE venue_id = ${venueId}`;
  return rows[0] ? venueOf(rows[0]) : null;
}
export async function insertVenue(sql: Sql, s: VenueState, actorId: string): Promise<Stored<VenueState>> {
  const rows = await sql<VenueRow[]>`
    INSERT INTO pay.venue_registry (venue_id, display_name, mode, priority, enabled, min_order, max_order, supported_pairs, updated_by)
    VALUES (${s.venueId}, ${s.displayName}, ${s.mode}, ${s.priority}, ${s.enabled}, ${s.minOrder}, ${s.maxOrder},
            ${sql.json(s.supportedPairs)}, ${actorId})
    RETURNING *`;
  return venueOf(rows[0]!);
}
export async function updateVenue(sql: Sql, s: VenueState, actorId: string): Promise<Stored<VenueState>> {
  const rows = await sql<VenueRow[]>`
    UPDATE pay.venue_registry
       SET display_name = ${s.displayName}, mode = ${s.mode}, priority = ${s.priority}, enabled = ${s.enabled},
           min_order = ${s.minOrder}, max_order = ${s.maxOrder}, supported_pairs = ${sql.json(s.supportedPairs)},
           version = version + 1, updated_at = now(), updated_by = ${actorId}
     WHERE venue_id = ${s.venueId}
    RETURNING *`;
  return venueOf(rows[0]!);
}

// ── networks ────────────────────────────────────────────────────────────────
export async function listNetworks(sql: Sql): Promise<Array<Stored<NetworkState>>> {
  const rows = await sql<NetworkRow[]>`SELECT * FROM pay.network_registry ORDER BY network_id ASC`;
  return rows.map(networkOf);
}
export async function getNetwork(sql: Sql, networkId: string, lock = false): Promise<Stored<NetworkState> | null> {
  const rows = lock
    ? await sql<NetworkRow[]>`SELECT * FROM pay.network_registry WHERE network_id = ${networkId} FOR UPDATE`
    : await sql<NetworkRow[]>`SELECT * FROM pay.network_registry WHERE network_id = ${networkId}`;
  return rows[0] ? networkOf(rows[0]) : null;
}
export async function insertNetwork(sql: Sql, s: NetworkState, actorId: string): Promise<Stored<NetworkState>> {
  const rows = await sql<NetworkRow[]>`
    INSERT INTO pay.network_registry (network_id, display_name, asset_codes, confirmations_required, enabled,
                                      fee_estimate_source, fee_estimate_amount, updated_by)
    VALUES (${s.networkId}, ${s.displayName}, ${sql.json(s.assetCodes)}, ${s.confirmationsRequired}, ${s.enabled},
            ${s.feeEstimateSource}, ${s.feeEstimateAmount}, ${actorId})
    RETURNING *`;
  return networkOf(rows[0]!);
}
export async function updateNetwork(sql: Sql, s: NetworkState, actorId: string): Promise<Stored<NetworkState>> {
  const rows = await sql<NetworkRow[]>`
    UPDATE pay.network_registry
       SET display_name = ${s.displayName}, asset_codes = ${sql.json(s.assetCodes)},
           confirmations_required = ${s.confirmationsRequired}, enabled = ${s.enabled},
           fee_estimate_source = ${s.feeEstimateSource}, fee_estimate_amount = ${s.feeEstimateAmount},
           version = version + 1, updated_at = now(), updated_by = ${actorId}
     WHERE network_id = ${s.networkId}
    RETURNING *`;
  return networkOf(rows[0]!);
}

// ── wallet routes ───────────────────────────────────────────────────────────
export async function listWalletRoutes(sql: Sql): Promise<StoredWalletRoute[]> {
  const rows = await sql<WalletRouteRow[]>`SELECT * FROM pay.wallet_routes ORDER BY network_id ASC, asset_code ASC`;
  return rows.map(routeOf);
}
export async function getWalletRoute(sql: Sql, assetCode: string, networkId: string, lock = false): Promise<StoredWalletRoute | null> {
  const rows = lock
    ? await sql<WalletRouteRow[]>`
        SELECT * FROM pay.wallet_routes WHERE asset_code = ${assetCode} AND network_id = ${networkId} FOR UPDATE`
    : await sql<WalletRouteRow[]>`
        SELECT * FROM pay.wallet_routes WHERE asset_code = ${assetCode} AND network_id = ${networkId}`;
  return rows[0] ? routeOf(rows[0]) : null;
}
export async function insertWalletRoute(sql: Sql, s: WalletRouteState, actorId: string): Promise<StoredWalletRoute> {
  const rows = await sql<WalletRouteRow[]>`
    INSERT INTO pay.wallet_routes (asset_code, network_id, payout_allowed, merchant_allow, merchant_deny, max_single_payout, updated_by)
    VALUES (${s.assetCode}, ${s.networkId}, ${s.payoutAllowed}, ${sql.json(s.merchantAllow)}, ${sql.json(s.merchantDeny)},
            ${s.maxSinglePayout}, ${actorId})
    RETURNING *`;
  return routeOf(rows[0]!);
}
export async function updateWalletRoute(sql: Sql, s: WalletRouteState, actorId: string): Promise<StoredWalletRoute> {
  const rows = await sql<WalletRouteRow[]>`
    UPDATE pay.wallet_routes
       SET payout_allowed = ${s.payoutAllowed}, merchant_allow = ${sql.json(s.merchantAllow)},
           merchant_deny = ${sql.json(s.merchantDeny)}, max_single_payout = ${s.maxSinglePayout},
           version = version + 1, updated_at = now(), updated_by = ${actorId}
     WHERE asset_code = ${s.assetCode} AND network_id = ${s.networkId}
    RETURNING *`;
  return routeOf(rows[0]!);
}

// ── audit ───────────────────────────────────────────────────────────────────
export interface EventRow {
  id: string;
  seq: string;
  registry: RegistryKind;
  entry_key: string;
  action: 'create' | 'update';
  actor_id: string;
  approver_id: string | null;
  dual_control: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  reason: string;
  created_at: Date;
}

export async function appendEvent(
  sql: Sql,
  e: {
    registry: RegistryKind;
    entryKey: string;
    action: 'create' | 'update';
    actorId: string;
    approverId: string | null;
    before: object | null;
    after: object;
    reason: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO pay.registry_events (registry, entry_key, action, actor_id, approver_id, dual_control, before, after, reason)
    VALUES (${e.registry}, ${e.entryKey}, ${e.action}, ${e.actorId}, ${e.approverId}, ${e.approverId !== null},
            ${e.before === null ? null : sql.json(e.before as never)}, ${sql.json(e.after as never)}, ${e.reason})`;
}

export async function listEvents(sql: Sql, registry: RegistryKind, entryKey: string | undefined, limit: number): Promise<EventRow[]> {
  return entryKey === undefined
    ? sql<EventRow[]>`SELECT * FROM pay.registry_events WHERE registry = ${registry} ORDER BY seq DESC LIMIT ${limit}`
    : sql<EventRow[]>`
        SELECT * FROM pay.registry_events WHERE registry = ${registry} AND entry_key = ${entryKey}
        ORDER BY seq DESC LIMIT ${limit}`;
}
