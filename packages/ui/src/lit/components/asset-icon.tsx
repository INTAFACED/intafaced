/**
 * AssetIcon: an asset's round mark beside its name. Listed assets draw the package's own artwork
 * (`../../components/coins`, the same art the old CoinIcon drew); every other asset is an honest lettered disc with the
 * ticker's first letter, never a borrowed or guessed logo. Decorative by default (the ticker beside it names the asset);
 * give `label` when the icon stands alone.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { coinArt } from '../../components/coins/coin-art.generated.js';

export type AssetIconProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> & {
  /** Ticker, any case: BTC, ETH, USDT. */
  asset: string;
  /** sm for a dense row, md (default) for a list row, lg for a room's header. */
  size?: 'sm' | 'md' | 'lg';
  /** The asset's name, when nothing beside the icon says it. */
  label?: string;
};

/** True when the kit holds artwork for the asset; anything else draws the lettered disc. */
export const hasAssetArt = (asset: string): boolean => asset.trim().toUpperCase() in coinArt;

export function AssetIcon({ asset, size = 'md', label, className, ...rest }: AssetIconProps) {
  const key = asset.trim().toUpperCase();
  const svg = coinArt[key];
  const named = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span
      {...rest}
      {...named}
      className={clsx('lit-asset', className)}
      data-slot="asset-icon"
      data-asset={key}
      data-size={size}
      data-fallback={svg ? undefined : 'lettered'}
    >
      {svg ? (
        // The art is this package's own generated constant (no script, handler or reference: coin-art.test.ts); drawn
        // inline, never as a data: image, which the production policy refuses (issue 7216).
        <span className="lit-asset__art" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        ([...key][0] ?? '?')
      )}
    </span>
  );
}
