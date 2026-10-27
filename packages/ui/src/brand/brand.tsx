import * as React from 'react';
import { BRAND_GEOMETRY as G } from './geometry.generated.js';

/**
 * The INTAFACED brand: the one set of components that draws it. Geometry comes from the kit's SVGs in
 * `packages/ui/brand/` through `scripts/brand-sync.mjs`, so a new kit is a file swap. Every drawing fills with
 * `currentColor`: the brand takes its colour from the role token of the text around it, never a raw value.
 *
 * Placement (BRAND.md): the mark alone where space is tight or the brand is implied (phone bar, icons, loaders); the
 * horizontal lockup in a desktop bar; the stacked lockup on a full-screen brand moment; the wordmark alone only where
 * the mark is near or the space is wide and short. Clear space is 2U on every side (U = mark height / 8).
 */

export type BrandDrawing = 'master' | 'small' | 'micro';

/** The optical drawing for a mark drawn this many CSS pixels tall: master from 64, small from 24, micro below. */
export function brandDrawing(px: number): BrandDrawing {
  return px >= 64 ? 'master' : px >= 24 ? 'small' : 'micro';
}

/** The kit's minimum: the mark is never drawn smaller than 16 pixels. */
const MIN_MARK = 16;
const NAME = 'INTAFACED';

type SvgProps = Omit<React.ComponentProps<'svg'>, 'children' | 'viewBox' | 'width' | 'height'>;

/** Labelled when `title` is given (it stands alone, or is the link's only content), hidden otherwise. */
function a11y(title: string | undefined): React.ComponentProps<'svg'> {
  return title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
}

export function BrandMark({ size = 24, title, className, ...props }: SvgProps & { size?: number; title?: string }) {
  const px = Math.max(MIN_MARK, size);
  return (
    <svg
      data-slot="brand-mark"
      data-drawing={brandDrawing(px)}
      className={className}
      viewBox="0 0 1000 1000"
      width={px}
      height={px}
      fill="currentColor"
      focusable="false"
      {...a11y(title)}
      {...props}
    >
      <path d={G.mark[brandDrawing(px)]} />
    </svg>
  );
}

/** The wordmark alone, without the ™ (the product never shows it). `width` in CSS pixels; the kit's minimum is 150. */
export function BrandWordmark({ width = 150, title, className, ...props }: SvgProps & { width?: number; title?: string }) {
  const w = Math.max(150, width);
  return (
    <svg
      data-slot="brand-wordmark"
      className={className}
      viewBox={`0 0 ${G.wordmark.width} ${G.wordmark.height}`}
      width={w}
      height={Math.round(((w * G.wordmark.height) / G.wordmark.width) * 100) / 100}
      fill="currentColor"
      focusable="false"
      {...a11y(title)}
      {...props}
    >
      <path d={G.wordmark.d} />
    </svg>
  );
}

/**
 * Mark and wordmark locked together. `size` is the mark's height in CSS pixels. Horizontal under 64 pixels is the kit's
 * top-bar lockup (small mark); the kit's minimum is 24.
 */
export function BrandLockup({
  layout = 'horizontal',
  size = 24,
  title = NAME,
  className,
  ...props
}: SvgProps & { layout?: 'horizontal' | 'stacked'; size?: number; title?: string }) {
  if (layout === 'stacked') {
    const s = G.stacked;
    const px = Math.max(MIN_MARK, size);
    const unit = px / 1000;
    return (
      <svg
        data-slot="brand-lockup"
        data-layout="stacked"
        className={className}
        viewBox={`0 0 ${s.width} ${s.height}`}
        width={Math.round(s.width * unit * 100) / 100}
        height={Math.round(s.height * unit * 100) / 100}
        fill="currentColor"
        focusable="false"
        {...a11y(title)}
        {...props}
      >
        <path transform={`translate(${s.mark.x} ${s.mark.y}) scale(${s.mark.scale})`} d={G.mark[brandDrawing(px)]} />
        <path transform={`translate(${s.wordmark.x} ${s.wordmark.y}) scale(${s.wordmark.scale})`} d={G.wordmark.d} />
      </svg>
    );
  }
  const px = Math.max(24, size);
  const h = px >= 64 ? G.horizontal : G.topbar;
  const unit = px / 1000;
  return (
    <svg
      data-slot="brand-lockup"
      data-layout="horizontal"
      className={className}
      viewBox={`0 0 ${h.width} ${h.height}`}
      width={Math.round(h.width * unit * 100) / 100}
      height={px}
      fill="currentColor"
      focusable="false"
      {...a11y(title)}
      {...props}
    >
      <path d={G.mark[px >= 64 ? 'master' : 'small']} />
      <path transform={`translate(${h.wordmark.x} ${h.wordmark.y}) scale(${h.wordmark.scale})`} d={G.wordmark.d} />
    </svg>
  );
}

const TURNS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/**
 * The iris (BRAND.md, motion): `loop` is the loading loop (1400 ms, the aperture closes and opens while it turns 45°);
 * `open` plays the launch once (900 ms). Under reduced motion nothing turns: the loop breathes in opacity and the
 * launch shows the mark already open. Drawn from the small blade under 64 pixels and the master above; never below
 * 24 pixels, where the micro drawing has no slits to turn.
 */
export function BrandIris({
  size = 32,
  mode = 'loop',
  title,
  className,
  ...props
}: SvgProps & { size?: number; mode?: 'loop' | 'open'; title?: string }) {
  const px = Math.max(24, size);
  const blade = G.blade[px >= 64 ? 'master' : 'small'];
  return (
    <svg
      data-slot="brand-iris"
      data-mode={mode}
      className={['brand-iris', className].filter(Boolean).join(' ')}
      viewBox="0 0 1000 1000"
      width={px}
      height={px}
      fill="currentColor"
      focusable="false"
      {...a11y(title)}
      {...props}
    >
      <g className="brand-iris__spin">
        {TURNS.map((turn) => (
          <g key={turn} transform={`rotate(${turn} 500 500)`}>
            <g transform={`translate(${blade.pivotX} ${blade.pivotY})`}>
              <path className="brand-iris__blade" d={blade.d} />
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * The brand in an app bar: the horizontal lockup (top-bar drawing, 24 pixels) on a wide screen, the mark alone on a
 * phone, where the bar is tight and the dock below carries the rooms. The bar's link carries the name.
 */
export function BrandBar({ className }: { className?: string }) {
  return (
    <span data-slot="brand-bar" className={['brand-bar', className].filter(Boolean).join(' ')}>
      <BrandLockup size={24} title="" className="brand-bar__wide" />
      <BrandMark size={24} className="brand-bar__compact" />
    </span>
  );
}
