import * as React from 'react';
import { coinArt } from './coins/coin-art.generated.js';
import { cn } from './cn.js';

export interface CoinIconProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** Ticker, case-insensitive: BTC, ETH, USDT, USDC, IFC. Anything else gets a lettered circle. */
  asset: string;
  /** Diameter in px: 20 (small), 28 (watchlist), 32 (rows, default), 40. */
  size?: number;
}

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
        <span
          aria-hidden="true"
          className="block size-full [&>svg]:block [&>svg]:size-full"
          // Drawn inline, never as a data: image: Chromium reported a data: image that began loading while the page was
          // being left under the production policy's connect-src, which refuses data: (#7216). The art is this package's
          // own generated constant (coins/coin-art.generated.ts), with no script, handler, id or reference
          // (coin-art.test.ts); nothing a person types reaches it.
          dangerouslySetInnerHTML={{ __html: svg }}
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
