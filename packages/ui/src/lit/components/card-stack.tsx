/**
 * CardStack: the account drawn as two cards you hold, one in front as matte black metal and one behind it lit as the
 * screen's one spark. Each card is a link to its part of the account. Values arrive drawn (a Figure, or a mask when
 * balances are hidden); the stack makes up no figure. While loading it keeps its shape and says nothing.
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type StackCard = {
  label: string;
  /** The card's figure, already formatted (or masked) by the caller. */
  value: React.ReactNode;
  href: string;
  /** A small mark before the label on the front card (the brand mark). */
  mark?: React.ReactNode;
};

export type CardStackProps = Omit<React.HTMLAttributes<HTMLElement>, 'children'> & {
  /** The stack's name ("Your holdings"). */
  label: string;
  front: StackCard;
  back: StackCard;
};

export function CardStack({ label, front, back, className, ...rest }: CardStackProps) {
  return (
    <section {...rest} className={clsx('lit-stack', className)} aria-label={label}>
      <a className="lit-stack__card" data-card="back" href={back.href}>
        <span data-part="label">{back.label}</span>
        <span data-part="peek">{back.value}</span>
      </a>
      <a className="lit-stack__card" data-card="front" href={front.href}>
        <span data-part="top">
          {front.mark ? <span data-part="mark">{front.mark}</span> : null}
          <span data-part="label">{front.label}</span>
        </span>
        <span data-part="figure">{front.value}</span>
      </a>
    </section>
  );
}

/** The stack's shape while its figures load: no words, no links, hidden from assistive tech. */
export function CardStackLoading({ className }: { className?: string }) {
  return (
    <section className={clsx('lit-stack', className)} aria-hidden="true" data-loading="">
      <span className="lit-stack__card" data-card="back" />
      <span className="lit-stack__card" data-card="front">
        <span data-part="skeleton" />
      </span>
    </section>
  );
}
