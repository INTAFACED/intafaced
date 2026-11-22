/**
 * Owner: lane B2 (templates). Parts Home's overview draws that the kit lacked: the money card stack (the account as two
 * cards, cash in front, crypto behind), an info tip (a rule a figure follows, on hover, focus and press) and a coin's
 * mark. They read only `--lit-*` roles (styles in `../templates/templates.css`).
 */
import * as React from 'react';
import { coinArt } from '../../components/coins/coin-art.generated.js';
import { Logo } from './index.js';
import { Skeleton } from './b2-basics.js';

export interface StackCard {
  label: string;
  href: string;
  /** The card's figure, drawn by the room (a hidden balance stays hidden). */
  value: React.ReactNode;
}

/**
 * The money object: the account as a stack of two cards, the front one matte black metal with the brand's mark, the back
 * one the screen's one spark of colour peeking over it. Each card opens its part of the account. While loading it keeps
 * its final shape, with a figure-sized ghost on the front card, and is hidden from assistive tech.
 */
export function CardStack({
  label,
  front,
  back,
  loading = false,
  testId,
}: {
  label: string;
  front?: StackCard;
  back?: StackCard;
  loading?: boolean;
  testId?: string;
}) {
  if (loading || !front || !back)
    return (
      <section className="lt-card-stack" aria-hidden="true">
        <div className="lt-card-stack-card" data-card="back" />
        <div className="lt-card-stack-card" data-card="front">
          <Skeleton shape="figure" />
        </div>
      </section>
    );
  return (
    <section className="lt-card-stack" aria-label={label} data-testid={testId}>
      <a className="lt-card-stack-card" data-card="back" href={back.href}>
        <span className="lt-card-stack-label">{back.label}</span>
        <span className="lt-card-stack-peek">{back.value}</span>
      </a>
      <a className="lt-card-stack-card" data-card="front" href={front.href}>
        <span className="lt-card-stack-top">
          <Logo variant="mark" size={24} />
          <span className="lt-card-stack-label">{front.label}</span>
        </span>
        <span className="lt-card-stack-figure">{front.value}</span>
      </a>
    </section>
  );
}

/**
 * "About this number": a small info key that shows the rule on hover, on keyboard focus and on press (a touch screen has
 * no hover), and hides it on Escape. The rule's words also sit in the page for screen readers, as the key's description,
 * so they never depend on the bubble. `side` opens the bubble below the key or towards the reading end of the line.
 */
export function InfoTip({
  text,
  label,
  side = 'bottom',
  testId,
}: {
  text: string;
  label: string;
  side?: 'bottom' | 'end';
  testId?: string;
}) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  return (
    <span className="lt-tip" data-side={side} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="lt-tip-key"
        data-testid={testId}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 16v-4M12 8h.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <span className="lt-tip-bubble" aria-hidden="true">
          {text}
        </span>
      ) : null}
      <span id={id} className="lt-sr">
        {text}
      </span>
    </span>
  );
}

/** True when the kit holds artwork for the asset (listed assets only). */
export const hasCoinMark = (asset: string) => asset.toUpperCase() in coinArt;

/**
 * A coin's round mark: the kit's own artwork for a listed asset, else its first letter in a circle. Decorative: the ticker
 * beside it names the asset. `size`: `row` in a list, `card` on a card.
 */
export function CoinMark({ asset, size = 'row' }: { asset: string; size?: 'row' | 'card' }) {
  const key = asset.toUpperCase();
  const svg = coinArt[key];
  if (svg)
    return (
      <span className="lt-coin" data-slot="coin-icon" data-asset={key} data-size={size}>
        {/* The art is this package's own generated constant (coins/coin-art.generated.ts): no script, handler, id or reference. */}
        <span className="lt-coin-art" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
      </span>
    );
  return (
    <span className="lt-coin" data-slot="coin-icon" data-asset={key} data-size={size} data-fallback="lettered" aria-hidden="true">
      {key.charAt(0)}
    </span>
  );
}
