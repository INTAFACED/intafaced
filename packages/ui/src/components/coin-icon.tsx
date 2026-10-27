import * as React from 'react';
import { coinArt } from './coins/coin-art.generated.js';
import { cn } from './cn.js';

export interface CoinIconProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** Ticker, case-insensitive: BTC, ETH, USDT, USDC, IFC. Anything else gets a lettered circle. */
  asset: string;
  /** Diameter in px: 20 (small), 28 (watchlist), 32 (rows, default), 40. */
  size?: number;
}

const dataUri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** True when we hold artwork for the asset (listed assets only, see coins/manifest.json). */
export function hasCoinArt(asset: string): boolean {
  return asset.toUpperCase() in coinArt;
}

/**
 * Round coin glyph. Self-hosted artwork for listed assets only; everything else
 * (and IFC, which has no brand art yet) is a lettered circle. Decorative: the
 * ticker text next to it names the asset.
 */
export function CoinIcon({ asset, size = 32, className, style, ...props }: CoinIconProps) {
  const key = asset.toUpperCase();
  const svg = coinArt[key];
  const dim = { width: size, height: size, ...style };
  if (svg) {
    return (
      <span
        data-slot="coin-icon"
        data-asset={key}
        style={dim}
        className={cn('inline-block shrink-0 overflow-hidden rounded-pill bg-raised', className)}
        {...props}
      >
        <img
          src={dataUri(svg)}
          alt=""
          aria-hidden="true"
          width={size}
          height={size}
          draggable={false}
          className="block size-full object-cover"
        />
      </span>
    );
  }
  return (
    <span
      data-slot="coin-icon"
      data-asset={key}
      data-fallback="lettered"
      aria-hidden="true"
      style={{ ...dim, fontSize: Math.round(size * 0.42) }}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-pill font-semibold leading-none',
        key === 'IFC' ? 'bg-lime-soft text-accent-text' : 'bg-raised text-fg',
        className,
      )}
      {...props}
    >
      {key.charAt(0)}
    </span>
  );
}
