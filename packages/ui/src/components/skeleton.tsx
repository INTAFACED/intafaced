import * as React from 'react';
import { cn } from './cn.js';

export interface SkeletonProps extends React.ComponentProps<'div'> {
  /** Exact final size, so nothing shifts when data arrives. Numbers are px. */
  width?: number | string;
  height?: number | string;
  /** Round (avatars, coin icons) instead of `r-sm`. */
  circle?: boolean;
}

/**
 * Loading block (UI-SPEC 4.3): a `panel` block of the exact final size. The
 * shimmer is a slow brightness sweep that only exists when the person has not
 * asked for reduced motion; otherwise it is a static block.
 */
export function Skeleton({ className, width, height, circle = false, style, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      style={{ width, height, ...style }}
      className={cn(
        'shrink-0 bg-panel',
        circle ? 'rounded-pill' : 'rounded-sm',
        'motion-safe:animate-[if-shimmer_1.6s_ease-in-out_infinite]',
        className,
      )}
      {...props}
    />
  );
}
