import * as React from 'react';
import { cn } from './cn.js';

/**
 * The one INTAFACED wordmark: lowercase "intafaced" followed by a lime dot (taste call T1-A, provisional).
 * Used in the top bar and on the sign-in pages so the brand reads the same either side of the login.
 * Swap this one component when a real logo exists; nothing else draws the name.
 */
export function Wordmark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="wordmark" className={cn('font-ui text-md font-bold tracking-[-0.02em] whitespace-nowrap', className)} {...props}>
      intafaced
      <span aria-hidden="true" className="text-accent-text">
        ·
      </span>
    </span>
  );
}
