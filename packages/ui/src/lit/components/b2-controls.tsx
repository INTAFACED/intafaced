/**
 * Volt's overlays: popover, menu and tooltip, and the marks over a drawn chart. Behaviour (focus, Escape, positioning,
 * roles) is Base UI's, as in the older kit; the look is `components.css` (`lt-pop`, `lt-menu`, `lt-tip`), which reads
 * only `--lit-*` roles. Rooms never restyle them. Select, tabs, the sheet, checkbox, the decimal field and the table are
 * the templates' own (`b2-basics.tsx`, `b2-table.tsx`): one kit, one part per role.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';

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

// ---- Chart overlay: marks drawn over a chart's canvas at the chart's own pixel positions ------------------------

/** A layer over a drawn chart: fills its host, lets the pointer through except on its marks. */
export function ChartOverlay({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx('lt-chart-overlay', className)} />;
}

export type ChartMarkProps = Omit<React.HTMLAttributes<HTMLElement>, 'style'> & {
  /** line: an order's label on its price; preview: an order not placed yet; plus: the price axis's add key; menu: a small menu at a point. */
  kind: 'line' | 'preview' | 'plus' | 'menu';
  /** Distance from the overlay's block start, in CSS pixels, as the chart library reports it. */
  y: number;
  /** Distance from the overlay's inline start, in CSS pixels (a menu at the pointer). */
  x?: number;
  /** A mark the person acts on (drag, press) is a button. */
  as?: 'div' | 'button';
  /** A button mark that can't be used right now. */
  disabled?: boolean;
};

/** One mark on a ChartOverlay, placed at the chart's coordinates; buy and sell read `data-side`. */
export function ChartMark({ kind, y, x, as = 'div', disabled, className, ...props }: ChartMarkProps) {
  const style: React.CSSProperties = { insetBlockStart: `${y}px`, ...(x === undefined ? {} : { insetInlineStart: `${x}px` }) };
  if (as === 'button')
    return (
      <button type="button" {...props} disabled={disabled} data-mark={kind} className={clsx('lt-chart-mark', className)} style={style} />
    );
  return <div {...props} data-mark={kind} className={clsx('lt-chart-mark', className)} style={style} />;
}
