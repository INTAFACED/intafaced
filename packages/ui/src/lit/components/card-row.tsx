/**
 * CardRow: cards that share one row, as many as fit at their least width, each as wide as the row allows (two cards
 * share it, never leaving an empty third), one under another on a phone. Gaps are the kit's item gap.
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type CardRowProps = React.HTMLAttributes<HTMLElement> & {
  /** A card's least width, as a CSS length (`16rem`). */
  min?: string;
  as?: 'div' | 'section';
};

export function CardRow({ min = '16rem', as: Tag = 'div', className, style, ...rest }: CardRowProps) {
  return (
    <Tag
      {...rest}
      className={clsx('lt-grid', className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}), 1fr))`, gap: 'var(--lit-gap-item)', ...style }}
    />
  );
}
