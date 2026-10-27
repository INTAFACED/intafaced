'use client';

import * as React from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn, focusRing } from './cn.js';

/**
 * Structure follows shadcn/ui's Base UI button (see THIRD-PARTY.md); the
 * variants, sizes and every colour are ours (UI-SPEC 4.1, tokens only).
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap font-medium',
    'transition-[background-color,filter,color] duration-(--if-t-fast) ease-if',
    'data-disabled:cursor-not-allowed data-disabled:opacity-40',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    focusRing,
  ],
  {
    variants: {
      variant: {
        /** Lime pill: the one main action on a screen. */
        primary: 'bg-lime text-on-lime hover:bg-lime-hover active:bg-lime-press',
        secondary: 'bg-field text-fg hover:bg-raised active:bg-pill-active',
        ghost: 'bg-transparent text-fg-2 hover:bg-hover hover:text-fg active:bg-field',
        /** Up fill. Near-black text: white on this green fails AA (UI-SPEC 1.2). */
        buy: 'bg-up text-on-up hover:bg-up-hover active:brightness-95',
        sell: 'bg-down text-on-down hover:bg-down-hover active:brightness-95',
      },
      size: {
        28: 'h-7 px-3 text-sm',
        32: 'h-8 px-4 text-sm',
        40: 'h-10 px-5 text-base',
        48: 'h-12 px-6 text-md',
        56: 'h-14 px-8 text-md',
      },
      shape: {
        pill: 'rounded-pill',
        /** Desk submit buttons use `r-sm`. */
        rounded: 'rounded-sm',
      },
      fullWidth: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 40, shape: 'pill', fullWidth: false },
  },
);

export interface ButtonProps extends Omit<ButtonPrimitive.Props, 'disabled'>, Omit<VariantProps<typeof buttonVariants>, 'size'> {
  size?: 28 | 32 | 40 | 48 | 56;
  /** Shows a spinner after 300 ms and blocks clicks. The button stays focusable. */
  loading?: boolean;
  disabled?: boolean;
}

/** Small ring spinner. Static (no rotation) under reduced motion. */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 rounded-full border-2 border-current border-t-transparent opacity-70 motion-safe:animate-spin"
    />
  );
}

/**
 * Button. `variant`: primary | secondary | ghost | buy | sell.
 * `size`: 28 | 32 | 40 | 48 | 56 (px). `shape`: pill (default) | rounded.
 * For a link, pass `render={<a href=... />}` and `nativeButton={false}`.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, shape, fullWidth, loading = false, disabled, children, onClick, ...props },
  ref,
) {
  const [showSpinner, setShowSpinner] = React.useState(false);
  React.useEffect(() => {
    if (!loading) {
      setShowSpinner(false);
      return;
    }
    const id = window.setTimeout(() => setShowSpinner(true), 300);
    return () => window.clearTimeout(id);
  }, [loading]);

  return (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      data-variant={variant ?? 'primary'}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, shape, fullWidth }), className)}
      onClick={loading ? undefined : onClick}
      {...props}
    >
      {showSpinner ? <Spinner /> : null}
      {children}
    </ButtonPrimitive>
  );
});
