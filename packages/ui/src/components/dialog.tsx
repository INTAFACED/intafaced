/*
 * Structure adapted from shadcn/ui (Base UI flavour) `dialog.tsx`.
 * Source: https://github.com/shadcn-ui/ui/blob/30a58d4498f270af1c1e981a7d78a15cf5740841/apps/v4/registry/bases/base/ui/dialog.tsx
 * Commit: 30a58d4498f270af1c1e981a7d78a15cf5740841 · Licence: MIT · Copied: 2026-10-13
 * Changed: cn-* placeholder classes replaced with INTAFACED token classes (UI-SPEC 2); centred panel on a scrim, fade + scale 0.98 to 1.
 */
import * as React from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn, focusRing, popupMotion, popupSurface } from './cn.js';

export function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-scrim transition-opacity duration-(--if-t-menu) ease-if data-starting-style:opacity-0 data-ending-style:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  closeLabel = 'Close',
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean; closeLabel?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          popupSurface,
          popupMotion,
          'fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg p-6 outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            aria-label={closeLabel}
            className={cn(
              'absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-pill text-fg-2 transition-colors duration-(--if-t-fast) ease-if hover:bg-hover hover:text-fg',
              focusRing,
            )}
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('mb-4 flex flex-col gap-1 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="dialog-footer" className={cn('mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
  );
}

export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-lg font-semibold', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-base text-fg-2', className)} {...props} />;
}
