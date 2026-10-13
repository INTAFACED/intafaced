'use client';

/**
 * Stacked full-width answer cards for single-choice questions with more than three options.
 * Native radios keep the radiogroup semantics, arrow-key navigation and form behaviour; the
 * card look matches `.interest-choice` and the halo toggle group.
 */
import { useId } from 'react';

export interface ChoiceCardItem {
  value: string;
  label: string;
}

export function ChoiceCards({
  label,
  items,
  value,
  onValueChange,
  disabled,
  describedBy,
}: {
  label: string;
  items: ChoiceCardItem[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const name = useId();
  return (
    <div className="choice-cards" role="radiogroup" aria-label={label} aria-describedby={describedBy}>
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
            <span className="choice-card-check" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </label>
        );
      })}
    </div>
  );
}
