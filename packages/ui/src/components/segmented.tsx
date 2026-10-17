'use client';

import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cn, focusRing } from './cn.js';

export interface SegmentedItem {
  value: string;
  label: React.ReactNode;
  /** Active colours: `up` = green fill (Buy), `down` = red fill (Sell). Default = `raised` thumb. */
  tone?: 'default' | 'up' | 'down';
  'aria-label'?: string;
}

export interface SegmentedControlProps {
  items: readonly SegmentedItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** 28 = mode switch ("Simple | Pro"), 32 = in-card switch, 40 = order form (Buy / Sell). */
  size?: 28 | 32 | 40;
  /** Accessible name of the group. Required: there is no visible label. */
  'aria-label': string;
  fullWidth?: boolean;
  className?: string;
}

const heights = { 28: 'h-7 text-sm', 32: 'h-8 text-sm', 40: 'h-10 text-base' } as const;
const thumbTone = { default: 'bg-raised', up: 'bg-up', down: 'bg-down' } as const;
const textTone = { default: 'data-pressed:text-fg', up: 'data-pressed:text-on-up', down: 'data-pressed:text-on-down' } as const;

/**
 * Pill segmented control: `field` track, a thumb that slides 150 ms behind the
 * labels. Equal-width segments; the thumb is plain CSS so it never measures the DOM.
 */
export function SegmentedControl({ items, value, onValueChange, size = 28, fullWidth = false, className, ...rest }: SegmentedControlProps) {
  const index = Math.max(
    0,
    items.findIndex((i) => i.value === value),
  );
  const active = items[index];
  return (
    <ToggleGroupPrimitive
      data-slot="segmented-control"
      aria-label={rest['aria-label']}
      value={[value]}
      multiple={false}
      onValueChange={(next) => {
        const picked = next[0];
        if (picked !== undefined) onValueChange(picked);
      }}
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      className={cn('relative grid items-stretch rounded-pill bg-field p-0.5', fullWidth ? 'w-full' : 'w-fit', heights[size], className)}
    >
      <span
        aria-hidden="true"
        style={{ width: `calc((100% - 4px) / ${items.length})`, transform: `translateX(${index * 100}%)` }}
        className={cn(
          'pointer-events-none absolute inset-y-0.5 left-0.5 rounded-pill',
          'transition-[transform,background-color] duration-(--if-t-tab) ease-if',
          thumbTone[active?.tone ?? 'default'],
        )}
      />
      {items.map((item) => (
        <TogglePrimitive
          key={item.value}
          value={item.value}
          aria-label={item['aria-label']}
          className={cn(
            'relative z-10 inline-flex items-center justify-center whitespace-nowrap rounded-pill px-3 font-medium text-fg-2',
            'transition-colors duration-(--if-t-fast) ease-if hover:text-fg',
            textTone[item.tone ?? 'default'],
            focusRing,
          )}
        >
          {item.label}
        </TogglePrimitive>
      ))}
    </ToggleGroupPrimitive>
  );
}
