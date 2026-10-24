import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { PayCustodyDepositStatus } from '@intafaced/contracts';
import { BankError } from '../errors.js';
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
  }>;
}

/** A pair the owner switched off, as customers see it: no address is issued for it. */
export interface HaltedDepositView {
  assetId: string;
  networkId: string;
  label: string;
  haltNote: string | null;
}

export interface IssuedDepositAddress {
  assetId: string;
  networkId: string;
  address: string;
  memo: string | null;
  qrPayload: string | null;
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
}

export class DepositService {
  private readonly custody: CustodyDepositPort;

  constructor(
    private readonly sql: Sql,
    options: DepositServiceOptions = {},
  ) {
    this.custody = options.custody ?? unsetCustodyDepositPort;
  }

  async assets(): Promise<{ assets: PublishedDepositAsset[]; halted: HaltedDepositView[] }> {
    const published = await this.readCatalogue();
    if (published === null) refuseCustody('Deposit assets are not published');
    const assets = validateCatalogue(published.assets);
    return { assets, halted: validateHalted(published.halted, assets) };
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
    const catalogue = await this.readCatalogue();
    if (catalogue === null) refuseCustody('Deposit assets are not published');
    const assets = validateCatalogue(catalogue.assets);
    // A switched-off pair gives no address, not even one issued before it was switched off. Only this pair is looked at, so a
    // bad switched-off row elsewhere never stops the open pairs.
    if (catalogue.halted.some((row) => row.assetId === input.assetId && row.networkId === input.networkId)) {
      throw new BankError(`Deposits of ${input.assetId} on ${input.networkId} are switched off`, 'bank.deposit_network_halted');
    }
    const network = findNetwork(assets, input.assetId, input.networkId);

    const existing = await this.sql<AddressRow[]>`
      SELECT asset_id, network_id, address, memo, qr_payload
        FROM bank.deposit_addresses
       WHERE user_id = ${input.userId}
         AND asset_id = ${network.assetId}
         AND network_id = ${network.networkId}
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
      ON CONFLICT (user_id, asset_id, network_id) DO NOTHING
      RETURNING asset_id, network_id, address, memo, qr_payload
    `;
    if (inserted[0]) return toAddress(inserted[0]);

    const raced = await this.sql<AddressRow[]>`
      SELECT asset_id, network_id, address, memo, qr_payload
        FROM bank.deposit_addresses
       WHERE user_id = ${input.userId}
         AND asset_id = ${network.assetId}
         AND network_id = ${network.networkId}
    `;
    if (!raced[0]) {
      throw new BankError('Deposit address was not stored', 'bank.deposit_custody_unset');
    }
    return toAddress(raced[0]);
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
  return {
    id: network.id,
    label,
    minimumDeposit: formatAmount(minimum),
    confirmationsRequired: network.confirmationsRequired,
    estimatedArrivalMinutes: network.estimatedArrivalMinutes,
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

function toAddress(row: AddressRow): IssuedDepositAddress {
  return {
    assetId: row.asset_id,
    networkId: row.network_id,
    address: row.address,
    memo: row.memo,
    qrPayload: row.qr_payload,
  };
}
