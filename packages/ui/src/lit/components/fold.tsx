/**
 * Fold: a group a reader opens when they want it (small balances, older items), closed by default. The browser's own
 * disclosure (`details`/`summary`), so keyboard, screen reader and find-in-page work with no script; the summary
 * carries the group's words and how many it holds.
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type FoldProps = Omit<React.DetailsHTMLAttributes<HTMLDetailsElement>, 'onToggle' | 'title'> & {
  /** The group's words ("Small balances"). */
  title: React.ReactNode;
  /** How many items the group holds, shown beside its words. */
  count?: number;
  /** Called with the new state when the reader opens or closes it. */
  onOpenChange?: (open: boolean) => void;
};

export function Fold({ title, count, onOpenChange, className, children, ...rest }: FoldProps) {
  return (
    <details {...rest} className={clsx('lit-fold', className)} onToggle={(e) => onOpenChange?.(e.currentTarget.open)}>
      <summary>
        <span data-part="title">{title}</span>
        {count !== undefined ? <span data-part="count">{count}</span> : null}
        <span data-part="mark" aria-hidden="true" />
      </summary>
      <div data-part="body">{children}</div>
    </details>
  );
}
