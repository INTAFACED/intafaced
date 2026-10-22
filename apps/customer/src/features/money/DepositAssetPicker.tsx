import { useId, useState } from 'react';
import { depositCopy } from './deposit-copy';

/** Case-blind match on the asset id, in the order given. An empty query keeps everything. */
export function filterAssets(assets: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle ? assets.filter((id) => id.toLowerCase().includes(needle)) : [...assets];
}

/**
 * The asset chooser: a search box over the list and the list itself. The chosen asset stays in the list while the search narrows it,
 * so the field never shows one coin while the page holds another.
 */
export function DepositAssetPicker({
  assets,
  asset,
  onAsset,
}: {
  assets: readonly string[];
  asset: string;
  onAsset: (id: string) => void;
}) {
  const { t } = depositCopy.useCopy();
  const hint = useId();
  const [query, setQuery] = useState('');
  const matches = filterAssets(assets, query);
  const shown = asset && !matches.includes(asset) && assets.includes(asset) ? [asset, ...matches] : matches;
  return (
    <>
      <label className="field">
        <span>{t('assetSearch')}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={assets.length === 0}
          autoComplete="off"
          aria-describedby={hint}
        />
        <small id={hint} role="status">
          {assets.length === 0
            ? t('noAssets')
            : query.trim() && matches.length === 0
              ? t('assetSearchNone', { query: query.trim() })
              : t('assetSearchCount', { shown: matches.length, total: assets.length })}
        </small>
      </label>
      <label className="field">
        <span>{t('asset')}</span>
        <select value={asset} onChange={(event) => onAsset(event.target.value)} disabled={assets.length === 0}>
          {assets.length === 0 && <option value="">—</option>}
          {shown.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <small>{assets.length === 0 ? t('noAssets') : t('assetHint')}</small>
      </label>
    </>
  );
}
