'use client';

/**
 * Answer cards. Every single-choice question is a group of these (native radios keep the radiogroup
 * semantics, arrow-key navigation and form behaviour); every tick-box question and checkbox is a `CheckCard`
 * with the same material and a square indicator. The card look lives in outreach.css (`.choice-card`).
 *
 * `variant="compact"` is the short row used for the volume period: three equal 44px cards, no indicator.
 */
import { useId, type ReactNode } from 'react';

export interface ChoiceCardItem {
  value: string;
  label: string;
}

function Tick({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChoiceCards({
  label,
  items,
  value,
  onValueChange,
  disabled,
  describedBy,
  labelledBy,
  variant = 'stack',
}: {
  label: string;
  items: ChoiceCardItem[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
  /** The id of the heading that already asks this question: the group is then named by it, so it is read once, in the heading's words. */
  labelledBy?: string;
  variant?: 'stack' | 'compact';
}) {
  const name = useId();
  return (
    <div
      className="choice-cards"
      data-variant={variant === 'compact' ? 'compact' : undefined}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {items.map((item) => {
        const selected = value === item.value;
        return (
          <label className="choice-card" key={item.value} data-selected={selected || undefined} data-disabled={disabled || undefined}>
            <input
              type="radio"
              name={name}
              value={item.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onValueChange(item.value)}
            />
            <span className="choice-card-label">{item.label}</span>
            {variant === 'stack' && (
              <span className="choice-card-check" aria-hidden="true">
                <Tick />
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

/**
 * One tick-box answer, as a card. The native checkbox covers the whole card (so the card is the click target and the
 * focus ring is the card's); the name comes from a real label and the optional line is its description, so a screen
 * reader says the name, then the line.
 */
export function CheckCard({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  value,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  value?: string;
}) {
  const id = useId();
  return (
    <div className="choice-card check-card" data-selected={checked || undefined} data-disabled={disabled || undefined}>
      <input
        id={id}
        type="checkbox"
        value={value}
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-description` : undefined}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span className="choice-card-text">
        <label className="choice-card-label" htmlFor={id}>
          {label}
        </label>
        {description && (
          <small className="choice-card-description" id={`${id}-description`}>
            {description}
          </small>
        )}
      </span>
      <span className="choice-card-check choice-card-check-square" aria-hidden="true">
        <Tick />
      </span>
    </div>
  );
}
