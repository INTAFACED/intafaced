/**
 * Volt's overlays and dense controls: popover, menu, select, panel tabs, tooltip, dialogs and checkbox. Behaviour
 * (focus, Escape, positioning, roles) is Base UI's, as in the older kit; the look is `components.css` (`lt-pop`,
 * `lt-menu`, `lt-panel-tabs`, `lt-dialog`, `lt-check`), which reads only `--lit-*` roles. Rooms never restyle them.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';

// ---- Popover -------------------------------------------------------------------------------------------------

export function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

export type PopoverContentProps = PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset' | 'anchor' | 'positionMethod'> & {
    /** wide: room for a list or a small form. */
    size?: 'md' | 'wide';
  };

/** Portal, positioner and popup in one: the raised panel with its hairline. */
export function PopoverContent({
  className,
  side = 'bottom',
  sideOffset = 8,
  align = 'center',
  alignOffset = 0,
  anchor,
  positionMethod,
  size = 'md',
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        positionMethod={positionMethod}
        className="lt-layer"
      >
        <PopoverPrimitive.Popup data-slot="popover-content" data-size={size} className={clsx('lt-pop', className)} {...props} />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export const PopoverClose = PopoverPrimitive.Close;

export function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={clsx('lt-pop-title', className)} {...props} />;
}

// ---- Menu ----------------------------------------------------------------------------------------------------

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
      <MenuPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset} className="lt-layer">
        <MenuPrimitive.Popup data-slot="menu-content" className={clsx('lt-pop lt-menu', className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

/** Must sit inside a MenuGroup (Base UI throws otherwise). */
export function MenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel data-slot="menu-label" className={clsx('lt-menu-label', className)} {...props} />;
}

export function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return <MenuPrimitive.Item data-slot="menu-item" className={clsx('lt-menu-item', className)} {...props} />;
}

export function MenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return <MenuPrimitive.LinkItem data-slot="menu-link-item" className={clsx('lt-menu-item', className)} {...props} />;
}

const Tick = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function MenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem data-slot="menu-checkbox-item" className={clsx('lt-menu-item', className)} {...props}>
      {children}
      <MenuPrimitive.CheckboxItemIndicator className="lt-menu-tick">
        <Tick />
      </MenuPrimitive.CheckboxItemIndicator>
    </MenuPrimitive.CheckboxItem>
  );
}

export function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

export function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem data-slot="menu-radio-item" className={clsx('lt-menu-item', className)} {...props}>
      {children}
      <MenuPrimitive.RadioItemIndicator className="lt-menu-tick">
        <Tick />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="menu-separator" className={clsx('lt-menu-rule', className)} {...props} />;
}

// ---- Select --------------------------------------------------------------------------------------------------

/** Pass `items` (value to label) on the root so the closed trigger shows the label. */
export const Select = SelectPrimitive.Root;

export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" className={clsx('lt-select-value', className)} {...props} />;
}

const Chevron = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function SelectTrigger({ className, size = 'md', children, ...props }: SelectPrimitive.Trigger.Props & { size?: 'sm' | 'md' }) {
  return (
    <SelectPrimitive.Trigger data-slot="select-trigger" data-size={size} className={clsx('lt-select', className)} {...props}>
      {children}
      <SelectPrimitive.Icon className="lt-select-icon">
        <Chevron />
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
      <SelectPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignItemWithTrigger={false} className="lt-layer">
        <SelectPrimitive.Popup data-slot="select-content" className={clsx('lt-pop lt-menu', className)} {...props}>
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={clsx('lt-menu-item', className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="lt-menu-tick">
        <Tick />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

// ---- Panel tabs: tabs that switch panels in place (Tabs, in b2-basics, are links between pages) ---------------

export function TabSet({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={clsx('lt-tabset', className)} {...props} />;
}

export function TabList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List data-slot="tabs-list" className={clsx('lt-panel-tabs', className)} {...props}>
      {children}
      <TabsPrimitive.Indicator data-slot="tabs-indicator" className="lt-panel-tabs-mark" />
    </TabsPrimitive.List>
  );
}

export function Tab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return <TabsPrimitive.Tab data-slot="tabs-tab" className={clsx('lt-panel-tab', className)} {...props} />;
}

export function TabPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-panel" className={clsx('lt-tab-panel', className)} {...props} />;
}

// ---- Tooltip -------------------------------------------------------------------------------------------------

export function TooltipProvider({ delay = 300, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

export function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="lt-layer">
        <TooltipPrimitive.Popup data-slot="tooltip-content" className={clsx('lt-tip', className)} {...props} />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

// ---- Alert dialog: a confirmation that traps focus (review an order, cancel orders) ---------------------------

export function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

export function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

export const AlertDialogClose = AlertDialogPrimitive.Close;

export function AlertDialogContent({ className, children, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop data-slot="alert-dialog-overlay" className="lt-scrim" />
      <AlertDialogPrimitive.Popup data-slot="alert-dialog-content" className={clsx('lt-dialog', className)} {...props}>
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-header" className={clsx('lt-dialog-head', className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-footer" className={clsx('lt-dialog-foot', className)} {...props} />;
}

export function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={clsx('lt-dialog-title', className)} {...props} />;
}

export function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={clsx('lt-dialog-body', className)} {...props} />;
}

// ---- Dialog: a modal on the native <dialog>, closed by its button, Escape or a click outside -------------------

export function Dialog({
  title,
  children,
  onClose,
  closeLabel,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  /** The close button's name, from the room's copy ("Close"). */
  closeLabel: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal?.();
    return () => {
      dialog?.close?.();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className="lt-dialog lt-dialog-native"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="lt-dialog-head lt-dialog-head-row">
        <h2 id={titleId} className="lt-dialog-title">
          {title}
        </h2>
        <button type="button" className="lit-button" data-tone="quiet" data-size="sm" aria-label={closeLabel} onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}

// ---- Checkbox ------------------------------------------------------------------------------------------------

export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={clsx('lt-check', className)} {...props}>
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="lt-check-mark">
        <Tick />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
