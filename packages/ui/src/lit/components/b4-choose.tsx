/**
 * Two parts a room needs to ask and to pick: a confirm dialog (role `alertdialog`, the kit's glass sheet layer) and
 * a select (a combobox opening a listbox of options, drawn like `Field`'s control). Both are Base UI underneath, with
 * the old kit's part names so a room swaps them one for one. They read only lit roles through `components.css`; every
 * word arrives as a child or a prop. Names and meanings are in `../contracts.ts`.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';

/**
 * A confirmation (review a payment, cancel an order): focus is trapped, and the person leaves only by a button or
 * Escape. There is no built-in Close: the room puts its own choices in `AlertDialogFooter`, each a kit `Button`
 * wrapped as `<AlertDialogClose render={<Button tone="secondary" />}>Cancel</AlertDialogClose>`.
 */
export function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root {...props} />;
}

export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

/** Closes the dialog; render it as the kit's `Button` (see `AlertDialog`). */
export const AlertDialogClose = AlertDialogPrimitive.Close;

/** The dialog's panel, on the glass sheet layer over the scrim. `data-*` and `aria-*` props land on the panel. */
export function AlertDialogContent({ className, children, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="lit-alert-scrim" />
      <AlertDialogPrimitive.Popup {...props} className={clsx('lit-alert', className)} data-layer="sheet">
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx('lit-alert-head', className)} />;
}

export function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx('lit-alert-foot', className)} />;
}

export function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return <AlertDialogPrimitive.Title {...props} className={clsx('lit-alert-title', className)} />;
}

export function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return <AlertDialogPrimitive.Description {...props} className={clsx('lit-alert-text', className)} />;
}

/**
 * One value from a list. Pass `items` (value to label) on the root so the closed trigger shows the label:
 * `<Select items={{ usdt: 'USDT' }} value={v} onValueChange={...}>`. Name the trigger with `aria-label`.
 */
export const Select = SelectPrimitive.Root;

/** The closed select: a combobox drawn like `Field`'s control, with a chevron. */
export function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger {...props} className={clsx('lit-select', className)}>
      {children}
      <SelectPrimitive.Icon className="lit-select-mark">
        <ChevronDown aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value {...props} className={clsx('lit-select-value', className)} />;
}

/** The open list: a listbox under the trigger, at least as wide as it. */
export function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner side="bottom" align="start" sideOffset={4} alignItemWithTrigger={false} className="lit-select-pos">
        <SelectPrimitive.Popup {...props} className={clsx('lit-select-list', className)}>
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/** One option; the chosen one shows a check as well as its state, never colour alone. */
export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item {...props} className={clsx('lit-select-item', className)}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="lit-select-mark">
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
