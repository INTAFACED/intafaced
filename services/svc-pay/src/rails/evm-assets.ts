import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { DECIMALS, type Amount } from '@intafaced/ledger-client';

/**
 * How a ledger `assetId` maps onto an EVM chain.
 *
 * The ledger always carries 18 decimal places. On-chain units may not (USDT is
 * usually 6). Conversion happens ONLY at this boundary — the adapter and the
 * core never see a chain unit, and a `number` never appears.
 */

export type EvmAsset =
  | { readonly kind: 'native'; readonly assetId: string; readonly decimals: number }
  | { readonly kind: 'erc20'; readonly assetId: string; readonly address: Address; readonly decimals: number };

export class EvmAssetError extends Error {
  readonly code = 'pay.crypto_asset_unknown';

  constructor(message: string) {
    super(message);
    this.name = 'EvmAssetError';
  }
}

/**
 * Parse `PAY_CRYPTO_ASSETS`.
 *
 * Forms (comma-separated):
 *   · `ETH:native`                 — native gas token, 18 decimals implied
 *   · `ETH:native:18`              — native with explicit decimals
 *   · `USDT:0xabc…:6`              — ERC-20 at address, 6 on-chain decimals
 *
 * An empty string is a refusal, not "accept anything": a live rail with no
 * asset map would accept a payment for an asset it cannot watch.
 */
export function parseEvmAssets(raw: string): ReadonlyMap<string, EvmAsset> {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new EvmAssetError('PAY_CRYPTO_ASSETS is empty — a live crypto rail needs at least one asset mapping');
  }

  const out = new Map<string, EvmAsset>();
  for (const entry of entries) {
    const parts = entry.split(':').map((p) => p.trim());
    const assetId = parts[0];
    if (!assetId) throw new EvmAssetError(`Malformed PAY_CRYPTO_ASSETS entry "${entry}"`);

    if (parts[1]?.toLowerCase() === 'native') {
      const decimals = parseAssetDecimals(parts[2], 18);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new EvmAssetError(`Native asset "${assetId}" has invalid decimals`);
      }
      out.set(assetId, { kind: 'native', assetId, decimals });
      continue;
    }

    const addressRaw = parts[1];
    const decimals = parseAssetDecimals(parts[2], Number.NaN);
    if (!addressRaw || !isAddress(addressRaw)) {
      throw new EvmAssetError(`Asset "${assetId}" needs a valid ERC-20 address (got "${addressRaw ?? ''}")`);
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new EvmAssetError(`Asset "${assetId}" needs on-chain decimals 0–36`);
    }
    out.set(assetId, { kind: 'erc20', assetId, address: getAddress(addressRaw), decimals });
  }
  return out;
}

/**
 * `Number('')` is 0, which would pass the 0–36 check and then scale each base
 * unit up by 10^18. A missing third part may use `whenOmitted` (18 for native,
 * NaN for an ERC-20). A present but blank scale is invalid.
 */
function parseAssetDecimals(raw: string | undefined, whenOmitted: number): number {
  if (raw === undefined) return whenOmitted;
  if (raw.trim() === '') return Number.NaN;
  return Number(raw);
}

/** Ledger Amount (1e18) → on-chain integer units. */
export function toChainUnits(amount: Amount, decimals: number): bigint {
  if (decimals === DECIMALS) return amount;
  if (decimals < DECIMALS) {
    const factor = 10n ** BigInt(DECIMALS - decimals);
    if (amount % factor !== 0n) {
      throw new EvmAssetError(`Amount has more precision than the on-chain asset (${decimals} decimals) — refusing to truncate`);
    }
    return amount / factor;
  }
  return amount * 10n ** BigInt(decimals - DECIMALS);
}

/** On-chain integer units → ledger Amount (1e18). */
export function fromChainUnits(units: bigint, decimals: number): Amount {
  if (decimals === DECIMALS) return units;
  if (decimals < DECIMALS) {
    return units * 10n ** BigInt(DECIMALS - decimals);
  }
  const factor = 10n ** BigInt(decimals - DECIMALS);
  if (units % factor !== 0n) {
    throw new EvmAssetError(`On-chain amount cannot be represented at ledger scale (${DECIMALS}) without truncation`);
  }
  return units / factor;
}

export function requireAsset(assets: ReadonlyMap<string, EvmAsset>, assetId: string): EvmAsset {
  const asset = assets.get(assetId);
  if (!asset) {
    throw new EvmAssetError(
      `Asset "${assetId}" is not configured on this crypto rail. Configured: ${[...assets.keys()].join(', ') || '—'}`,
    );
  }
  return asset;
}

/** ERC-20 Transfer(address,address,uint256) topic0. */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
