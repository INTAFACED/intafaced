/*
 * Base UI Toast, styled with INTAFACED tokens. Written for this repo from the Base UI
 * 1.8.0 Toast documentation (MIT, https://base-ui.com/react/components/toast); not copied
 * from shadcn/ui, whose Base UI flavour has no toast (it uses Sonner).
 */
import * as React from 'react';
import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { X } from 'lucide-react';
import { cn, focusRing, popupSurface } from './cn.js';

export interface ToastOptions {
  title: string;
  description?: string;
  /** Milliseconds before it closes. Default 5000; 0 keeps it until dismissed. */
  timeout?: number;
}

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts } = ToastPrimitive.useToastManager();
  return (
    <>
      {toasts.map((toast) => (
        <ToastPrimitive.Root
          key={toast.id}
          toast={toast}
          data-slot="toast"
          className={cn(
            popupSurface,
            'pointer-events-auto relative flex w-full max-w-sm items-start gap-3 rounded-lg py-3 pr-3 pl-4',
            'transition-[opacity,translate] duration-(--if-t-menu) ease-if data-starting-style:-translate-y-2 data-starting-style:opacity-0 data-ending-style:-translate-y-2 data-ending-style:opacity-0',
          )}
        >
          <ToastPrimitive.Content className="flex min-w-0 flex-1 flex-col gap-0.5">
            <ToastPrimitive.Title className="text-base font-medium" />
            <ToastPrimitive.Description className="text-sm text-fg-2" />
          </ToastPrimitive.Content>
          <ToastPrimitive.Close
            aria-label={closeLabel}
            className={cn(
              'inline-flex size-6 shrink-0 items-center justify-center rounded-pill text-fg-2 hover:bg-hover hover:text-fg',
              focusRing,
            )}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
    </>
  );
}

/**
 * Mount once near the app root, around everything that may raise a toast.
 * Toasts appear top centre; the viewport is a polite live region (the only
 * live announcements in the app, COMPONENT-PLAN 3.8).
 */
export function ToastProvider({
  children,
  timeout = 5000,
  closeLabel = 'Dismiss',
}: {
  children?: React.ReactNode;
  timeout?: number;
  closeLabel?: string;
}) {
  return (
    <ToastPrimitive.Provider timeout={timeout} limit={3}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          data-slot="toast-viewport"
          className="pointer-events-none fixed inset-x-0 top-[calc(var(--if-banner-offset,0px)+56px)] z-60 flex flex-col items-center gap-2 px-4"
        >
          <ToastList closeLabel={closeLabel} />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

/** `const toast = useToast(); toast.add({ title: 'Bought 0.01 BTC at 83,281.8 USDT' })`. */
export function useToast(): { add: (options: ToastOptions) => string; close: (id?: string) => void } {
  const manager = ToastPrimitive.useToastManager();
  return {
    add: (options) => manager.add(options),
    close: (id) => manager.close(id),
  };
}
