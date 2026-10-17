import * as React from 'react';
import { cn, focusRing } from './cn.js';

export interface SubNavItem {
  id: string;
  label: React.ReactNode;
  href: string;
}

export interface SubNavProps {
  /** Accessible name of the navigation landmark. */
  'aria-label': string;
  items: readonly SubNavItem[];
  /** `id` of the current item; it gets `aria-current="page"`. */
  active: string;
  className?: string;
}

/**
 * Link row for rooms that share one section (Trade: Spot, Margin, Futures ...). Every room draws the same pills at the
 * same size, so moving between rooms never shifts the row. Plain links, so each room keeps its own route.
 */
export function SubNav({ items, active, className, ...rest }: SubNavProps) {
  return (
    <nav
      data-slot="sub-nav"
      aria-label={rest['aria-label']}
      className={cn('flex flex-wrap items-center gap-1 border-b border-line px-(--if-gutter) py-2', className)}
    >
      {items.map((item) => (
        <a
          key={item.id}
          href={item.href}
          aria-current={item.id === active ? 'page' : undefined}
          className={cn(
            'inline-flex h-8 items-center rounded-full px-3 text-sm font-medium text-fg-2 transition-colors duration-(--if-t-fast) ease-if',
            'hover:bg-hover hover:text-fg aria-[current=page]:bg-raised aria-[current=page]:text-fg',
            focusRing,
          )}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
