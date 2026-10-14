/*
 * Structure adapted from shadcn/ui (Base UI flavour) `switch.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/switch.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); 40 x 24 pill, lime when on.
 */
import * as React from 'react';
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn, focusRing } from './cn.js';

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'inline-flex h-6 w-10 shrink-0 items-center rounded-pill bg-raised p-0.5 transition-colors duration-(--if-t-fast) ease-if',
        'data-checked:bg-lime data-disabled:cursor-not-allowed data-disabled:opacity-40',
        focusRing,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block size-5 rounded-pill bg-fg shadow-none transition-transform duration-(--if-t-fast) ease-if data-checked:translate-x-4 data-checked:bg-on-lime"
      />
    </SwitchPrimitive.Root>
  );
}
