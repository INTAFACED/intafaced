/**
 * SearchField: a list's search box (a markets list, a directory) on the kit's field: the box with its search mark
 * inside, its name said to assistive tech rather than drawn above it, since the mark and the placeholder already say
 * what it is. Escape and the rest are the caller's (`onKeyDown`).
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type SearchFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** The box's name (`Search markets`). */
  label: string;
  /** The mark inside the box before the text. Decorative. */
  icon?: React.ReactNode;
};

export function SearchField({ label, icon, id, className, ...rest }: SearchFieldProps) {
  const auto = React.useId();
  const inputId = id ?? auto;
  return (
    <div className={clsx('lit-field-control', className)}>
      <label htmlFor={inputId} className="lt-sr">
        {label}
      </label>
      <div data-part="box">
        {icon ? (
          <span data-part="before" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <input {...rest} id={inputId} type="text" />
      </div>
    </div>
  );
}
