'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `toggle-group.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/toggle-group.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: reduced to a single-choice group with a plain string value (always one
 * item selected); chip and range-pill looks from UI-SPEC 4.1 added; tokens only.
 */
import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cn, focusRing } from './cn.js';

export type ToggleGroupVariant = 'chip' | 'pill';
const VariantContext = React.createContext<ToggleGroupVariant>('chip');

export interface ToggleGroupProps extends Omit<
  ToggleGroupPrimitive.Props<string>,
  'value' | 'defaultValue' | 'onValueChange' | 'multiple'
> {
  /** The selected item. Single choice: one item is always selected. */
  value: string;
  onValueChange: (value: string) => void;
  /** `chip`: 32 px, `r-sm`, active = `field` + `fg` (filters, categories). `pill`: `r-pill`, active = `pill-active` (ranges). */
  variant?: ToggleGroupVariant;
}

export function ToggleGroup({ className, value, onValueChange, variant = 'chip', ...props }: ToggleGroupProps) {
  return (
    <VariantContext.Provider value={variant}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        value={[value]}
        multiple={false}
        onValueChange={(next) => {
          // Single choice: pressing the active item again does not clear it.
          const picked = next[0];
          if (picked !== undefined) onValueChange(picked);
        }}
        className={cn('flex items-center', 'gap-1', className)}
        {...props}
      />
    </VariantContext.Provider>
  );
}

export function ToggleGroupItem({ className, ...props }: TogglePrimitive.Props<string>) {
  const variant = React.useContext(VariantContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium text-fg-2',
        'transition-colors duration-(--if-t-fast) ease-if hover:text-fg data-pressed:text-fg',
        'data-disabled:pointer-events-none data-disabled:opacity-40',
        variant === 'chip'
          ? 'h-8 rounded-sm px-3 text-sm data-pressed:bg-field'
          : 'h-8 rounded-pill px-3 text-sm data-pressed:bg-pill-active',
        focusRing,
        className,
      )}
      {...props}
    />
  );
}
