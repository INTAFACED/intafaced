'use client';

/*
 * Structure adapted from shadcn/ui (Base UI flavour) `dropdown-menu.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/dropdown-menu.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); renamed Menu, submenus left out, dark panel menu (UI-SPEC 1.2).
 */
import * as React from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Check } from 'lucide-react';
import { cn, itemRow, popupMotion, popupSurface } from './cn.js';

export function Menu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />;
}

export function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

export function MenuContent({
  className,
  side = 'bottom',
  sideOffset = 8,
  align = 'end',
  alignOffset = 0,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50 outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            popupSurface,
            popupMotion,
            'min-w-48 max-h-(--available-height) overflow-y-auto rounded-lg p-2 outline-none',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

/** Must sit inside a MenuGroup (Base UI throws otherwise). */
export function MenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel data-slot="menu-label" className={cn('px-3 py-2 text-xs text-fg-2', className)} {...props} />;
}

export function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item data-slot="menu-item" className={cn(itemRow, className)} {...props} />;
}

/** A menu row that is a real link: `<MenuLinkItem href="/account">Account</MenuLinkItem>`. */
export function MenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return <MenuPrimitive.LinkItem data-slot="menu-link-item" className={cn(itemRow, className)} {...props} />;
}

export function MenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem data-slot="menu-checkbox-item" className={cn(itemRow, 'pr-9', className)} {...props}>
      {children}
      <MenuPrimitive.CheckboxItemIndicator className="absolute right-3 inline-flex items-center text-accent-text">
        <Check size={16} strokeWidth={2} aria-hidden="true" />
      </MenuPrimitive.CheckboxItemIndicator>
    </MenuPrimitive.CheckboxItem>
  );
}

export function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

export function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem data-slot="menu-radio-item" className={cn(itemRow, 'pr-9', className)} {...props}>
      {children}
      <MenuPrimitive.RadioItemIndicator className="absolute right-3 inline-flex items-center text-accent-text">
        <Check size={16} strokeWidth={2} aria-hidden="true" />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="menu-separator" className={cn('-mx-2 my-2 h-px bg-line', className)} {...props} />;
}
