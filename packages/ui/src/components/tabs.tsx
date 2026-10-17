'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `tabs.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/tabs.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes; sliding
 * underline (Tabs.Indicator, 150 ms) and the lime tone for the top bar added.
 */
import * as React from 'react';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn, focusRing } from './cn.js';

type Tone = 'default' | 'lime';
const ToneContext = React.createContext<Tone>('default');

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col', className)} {...props} />;
}

export interface TabsListProps extends TabsPrimitive.List.Props {
  /** `default`: 2 px `fg` underline (panels). `lime`: 2 px lime underline (top bar). */
  tone?: Tone;
  /** Draw the 1 px `line` rule under the whole list (panel tab bars: 44 px). */
  divider?: boolean;
}

/** Underline tabs. Each tab is `text-base` 500, inactive `fg-2`, active `fg`. */
export function TabsList({ className, children, tone = 'default', divider = false, ...props }: TabsListProps) {
  return (
    <ToneContext.Provider value={tone}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn('relative flex items-stretch gap-6', divider && 'border-b border-line', className)}
        {...props}
      >
        {children}
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className={cn(
            'pointer-events-none absolute bottom-0 left-(--active-tab-left) h-0.5 w-(--active-tab-width)',
            'transition-[left,width] duration-(--if-t-tab) ease-if',
            tone === 'lime' ? 'bg-lime' : 'bg-fg',
          )}
        />
      </TabsPrimitive.List>
    </ToneContext.Provider>
  );
}

export function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        'relative inline-flex h-11 items-center justify-center whitespace-nowrap text-base font-medium text-fg-2',
        'transition-colors duration-(--if-t-fast) ease-if hover:text-fg data-active:text-fg',
        'data-disabled:pointer-events-none data-disabled:opacity-40',
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-panel" className={cn('flex-1', focusRing, className)} {...props} />;
}

/** shadcn-style aliases. */
export { TabsTab as TabsTrigger, TabsPanel as TabsContent };
