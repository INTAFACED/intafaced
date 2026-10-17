'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `navigation-menu.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/navigation-menu.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); hover and focus dropdown for the top bar with 56 px icon + title + description cards (UI-SPEC 3.1).
 */
import * as React from 'react';
import { NavigationMenu as NavigationMenuPrimitive } from '@base-ui/react/navigation-menu';
import { ChevronDown } from 'lucide-react';
import { cn, focusRing, popupSurface } from './cn.js';

/**
 * Top-bar dropdowns. The positioner, popup and shared viewport are built in, so
 * usage is: Root > List > Item > (Trigger + Content with NavigationMenuCard rows).
 * Items that are only links (Home) use NavigationMenuLink inside an Item.
 */
export function NavigationMenu({ className, children, ...props }: NavigationMenuPrimitive.Root.Props) {
  return (
    <NavigationMenuPrimitive.Root data-slot="navigation-menu" className={cn('relative flex items-center', className)} {...props}>
      {children}
      <NavigationMenuPrimitive.Portal>
        <NavigationMenuPrimitive.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={{ top: 8, bottom: 8, left: 24, right: 24 }}
          className="isolate z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom] duration-(--if-t-menu) ease-if before:absolute before:inset-x-0 before:-top-2 before:h-2 before:content-[''] data-instant:transition-none"
        >
          <NavigationMenuPrimitive.Popup
            data-slot="navigation-menu-popup"
            className={cn(
              popupSurface,
              'relative h-(--popup-height) w-(--popup-width) origin-(--transform-origin) rounded-lg outline-none',
              'transition-[opacity,scale,width,height] duration-(--if-t-menu) ease-if data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0',
            )}
          >
            <NavigationMenuPrimitive.Viewport className="relative size-full overflow-hidden rounded-lg" />
          </NavigationMenuPrimitive.Popup>
        </NavigationMenuPrimitive.Positioner>
      </NavigationMenuPrimitive.Portal>
    </NavigationMenuPrimitive.Root>
  );
}

export function NavigationMenuList({ className, ...props }: NavigationMenuPrimitive.List.Props) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn('flex list-none items-center gap-6', className)}
      {...props}
    />
  );
}

export function NavigationMenuItem({ className, ...props }: NavigationMenuPrimitive.Item.Props) {
  return <NavigationMenuPrimitive.Item data-slot="navigation-menu-item" className={cn('relative', className)} {...props} />;
}

/** The top-bar tab that opens a dropdown. `active` draws the 2 px lime bar on the bar's bottom edge. */
export function NavigationMenuTrigger({
  className,
  children,
  active = false,
  ...props
}: NavigationMenuPrimitive.Trigger.Props & { active?: boolean }) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      data-active={active || undefined}
      className={cn(
        'relative inline-flex h-12 items-center gap-1 text-base font-medium text-fg-2 transition-colors duration-(--if-t-fast) ease-if',
        'hover:text-fg data-popup-open:text-fg data-active:text-fg',
        'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-lime after:opacity-0 data-active:after:opacity-100',
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
      <NavigationMenuPrimitive.Icon className="transition-transform duration-(--if-t-fast) ease-if data-popup-open:rotate-180">
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </NavigationMenuPrimitive.Icon>
    </NavigationMenuPrimitive.Trigger>
  );
}

export function NavigationMenuContent({ className, ...props }: NavigationMenuPrimitive.Content.Props) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        'h-full w-80 p-2 transition-[opacity,translate] duration-(--if-t-menu) ease-if',
        'data-starting-style:opacity-0 data-ending-style:opacity-0',
        'data-starting-style:data-[activation-direction=left]:-translate-x-6 data-starting-style:data-[activation-direction=right]:translate-x-6',
        'data-ending-style:data-[activation-direction=left]:translate-x-6 data-ending-style:data-[activation-direction=right]:-translate-x-6',
        className,
      )}
      {...props}
    />
  );
}

/** Use `render={<a href="/home" />}` (or the router's Link) for client-side navigation. */
export function NavigationMenuLink({ className, ...props }: NavigationMenuPrimitive.Link.Props) {
  return <NavigationMenuPrimitive.Link data-slot="navigation-menu-link" className={cn('outline-none', focusRing, className)} {...props} />;
}

export interface NavigationMenuCardProps extends NavigationMenuPrimitive.Link.Props {
  /** A Lucide icon element at 20 px, e.g. `<Wallet size={20} />`. */
  icon: React.ReactNode;
  title: string;
  /** One line, `text-xs fg-2`. */
  description: string;
}

/** A dropdown row: 56 px, icon + title (`text-base` 500) + one-line description. */
export function NavigationMenuCard({ icon, title, description, className, ...props }: NavigationMenuCardProps) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-card"
      className={cn(
        'flex h-14 w-full items-center gap-3 rounded-sm px-3 text-left text-fg no-underline outline-none transition-colors duration-(--if-t-fast) ease-if hover:bg-hover',
        focusRing,
        'focus-visible:-outline-offset-2',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center text-fg-2">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-base font-medium">{title}</span>
        <span className="truncate text-xs text-fg-2">{description}</span>
      </span>
    </NavigationMenuPrimitive.Link>
  );
}
