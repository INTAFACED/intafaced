import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { AssetState, PayCustodyDepositStatus, RegistryAsset } from '@intafaced/contracts';
import { BankError, type BankErrorCode } from '../errors.js';
import { readRegistry, registryAllowsDeposit, type AssetRegistryReads } from '../assets/supported-assets.js';
import {
  unsetCustodyDepositPort,
  type CustodyDepositAddress,
  type CustodyDepositPort,
  type CustodyDepositRecord,
  type CustodyPendingDeposit,
  type CustodyDepositCatalogue,
  type DepositAsset,
  type DepositNetwork,
  type HaltedDepositPair,
} from './custody-port.js';

/**
 * Customer crypto deposits. Catalogue, address, and pending rows come from
 * the custody port. This service posts nothing to the ledger and derives no key.
 *
 * The catalogue is narrowed to svc-ledger's asset registry (W-balances-05): a pair
 * is open, and given an address, only while the registry lists the asset as
 * active, allowing deposits, on that network. So Deposit, Withdraw and the
 * customer's supported-asset list read one set of rows. A custody pair the
 * registry does not allow (retired, halted, deposits not allowed, network not
 * listed, asset not published) stays listed as switched off with `blockedBy:
 * 'registry'` and the asset's registry state, so the coin is still visible with
 * its reason; it takes no new address, and its history stays readable. No
 * registry, or an unreadable one, refuses `bank.asset_registry_unavailable`:
 * custody alone never decides.
 *
 * Extra addresses (W-deposit-02): besides the first address (number 0, which
 * never expires) a person may make more for one asset on one network, each
 * with an optional label and an expiry `BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS`
 * after it is made. How many may be open (not expired) at once, the first
 * included, is `BANK_DEPOSIT_ADDRESS_CAP`. Either setting blank refuses before
 * custody is asked. A number is never reused: the next is one above the
 * highest ever made, so an expired address is never handed out again. Custody
 * stores the expiry and holds a deposit that first reaches an expired address
 * for release; this service only lists what custody issued.
 */

const ASSET_RE = /^[A-Za-z0-9]{1,16}$/;
const NETWORK_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PENDING_CAP = 100;

export interface PublishedDepositAsset {
  assetId: string;
  networks: Array<{
    id: string;
    label: string;
    minimumDeposit: string;
    confirmationsRequired: number;
    estimatedArrivalMinutes: number;
    /** The owner's cases custody will not credit on this network, shown before any address; absent when none was published. */
    unsupported?: string[];
  }>;
}

/** A pair switched off, as customers see it: no address is issued for it. */
export interface HaltedDepositView {
  assetId: string;
  networkId: string;
  label: string;
  haltNote: string | null;
  /** Present when the registry, not the owner's custody switch, keeps the pair closed. */
  blockedBy?: 'registry';
  /** With `blockedBy`: the asset's registry state, or null when the registry does not publish the asset. */
  assetState?: AssetState | null;
}

export interface IssuedDepositAddress {
  assetId: string;
  networkId: string;
  address: string;
  memo: string | null;
  qrPayload: string | null;
}

/** One of the person's deposit addresses, as the address list shows it. `state` is read on the database clock. */
export interface DepositAddressListItem {
  assetId: string;
  networkId: string;
  addressIndex: number;
  address: string;
  memo: string | null;
  qrPayload: string | null;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  state: 'active' | 'expired';
}

export interface PendingDepositView {
  id: string;
  assetId: string;
  networkId: string;
  amount: string;
  confirmations: number;
  confirmationsRequired: number | null;
}

interface AddressRow {
  asset_id: string;
  network_id: string;
  address: string;
  memo: string | null;
  qr_payload: string | null;
}

export interface DepositServiceOptions {
  custody?: CustodyDepositPort | null;
  /** The owner's `BANK_DEPOSIT_ADDRESS_CAP`. Blank refuses `bank.deposit_address_cap_unset`. */
  addressCap?: () => string | undefined;
  /** The owner's `BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS`. Blank refuses `bank.deposit_address_expiry_unset`. */
  addressExpiryDays?: () => string | undefined;
  now?: () => Date;
}

export const BANK_DEPOSIT_ADDRESS_CAP_ENV = 'BANK_DEPOSIT_ADDRESS_CAP';
export const BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS_ENV = 'BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS';
const MAX_ADDRESS_INDEX = 9999;
const LABEL_MAX = 40;

interface ListRow extends AddressRow {
  address_index: number;
  label: string | null;
  created_at: Date;
  expires_at: Date | null;
  expired: boolean;
}

export class DepositService {
  private readonly custody: CustodyDepositPort;
  private readonly registry: AssetRegistryReads | null;

  /** `registry` is svc-ledger's; absent refuses every catalogue and address read, never read as "everything allowed". */
  constructor(
    private readonly sql: Sql,
    private readonly options: DepositServiceOptions = {},
    registry: AssetRegistryReads | null = null,
  ) {
    this.custody = options.custody ?? unsetCustodyDepositPort;
    this.registry = registry;
  }

  async assets(): Promise<{ assets: PublishedDepositAsset[]; halted: HaltedDepositView[] }> {
    const { catalogue, registry } = await this.readBoth();
    const assets = validateCatalogue(catalogue.assets);
    // The custody catalogue is checked whole first, so a broken one is still refused as broken; then the registry narrows it.
    const halted = validateHalted(catalogue.halted, assets);
    const blocked: HaltedDepositView[] = [];
    const open = assets
      .map((asset) => ({
        ...asset,
        networks: asset.networks.filter((network) => {
          if (registryAllowsDeposit(registry, asset.assetId, network.id)) return true;
          const state = registry.find((row) => row.id === asset.assetId)?.state ?? null;
          blocked.push({
            assetId: asset.assetId,
            networkId: network.id,
            label: network.label,
            haltNote: null,
            blockedBy: 'registry',
            assetState: state,
          });
          return false;
        }),
      }))
      .filter((asset) => asset.networks.length > 0);
    return { assets: open, halted: [...halted, ...blocked] };
  }

  /**
   * The custody catalogue and the registry, read together. Custody's refusal is the one reported when both fail, so
   * "custody is not connected" is never hidden behind a registry outage.
   */
  private async readBoth(): Promise<{ catalogue: CustodyDepositCatalogue; registry: RegistryAsset[] }> {
    const registry = readRegistry(this.registry).then(
      (rows) => ({ rows }),
      (error: unknown) => ({ error }),
    );
    const catalogue = await this.readCatalogue();
    if (catalogue === null) refuseCustody('Deposit assets are not published');
    const read = await registry;
    if ('error' in read) throw read.error;
    return { catalogue, registry: read.rows };
  }

  /** One custody read. A port that knows nothing of switched-off pairs names none. */
  private async readCatalogue(): Promise<CustodyDepositCatalogue | null> {
    if (this.custody.catalogue) return this.custody.catalogue();
    const assets = await this.custody.listAssets();
    return assets === null ? null : { assets, halted: [] };
  }

  /**
   * Idempotent on (user, asset, network). The first address custody returns
   * is the one later calls return. A second custody answer is not swapped in.
   */
  async address(input: { userId: string; assetId: string; networkId: string }): Promise<IssuedDepositAddress> {
    const network = await this.openPair(input);

    const existing = await this.sql<AddressRow[]>`
      SELECT asset_id, network_id, address, memo, qr_payload
        FROM bank.deposit_addresses
       WHERE user_id = ${input.userId}
         AND asset_id = ${network.assetId}
         AND network_id = ${network.networkId}
         AND address_index = 0
    `;
    if (existing[0]) return toAddress(existing[0]);

    const issued = await this.custody.address({
      userId: input.userId,
      assetId: network.assetId,
      networkId: network.networkId,
    });
    if (issued === null) {
      refuseCustody(`Custody did not issue a deposit address for ${network.assetId} on ${network.networkId}`);
    }
    const clean = validateIssued(issued);

    const inserted = await this.sql<AddressRow[]>`
      INSERT INTO bank.deposit_addresses (user_id, asset_id, network_id, address, memo, qr_payload)
      VALUES (
        ${input.userId}, ${network.assetId}, ${network.networkId},
        ${clean.address}, ${clean.memo}, ${clean.qrPayload}
      )
      ON CONFLICT (user_id, asset_id, network_id, address_index) DO NOTHING
      RETURNING asset_id, network_id, address, memo, qr_payload
    `;
    if (inserted[0]) return toAddress(inserted[0]);

    const raced = await this.sql<AddressRow[]>`
      SELECT asset_id, network_id, address, memo, qr_payload
        FROM bank.deposit_addresses
       WHERE user_id = ${input.userId}
         AND asset_id = ${network.assetId}
         AND network_id = ${network.networkId}
         AND address_index = 0
    `;
    if (!raced[0]) {
      throw new BankError('Deposit address was not stored', 'bank.deposit_custody_unset');
    }
    return toAddress(raced[0]);
  }

  /**
   * The person's deposit addresses, the first and every extra one, expired ones included (a deposit to one is held for
   * release, so it stays listed): per pair the first, then the newest first, so the open ones always fit the page. With
   * the owner's cap and expiry window, or null where they are not published.
   */
  async addresses(
    userId: string,
    filter: { assetId?: string; networkId?: string } = {},
  ): Promise<{ items: DepositAddressListItem[]; cap: number | null; expiryDays: number | null }> {
    const rows = await this.sql<ListRow[]>`
      SELECT asset_id, network_id, address_index, address, memo, qr_payload, label, created_at, expires_at,
             (expires_at IS NOT NULL AND expires_at <= now()) AS expired
        FROM bank.deposit_addresses
       WHERE user_id = ${userId}
         ${filter.assetId ? this.sql`AND asset_id = ${filter.assetId}` : this.sql``}
         ${filter.networkId ? this.sql`AND network_id = ${filter.networkId}` : this.sql``}
       ORDER BY asset_id, network_id, (address_index = 0) DESC, address_index DESC
       LIMIT 1000
    `;
    return {
      items: rows.map(toListItem),
      cap: parseSetting(this.options.addressCap?.()),
      expiryDays: parseSetting(this.options.addressExpiryDays?.()),
    };
  }

  /**
   * Make one more address for this asset and network, with an optional label. Refused when the owner's cap or expiry window
   * is blank, when the pair takes no address, or when the person already holds the cap of open addresses here (the first
   * included). One make at a time per person and pair; if custody issued and this crashed before storing, the retry asks
   * custody for the same number and stores the address it already issued.
   */
  async createAddress(input: {
    userId: string;
    assetId: string;
    networkId: string;
    label?: string | null;
  }): Promise<DepositAddressListItem> {
    const label = cleanLabel(input.label);
    const cap = requireSetting(this.options.addressCap?.(), BANK_DEPOSIT_ADDRESS_CAP_ENV, 'bank.deposit_address_cap_unset', 'a limit');
    const days = requireSetting(
      this.options.addressExpiryDays?.(),
      BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS_ENV,
      'bank.deposit_address_expiry_unset',
      'an expiry',
    );
    const network = await this.openPair(input);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`deposit-address:${input.userId}:${network.assetId}:${network.networkId}`}))`;
      const held = await tx<Array<{ open: string; top: number | null; first: boolean }>>`
        SELECT count(*) FILTER (WHERE expires_at IS NULL OR expires_at > now()) AS open, max(address_index) AS top,
               bool_or(address_index = 0) AS first
          FROM bank.deposit_addresses
         WHERE user_id = ${input.userId} AND asset_id = ${network.assetId} AND network_id = ${network.networkId}
      `;
      // The first address takes its place in the cap even before it is asked for, since that door is never capped.
      const open = Number(held[0]?.open ?? '0') + (held[0]?.first ? 0 : 1);
      const index = Math.max(held[0]?.top ?? 0, 0) + 1;
      if (open >= cap) {
        throw new BankError(
          `You can hold at most ${cap} open deposit addresses for ${network.assetId} on ${network.networkId}`,
          'bank.deposit_address_cap_reached',
        );
      }
      if (index > MAX_ADDRESS_INDEX) {
        throw new BankError(
          `Every deposit address number for ${network.assetId} on ${network.networkId} has been used; no other address can be made`,
          'bank.deposit_address_numbers_used',
        );
      }
      const expiresAt = new Date((this.options.now?.() ?? new Date()).getTime() + days * 86_400_000).toISOString();
      const issued = await this.custody.address({
        userId: input.userId,
        assetId: network.assetId,
        networkId: network.networkId,
        addressIndex: index,
        expiresAt,
      });
      if (issued === null) {
        refuseCustody(`Custody did not issue another deposit address for ${network.assetId} on ${network.networkId}`);
      }
      const clean = validateIssued(issued);
      // Custody's stored expiry is the one that decides a late deposit, so it is the one shown.
      const stored = parseExpiry(issued.expiresAt);
      const rows = await tx<ListRow[]>`
        INSERT INTO bank.deposit_addresses (user_id, asset_id, network_id, address_index, address, memo, qr_payload, label, expires_at)
        VALUES (${input.userId}, ${network.assetId}, ${network.networkId}, ${index}, ${clean.address}, ${clean.memo},
                ${clean.qrPayload}, ${label}, ${stored})
        RETURNING asset_id, network_id, address_index, address, memo, qr_payload, label, created_at, expires_at,
                  (expires_at IS NOT NULL AND expires_at <= now()) AS expired
      `;
      return toListItem(rows[0]!);
    });
  }

  /** Set or clear the label of one of the person's addresses. The same label twice is one change. */
  async labelAddress(input: {
    userId: string;
    assetId: string;
    networkId: string;
    addressIndex: number;
    label: string | null;
  }): Promise<DepositAddressListItem> {
    const label = cleanLabel(input.label);
    const rows = await this.sql<ListRow[]>`
      UPDATE bank.deposit_addresses SET label = ${label}
       WHERE user_id = ${input.userId} AND asset_id = ${input.assetId} AND network_id = ${input.networkId}
         AND address_index = ${input.addressIndex}
      RETURNING asset_id, network_id, address_index, address, memo, qr_payload, label, created_at, expires_at,
                (expires_at IS NOT NULL AND expires_at <= now()) AS expired
    `;
    if (!rows[0]) {
      throw new BankError(
        `You have no deposit address number ${input.addressIndex} for ${input.assetId} on ${input.networkId}`,
        'bank.deposit_address_not_found',
      );
    }
    return toListItem(rows[0]);
  }

  /** The pair as the catalogue publishes it, refused when it is switched off or the supported asset list does not allow it. */
  private async openPair(input: { assetId: string; networkId: string }): Promise<{ assetId: string; networkId: string }> {
    const { catalogue, registry } = await this.readBoth();
    const assets = validateCatalogue(catalogue.assets);
    // A switched-off pair gives no address, not even one issued before it was switched off. Only this pair is looked at, so a
    // bad switched-off row elsewhere never stops the open pairs.
    if (catalogue.halted.some((row) => row.assetId === input.assetId && row.networkId === input.networkId)) {
      throw new BankError(`Deposits of ${input.assetId} on ${input.networkId} are switched off`, 'bank.deposit_network_halted');
    }
    const network = findNetwork(assets, input.assetId, input.networkId);
    // Before any stored address is returned: a pair the registry no longer allows (retired, halted, network dropped) gets none.
    if (!registryAllowsDeposit(registry, network.assetId, network.networkId)) {
      throw new BankError(
        `${network.assetId} on ${network.networkId} is not in the supported asset list for deposits`,
        'bank.deposit_asset_unpublished',
      );
    }
    return network;
  }

  /** The customer's own deposit history, newest first. A page, with the true total so no row is dropped silently. */
  async list(
    userId: string,
    filters: {
      assetId?: string;
      networkId?: string;
      status?: PayCustodyDepositStatus;
      txId?: string;
      address?: string;
      offset: number;
      limit: number;
    },
  ): Promise<{ items: CustodyDepositRecord[]; total: number }> {
    const page = this.custody.records
      ? await this.custody.records({
          userId,
          assetId: filters.assetId,
          networkId: filters.networkId,
          statuses: filters.status ? [filters.status] : undefined,
          txHash: filters.txId,
          address: filters.address,
          offset: filters.offset,
          limit: filters.limit,
        })
      : null;
    if (page === null) refuseCustody('Deposit history is not published');
    return { items: [...page.items], total: page.total };
  }

  async pending(userId: string): Promise<{ items: PendingDepositView[] }> {
    const rows = await this.custody.pending(userId);
    if (rows === null) refuseCustody('Incoming deposits are not published');
    if (rows.length > PENDING_CAP) {
      throw new BankError(
        `Custody returned ${rows.length} incoming deposits; this door publishes at most ${PENDING_CAP} and will not drop the rest`,
        'bank.deposit_pending_unbounded',
      );
    }
    return { items: rows.map(validatePending) };
  }
}

function refuseCustody(what: string): never {
  throw new BankError(
    `${what}. Crypto custody is not connected (bank.deposit_custody_unset). No address, minimum, or confirmation count is invented.`,
    'bank.deposit_custody_unset',
  );
}

function validateCatalogue(assets: readonly DepositAsset[]): PublishedDepositAsset[] {
  if (assets.length > 50) {
    throw new BankError('Deposit catalogue has more than 50 assets', 'bank.deposit_catalogue_invalid');
  }
  const seen = new Set<string>();
  return assets.map((asset) => {
    if (!ASSET_RE.test(asset.assetId)) {
      throw new BankError('Deposit catalogue asset id is not a 1–16 character symbol', 'bank.deposit_catalogue_invalid');
    }
    if (seen.has(asset.assetId)) {
      throw new BankError(`Deposit catalogue lists ${asset.assetId} twice`, 'bank.deposit_catalogue_invalid');
    }
    seen.add(asset.assetId);
    if (asset.networks.length === 0) {
      throw new BankError(`Deposit catalogue asset ${asset.assetId} has no network`, 'bank.deposit_catalogue_invalid');
    }
    const networks = new Set<string>();
    return {
      assetId: asset.assetId,
      networks: asset.networks.map((network) => validateNetwork(asset.assetId, network, networks)),
    };
  });
}

/** Switched-off pairs: short tokens, a label, the owner's note as written or null. A pair that is also live is a broken catalogue. */
function validateHalted(halted: readonly HaltedDepositPair[], assets: readonly PublishedDepositAsset[]): HaltedDepositView[] {
  if (halted.length > 500) throw new BankError('Deposit catalogue has more than 500 switched-off pairs', 'bank.deposit_catalogue_invalid');
  const seen = new Set<string>();
  return halted.map((row) => {
    if (!ASSET_RE.test(row.assetId) || !NETWORK_RE.test(row.networkId)) {
      throw new BankError('Switched-off deposit pair asset or network is not a short token', 'bank.deposit_catalogue_invalid');
    }
    const key = `${row.assetId}:${row.networkId}`;
    if (seen.has(key)) throw new BankError(`Deposit catalogue lists ${key} as switched off twice`, 'bank.deposit_catalogue_invalid');
    seen.add(key);
    if (assets.some((asset) => asset.assetId === row.assetId && asset.networks.some((network) => network.id === row.networkId))) {
      throw new BankError(`Deposit catalogue lists ${key} as both open and switched off`, 'bank.deposit_catalogue_invalid');
    }
    const label = row.label?.trim() ?? '';
    if (!label || label !== row.label || label.length > 64) {
      throw new BankError(`Switched-off deposit pair ${key} has no label`, 'bank.deposit_catalogue_invalid');
    }
    const haltNote = optionalText(row.haltNote, 280, 'switch-off note');
    return { assetId: row.assetId, networkId: row.networkId, label, haltNote };
  });
}

function validateNetwork(assetId: string, network: DepositNetwork, seen: Set<string>): PublishedDepositAsset['networks'][number] {
  if (!NETWORK_RE.test(network.id)) {
    throw new BankError(`Deposit network id for ${assetId} is blank or not a short token`, 'bank.deposit_catalogue_invalid');
  }
  if (seen.has(network.id)) {
    throw new BankError(`Deposit catalogue lists ${assetId} network ${network.id} twice`, 'bank.deposit_catalogue_invalid');
  }
  seen.add(network.id);
  const label = network.label?.trim() ?? '';
  if (!label || label !== network.label || label.length > 64) {
    throw new BankError(`Deposit network label for ${assetId}/${network.id} is missing`, 'bank.deposit_catalogue_invalid');
  }
  let minimum: bigint;
  try {
    minimum = parseAmount(network.minimumDeposit);
  } catch {
    throw new BankError(`Deposit minimum for ${assetId}/${network.id} is not an exact decimal`, 'bank.deposit_catalogue_invalid');
  }
  if (minimum <= 0n) {
    throw new BankError(`Deposit minimum for ${assetId}/${network.id} must be positive`, 'bank.deposit_catalogue_invalid');
  }
  if (!Number.isInteger(network.confirmationsRequired) || network.confirmationsRequired < 0) {
    throw new BankError(`Confirmations for ${assetId}/${network.id} are not a non-negative integer`, 'bank.deposit_catalogue_invalid');
  }
  if (!Number.isInteger(network.estimatedArrivalMinutes) || network.estimatedArrivalMinutes < 0) {
    throw new BankError(`Arrival minutes for ${assetId}/${network.id} are not a non-negative integer`, 'bank.deposit_catalogue_invalid');
  }
  const unsupported = network.unsupported?.map((item) => optionalText(item, 280, 'unsupported case'));
  if (unsupported && (unsupported.length === 0 || unsupported.length > 20 || unsupported.some((item) => item === null))) {
    throw new BankError(`Unsupported cases for ${assetId}/${network.id} are empty or blank`, 'bank.deposit_catalogue_invalid');
  }
  return {
    id: network.id,
    label,
    minimumDeposit: formatAmount(minimum),
    confirmationsRequired: network.confirmationsRequired,
    estimatedArrivalMinutes: network.estimatedArrivalMinutes,
    ...(unsupported ? { unsupported: unsupported as string[] } : {}),
  };
}

function findNetwork(assets: readonly PublishedDepositAsset[], assetId: string, networkId: string): { assetId: string; networkId: string } {
  const asset = assets.find((row) => row.assetId === assetId);
  if (!asset) {
    throw new BankError(`Asset ${assetId} is not in the published deposit catalogue`, 'bank.deposit_asset_unpublished');
  }
  const network = asset.networks.find((row) => row.id === networkId);
  if (!network) {
    throw new BankError(`Network ${networkId} is not published for ${assetId}`, 'bank.deposit_asset_unpublished');
  }
  return { assetId: asset.assetId, networkId: network.id };
}

function validateIssued(issued: CustodyDepositAddress): { address: string; memo: string | null; qrPayload: string | null } {
  const address = issued.address?.trim() ?? '';
  if (!address || address !== issued.address || address.length > 256 || /\s/.test(address)) {
    throw new BankError('Custody returned a deposit address this service will not store', 'bank.deposit_catalogue_invalid');
  }
  const memo = optionalText(issued.memo, 128, 'memo');
  const qrPayload = optionalText(issued.qrPayload, 512, 'qr payload');
  return { address, memo, qrPayload };
}

function optionalText(value: string | null | undefined, max: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length > max) {
    throw new BankError(`Custody returned a ${label} this service will not store`, 'bank.deposit_catalogue_invalid');
  }
  return trimmed;
}

function validatePending(row: CustodyPendingDeposit): PendingDepositView {
  if (!row.id?.trim() || row.id !== row.id.trim() || row.id.length > 128) {
    throw new BankError('Custody pending deposit id is blank', 'bank.deposit_catalogue_invalid');
  }
  if (!ASSET_RE.test(row.assetId) || !NETWORK_RE.test(row.networkId)) {
    throw new BankError('Custody pending deposit asset or network is not a short token', 'bank.deposit_catalogue_invalid');
  }
  let amount: bigint;
  try {
    amount = parseAmount(row.amount);
  } catch {
    throw new BankError('Custody pending deposit amount is not an exact decimal', 'bank.deposit_catalogue_invalid');
  }
  if (amount <= 0n) {
    throw new BankError('Custody pending deposit amount must be positive', 'bank.deposit_catalogue_invalid');
  }
  if (!Number.isInteger(row.confirmations) || row.confirmations < 0) {
    throw new BankError('Custody pending confirmations are not a non-negative integer', 'bank.deposit_catalogue_invalid');
  }
  if (row.confirmationsRequired !== null && (!Number.isInteger(row.confirmationsRequired) || row.confirmationsRequired < 0)) {
    throw new BankError('Custody pending confirmation target is not a non-negative integer', 'bank.deposit_catalogue_invalid');
  }
  return {
    id: row.id,
    assetId: row.assetId,
    networkId: row.networkId,
    amount: formatAmount(amount),
    confirmations: row.confirmations,
    confirmationsRequired: row.confirmationsRequired,
  };
}

/** Unset, blank, zero or not a whole number up to 9999 is `null`: the owner has not published the setting. */
function parseSetting(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  return /^[1-9][0-9]{0,3}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function requireSetting(raw: string | undefined, env: string, code: BankErrorCode, what: string): number {
  const value = parseSetting(raw);
  if (value === null) {
    throw new BankError(
      `${env} is unset or not a whole number from 1 to 9999. No extra address is made rather than inventing ${what}`,
      code,
    );
  }
  return value;
}

function cleanLabel(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const label = raw.trim();
  if (label.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new BankError(`A deposit address label is 1 to ${LABEL_MAX} characters`, 'bank.deposit_address_label_invalid');
  }
  return label;
}

/** The expiry custody stored for an extra address. A missing or unreadable one is not repeated to the person. */
function parseExpiry(raw: string | null | undefined): Date {
  const at = raw ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw new BankError('Custody returned an extra deposit address with no expiry', 'bank.deposit_catalogue_invalid');
  }
  return at;
}

function toListItem(row: ListRow): DepositAddressListItem {
  return {
    assetId: row.asset_id,
    networkId: row.network_id,
    addressIndex: row.address_index,
    address: row.address,
    memo: row.memo,
    qrPayload: row.qr_payload,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    state: row.expired ? 'expired' : 'active',
  };
}

function toAddress(row: AddressRow): IssuedDepositAddress {
  return {
    assetId: row.asset_id,
    networkId: row.network_id,
    address: row.address,
    memo: row.memo,
    qrPayload: row.qr_payload,
  };
}
