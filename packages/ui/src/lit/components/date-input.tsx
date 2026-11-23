/**
 * A day, or a day and a time, written in the person's own language. The browser's own `<input type="date">`
 * writes its digits in the browser's language, whatever the page's `lang` says (an en-US browser shows mm/dd/yyyy on
 * a page in en-GB or German). This keeps that native control, so its keyboard, its picker, its form value
 * (`2026-11-23`), its screen-reader reading and `fill()` in tests all stay, and at rest draws the chosen day over it
 * with `Intl.DateTimeFormat` in the page's language ("23 Nov 2026", "23. Nov. 2026"). While the box has focus the
 * native digits show, so what is typed is never typed blind.
 *
 * The written day is a pseudo-element of an `aria-hidden` mark: it joins neither the control's accessible name nor a
 * wrapping label's text, so the field is still found and read by its label alone.
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type DateInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** A day (`2026-11-23`) or a day and a time (`2026-11-23T14:05`). */
  type?: 'date' | 'datetime-local';
  /** The language the day is written in. Unset: the page's own (`<html lang>`), which follows the person's choice. */
  locale?: string;
  ref?: React.Ref<HTMLInputElement>;
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

const dayOptions = (type: 'date' | 'datetime-local'): Intl.DateTimeFormatOptions =>
  type === 'date' ? { day: 'numeric', month: 'short', year: 'numeric' } : { dateStyle: 'medium', timeStyle: 'short' };

function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale || undefined, { ...options, timeZone: 'UTC' });
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
  }
}

/**
 * The native control's value written in `locale`: the month by its name, so no order of digits can be misread. The
 * value is a wall-clock day and time with no zone, so it is read and written as UTC and never shifts a day. Empty or
 * not a valid value: ''.
 */
export function formatDateValue(value: string, type: 'date' | 'datetime-local', locale?: string): string {
  const parts = type === 'date' ? DAY.exec(value) : DAY_TIME.exec(value);
  if (!parts) return '';
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts.slice(1).map((part) => parseInt(part ?? '0', 10));
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return '';
  return formatter(locale, dayOptions(type)).format(at);
}

/**
 * What an empty box shows: the names of its parts in the same order and form a chosen day is written in ("day mo yr" in
 * en-GB, "mo day, yr" in en), never the browser's own digits.
 */
export function emptyDateValue(type: 'date' | 'datetime-local', locale?: string): string {
  try {
    const names = new Intl.DisplayNames(locale || undefined, { type: 'dateTimeField', style: 'narrow' });
    let last = '';
    let out = '';
    for (const part of formatter(locale, dayOptions(type)).formatToParts(new Date(Date.UTC(2026, 10, 23, 14, 5)))) {
      if (part.type === 'dayPeriod') continue;
      // A language that writes a part's name as its mark (ja: 2026年) gets the name once, not twice.
      const words = part.type === 'literal' ? (part.value.trim() === last ? '' : part.value) : (names.of(part.type) ?? '');
      if (part.type !== 'literal') last = words;
      out += words;
    }
    return out.trim();
  } catch {
    return '';
  }
}

function pageLocale(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.documentElement.lang || undefined;
}

/** Sets the written day in the box's own inset and font, so it sits exactly where the native digits would. */
function matchBox(shown: HTMLSpanElement | null) {
  const input = shown?.previousElementSibling;
  if (!shown || !(input instanceof HTMLInputElement) || typeof getComputedStyle !== 'function') return;
  const box = getComputedStyle(input);
  shown.style.insetInlineStart = `calc(${box.paddingInlineStart || '0px'} + ${box.borderInlineStartWidth || '0px'})`;
  if (box.font) shown.style.font = box.font;
}

/** A native day (or day-and-time) box that shows its day in the person's language. Use it in place of `<input type="date">`. */
export function DateInput({ type = 'date', locale, className, value, defaultValue, onChange, ref, ...rest }: DateInputProps) {
  const [own, setOwn] = React.useState(() => String(defaultValue ?? ''));
  const current = value === undefined ? own : String(value);
  const language = locale ?? pageLocale();
  const shown = formatDateValue(current, type, language);
  const placeholder = shown ? '' : emptyDateValue(type, language);
  return (
    <span className={clsx('lit-date', className)} data-empty={shown ? undefined : ''}>
      <input
        {...rest}
        ref={ref}
        type={type}
        value={value}
        defaultValue={defaultValue}
        onChange={(event) => {
          if (value === undefined) setOwn(event.target.value);
          onChange?.(event);
        }}
      />
      <span ref={matchBox} data-part="shown" aria-hidden="true" data-shown={shown || placeholder} />
    </span>
  );
}

const isDayType = (type: string | undefined): type is 'date' | 'datetime-local' => type === 'date' || type === 'datetime-local';

/**
 * The one box a field draws: a `DateInput` for a day or a day and a time, the plain native box for anything else. Every
 * field (the kit's `Field` and `TextField`, and the app's own field wrappers) draws through this, so no field writes a
 * day in the browser's language.
 */
export function DateOrInput({ ref, type, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  if (isDayType(type)) return <DateInput {...props} type={type} ref={ref} />;
  return <input {...props} type={type} ref={ref} />;
}
