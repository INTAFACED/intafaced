import * as React from 'react';
import { cn } from './cn.js';
import { type Density, DEFAULT_DENSITY } from './density.js';

export type BadgeTone = 'neutral' | 'lime' | 'warn' | 'error' | 'up' | 'down';
export type BadgeVariant = 'soft' | 'outline';

// soft = tinted background; outline = hairline in the text colour (same look as StatusTag).
const tones: Record<BadgeTone, { soft: string; outline: string }> = {
  neutral: { soft: 'bg-hover text-fg-2', outline: 'text-fg-2' },
  lime: { soft: 'bg-lime-soft text-accent-text', outline: 'text-accent-text' },
  warn: { soft: 'bg-warn/15 text-warn', outline: 'text-warn' },
  error: { soft: 'bg-error/15 text-error-text', outline: 'text-error-text' },
  up: { soft: 'bg-up-bg-soft text-up-text', outline: 'text-up-text' },
  down: { soft: 'bg-down-bg text-down-text', outline: 'text-down-text' },
};

const sizes: Record<Density, string> = {
  dense: 'h-5 px-1.5 text-2xs',
  comfortable: 'h-6 px-2 text-xs',
};

export interface BadgeProps extends React.ComponentProps<'span'> {
  /** The label. Required: colour alone must never be the cue. */
  children: React.ReactNode;
  /** lime = selected or purposeful (DESIGN.md). up and down are for market direction only. */
  tone?: BadgeTone;
  variant?: BadgeVariant;
  density?: Density;
  /** Optional leading icon, drawn decorative (the label carries the meaning). */
  icon?: React.ReactNode;
}

/** Small generic label. The text is always there; tone only tints it. */
export function Badge({ tone = 'neutral', variant = 'soft', density = DEFAULT_DENSITY, icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-tone={tone}
      data-variant={variant}
      data-density={density}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-xs',
        sizes[density],
        variant === 'outline' ? 'border border-current/40' : null,
        tones[tone][variant],
        className,
      )}
      {...props}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex size-3 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
