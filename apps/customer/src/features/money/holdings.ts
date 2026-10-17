import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { formatAmount, parseAmount } from '../../shared/money';
import { t as copyText } from './copy';
import type { ActionField } from './components';
import { createMoneyClient, type Holding, type Space } from './client';

/** Real assets the customer holds. Nothing here is typed by hand. */
export type HeldAsset = { assetId: string; available: string };

/** Distinct assets with something in them, largest dollar-coins first, then by ticker. Exact decimals only. */
export function heldAssets(holdings: readonly Holding[], spaces: readonly Pick<Space, 'assetId' | 'balance'>[] = []): HeldAsset[] {
  const byAsset = new Map<string, bigint>();
  const add = (assetId: string, value: string | null) => {
    if (!assetId || value === null) return;
    let amount: bigint;
    try {
      amount = parseAmount(value);
    } catch {
      return;
    }
    const known = byAsset.get(assetId);
    if (known === undefined || amount > known) byAsset.set(assetId, amount);
  };
  for (const holding of holdings) add(holding.assetId, holding.available);
  // A space the customer owns also proves they hold that asset, even when the balance feed is down.
  for (const space of spaces) if (!byAsset.has(space.assetId)) add(space.assetId, space.balance);
  const dollar = new Set(['USDT', 'USDC', 'USD']);
  return [...byAsset]
    .filter(([, amount]) => amount > 0n)
    .sort(([a], [b]) => Number(dollar.has(b)) - Number(dollar.has(a)) || a.localeCompare(b))
    .map(([assetId, amount]) => ({ assetId, available: formatAmount(amount) }));
}
/** A select field whose options are the customer's own assets. */
export function assetSelectField(label: string, hint: string, assets: readonly HeldAsset[], name = 'assetId'): ActionField {
  return { name, label, hint, options: assets.map((asset) => ({ value: asset.assetId, label: asset.assetId })) };
}

/** The customer's balances and accounts, read once per mount. */
export function useHoldings() {
  const { api, userId } = useSession();
  return useResource<{ assets: HeldAsset[]; spaces: Space[]; holdings: Holding[] }>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: copyText('components.sign.in.to.read.your.bank.information') };
    const overview = await createMoneyClient(api).overview(userId, 200, signal);
    const spaces = overview.spaces.ok ? overview.spaces.data : [];
    if (!overview.balances.ok && !overview.spaces.ok) return overview.balances;
    return { ok: true, data: { assets: heldAssets(overview.holdings, spaces), spaces, holdings: overview.holdings } };
  }, `${userId}:holdings`);
}
