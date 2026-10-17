'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `tooltip.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/tooltip.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); small label on `raised` with 4 px corners (T3-C), opens on hover and on keyboard focus.
 */
import * as React from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn, popupMotion, tooltipSurface } from './cn.js';

/** Wrap the app once so neighbouring tooltips open instantly after the first. */
export function TooltipProvider({ delay = 300, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

export function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

/** Tooltips also open on keyboard focus (Base UI default); keep that. For touch, use a Popover. */
export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/** Distance kept from the top edge: the 48 px top bar, 8 px of air and the local test banner when one is shown. */
function topInset(): number {
  if (typeof document === 'undefined') return 56;
  const banner = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--if-banner-offset'), 10);
  return 56 + (banner > 0 ? banner : 0);
}

export function TooltipContent({
  className,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  children,
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={{ top: topInset(), right: 8, bottom: 8, left: 8 }}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(tooltipSurface, popupMotion, 'max-w-72 rounded-xs px-3 py-2', className)}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
