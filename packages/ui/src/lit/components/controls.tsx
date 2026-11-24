/**
 * Volt overlay parts a desk needs: a menu and a headline figure with its freshness (a decimal box, the checkbox and the
 * modal dialog are `DecimalInput`, `Checkbox` and `Sheet` in `./b2-basics.tsx`; a text field is `Field`, in
 * `./index.tsx`). Behaviour is the old kit's (Base UI for focus and Escape); the look is only `--lit-*` roles, in
 * `../templates/templates.css` (`lt-menu`).
 */
import * as React from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { asOfIso, formatAsOf, freshnessOf, type AsOf, type Freshness } from '../../components/freshness.js';
import { useFreshnessClock } from '../../components/use-freshness-clock.js';
import { Button } from './index.js';

export interface MenuItemSpec {
  key: string;
  /** Its words; a refused item may add its reason on a second line. */
  label: React.ReactNode;
  disabled?: boolean;
  onSelect: () => void;
  testId?: string;
}

/**
 * A button that opens a list of actions (role menu). A `note` says why some are off, above them; `active` marks a
 * trigger whose list holds the choice in force (a desk's More intervals while one of them is shown).
 */
export function Menu({
  label,
  triggerLabel,
  items,
  align = 'end',
  note,
  active = false,
  size = 'md',
  testId,
}: {
  label: React.ReactNode;
  /** The trigger's spoken name, when it differs from its words. */
  triggerLabel?: string;
  items: readonly MenuItemSpec[];
  align?: 'start' | 'center' | 'end';
  note?: React.ReactNode;
  active?: boolean;
  /** sm: a dense desk control. */
  size?: 'sm' | 'md';
  testId?: string;
}) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        render={<Button tone="secondary" size={size} aria-label={triggerLabel} data-testid={testId} data-active={active || undefined} />}
      >
        {label}
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="bottom" sideOffset={8} align={align} className="lt-menu-layer">
          <MenuPrimitive.Popup className="lt-menu">
            {note ? (
              <p className="lt-note" role="note">
                {note}
              </p>
            ) : null}
            {items.map((item) => (
              <MenuPrimitive.Item
                key={item.key}
                className="lt-menu-item"
                disabled={item.disabled}
                onClick={item.onSelect}
                data-testid={item.testId}
              >
                {item.label}
              </MenuPrimitive.Item>
            ))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

const FRESHNESS: Record<Freshness, { status: 'done' | 'pending' | 'unknown' | 'failed'; word: string }> = {
  live: { status: 'done', word: 'Live' },
  stale: { status: 'pending', word: 'Stale' },
  unknown: { status: 'unknown', word: 'Unknown' },
  refused: { status: 'failed', word: 'Refused' },
};

export interface StatProps {
  label: string;
  /** Pre-formatted text. null = unknown: the dash, spoken "unknown", never 0. */
  value: string | null;
  /**
   * The value is money: marked as a money figure (`data-slot="money"`, which the look gate checks is never drawn on
   * see-through glass) and kept left to right, so "4,100 USDT" never reads "USDT 4,100" on a right-to-left page.
   */
  money?: boolean;
  hint?: string;
  /** With it (or when refused), a freshness chip with the as-of time sits under the value. */
  asOf?: AsOf;
  /** Epoch ms; without it the figure re-checks its own age. */
  now?: number;
  staleAfterMs?: number | null;
  refused?: boolean;
}

/** One headline figure with its label, its hint and how fresh it is (Live, Stale, Unknown, Refused) in words. */
export function Stat({ label, value, money, hint, asOf, now, staleAfterMs, refused }: StatProps) {
  const id = React.useId();
  const hasFreshness = asOf != null || refused === true;
  const clock = useFreshnessClock({ asOf, now, staleAfterMs, refused, enabled: hasFreshness });
  const freshness = hasFreshness ? freshnessOf({ asOf, now: clock, staleAfterMs, refused }) : undefined;
  const iso = hasFreshness ? asOfIso(asOf) : null;
  const shown = iso ? formatAsOf(asOf, { now: clock }) : null;
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className="lt-stat"
      data-freshness={freshness}
    >
      <span id={`${id}-label`} className="lt-hint">
        {label}
      </span>
      <span className="lt-figure" data-slot={money ? 'money' : undefined}>
        {value === null ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="lt-sr">unknown</span>
          </>
        ) : money ? (
          <span dir="ltr" data-ltr="">
            {value}
          </span>
        ) : (
          value
        )}
      </span>
      {hint ? (
        <span id={`${id}-hint`} className="lt-hint">
          {hint}
        </span>
      ) : null}
      {freshness ? (
        <span role="status" className="lt-chip" data-status={FRESHNESS[freshness].status} data-freshness={freshness}>
          <span className="lt-chip-mark" aria-hidden="true" />
          <span data-part="word">{FRESHNESS[freshness].word}</span>
          {iso && shown ? (
            <span>
              {' · as of '}
              <time dateTime={iso}>{shown}</time>
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
