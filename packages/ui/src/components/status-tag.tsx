import * as React from 'react';
import { cn } from './cn.js';

export type StatusKind = 'filled' | 'working' | 'pending' | 'cancelled' | 'failed';

const look: Record<StatusKind, { tone: string; label: string }> = {
  filled: { tone: 'text-accent-text bg-lime-soft', label: 'Filled' },
  working: { tone: 'text-fg-2', label: 'Working' },
  pending: { tone: 'text-warn', label: 'Pending' },
  cancelled: { tone: 'text-down-text', label: 'Cancelled' },
  failed: { tone: 'text-down-text', label: 'Failed' },
};

export interface StatusTagProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  status: StatusKind;
  /** Replaces the default English word (screens pass their `defineCopy` string). */
  label?: string;
}

/** Outlined status tag: Filled (lime), Working (grey), Pending (amber), Cancelled and Failed (red). The word carries the meaning, never colour alone. */
export function StatusTag({ status, label, className, ...props }: StatusTagProps) {
  const l = look[status];
  return (
    <span
      data-slot="status-tag"
      data-status={status}
      className={cn(
        'inline-flex h-5 items-center whitespace-nowrap rounded-xs border border-current/40 px-1.5 text-2xs',
        l.tone,
        className,
      )}
      {...props}
    >
      {label ?? l.label}
    </span>
  );
}
