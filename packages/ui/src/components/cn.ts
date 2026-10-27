import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Class merging for our Tailwind theme. tailwind-merge only knows Tailwind's
 * default scales, so without this `text-hero` would be read as a colour and
 * silently drop a real colour class next to it.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['hero', 'hero-pro'],
      radius: ['pill', '2xs'],
      shadow: ['menu'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Visible lime focus ring on every control: 2 px, 2 px offset (UI-SPEC 2.4).
 * `outline-solid` is needed: Tailwind 4's `outline-none` sets the style variable to none,
 * so `outline-2` alone would draw nothing.
 */
export const focusRing =
  'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * Surface for every popup (menu, popover, dialog, select): `panel`, a 1 px hairline of white at 13%
 * (OKX's popover border, taste call T3-C), the one allowed shadow (UI-SPEC 2.4). Popups render in a
 * portal outside `.if-app`, so they carry their own font and text colour.
 */
export const popupSurface = 'bg-panel text-fg font-ui text-base border border-line-popup shadow-menu antialiased';

/** Tooltips sit one step lighter, on `raised`, with 4 px corners (T3-C), so small help text separates from black. */
export const tooltipSurface = 'bg-raised text-fg font-ui text-xs shadow-menu antialiased';

/**
 * Fade plus scale 0.98 to 1 over the menu duration (COMPONENT-PLAN 3.7).
 * Driven by Base UI's data-starting-style / data-ending-style; the duration is
 * 0 ms under prefers-reduced-motion because the token itself becomes 0 ms.
 */
export const popupMotion =
  'origin-(--transform-origin) transition-[opacity,scale] duration-(--if-t-menu) ease-if data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0';

/** Menu-like row: 40 px, `r-sm`, hover and keyboard highlight on `hover`. */
export const itemRow =
  'relative flex min-h-10 w-full cursor-default select-none items-center gap-2 rounded-sm px-3 text-base outline-none data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-40';
