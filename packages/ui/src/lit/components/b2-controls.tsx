/**
 * Volt's popover and tooltip, and the marks over a drawn chart. Behaviour (focus, Escape, positioning, roles) is Base
 * UI's, as in the older kit; the look is `components.css` (`lt-pop`, `lt-tip`), which reads only `--lit-*` roles. Rooms
 * never restyle them. The menu is `Menu` in `./controls.tsx`; select, tabs, the sheet, checkbox, the decimal field and
 * the table are the templates' own (`b2-basics.tsx`, `b2-table.tsx`): one kit, one part per role.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
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
