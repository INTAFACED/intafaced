'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `select.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/select.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); dark panel list, 32/40 px triggers on `field`.
 */
import * as React from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn, focusRing, itemRow, popupMotion, popupSurface } from './cn.js';

/**
 * Pass `items` (value to label) on the Root so the closed trigger shows the label:
 * `<Select items={{ all: 'All assets', BTC: 'BTC' }} value={v} onValueChange={...}>`.
 */
export const Select = SelectPrimitive.Root;

export function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" className={cn('truncate', className)} {...props} />;
}

export function SelectTrigger({ className, size = 40, children, ...props }: SelectPrimitive.Trigger.Props & { size?: 32 | 40 }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'inline-flex w-fit min-w-0 select-none items-center justify-between gap-2 whitespace-nowrap rounded-sm bg-field px-3 text-base text-fg',
        'transition-colors duration-(--if-t-fast) ease-if hover:bg-raised data-popup-open:bg-raised',
        'data-disabled:cursor-not-allowed data-disabled:opacity-40',
        size === 32 ? 'h-8 text-sm' : 'h-10',
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="shrink-0 text-fg-2 transition-transform duration-(--if-t-fast) ease-if data-popup-open:rotate-180">
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  ...props
}: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignItemWithTrigger={false}
        className="isolate z-50 outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            popupSurface,
            popupMotion,
            'relative max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-lg p-2 outline-none',
            className,
          )}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className="flex h-5 w-full items-center justify-center text-fg-2">
            <ChevronUp size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List className="outline-none">{children}</SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className="flex h-5 w-full items-center justify-center text-fg-2">
            <ChevronDown size={14} aria-hidden="true" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return <SelectPrimitive.GroupLabel data-slot="select-label" className={cn('px-3 py-2 text-xs text-fg-2', className)} {...props} />;
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn(itemRow, 'pr-9', className)} {...props}>
      <SelectPrimitive.ItemText className="truncate">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-3 inline-flex items-center text-accent-text">
        <Check size={16} strokeWidth={2} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return <SelectPrimitive.Separator data-slot="select-separator" className={cn('-mx-2 my-2 h-px bg-line', className)} {...props} />;
}
