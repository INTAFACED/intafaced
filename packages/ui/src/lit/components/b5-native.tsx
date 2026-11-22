/**
 * Three native controls a room needs where the browser's own behaviour is the point: a select (a real `<select>`, so
 * its options stay native and a test's `selectOption` keeps working), a text area and a checkbox with its label. Each
 * passes every native attribute through to its element (`id`, `name`, `aria-*`, `data-*`, `value`/`onChange`,
 * `disabled`, `required`) and is drawn like `Field`'s control, from lit roles only, through `components.css`. Every
 * word arrives as a child or a prop. Names and meanings are in `../contracts.ts`.
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * A native `<select>` drawn like `Field`'s control. It has no label of its own: the room names it with a wrapping
 * `<label>`, `aria-labelledby` or `aria-label`, and its `<option>`s are the children.
 */
export function NativeSelect({ className, ...rest }: NativeSelectProps) {
  return <select {...rest} className={clsx('lit-native-select', className)} />;
}

export type NativeTextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** A native `<textarea>` drawn like `Field`'s control. Named by the room, as `NativeSelect` is. */
export function NativeTextArea({ className, ...rest }: NativeTextAreaProps) {
  return <textarea {...rest} className={clsx('lit-textarea', className)} />;
}

/** `data-*` attributes for the label row (a test id, a row key). */
type DataAttributes = { [key: `data-${string}`]: string | undefined };

export type CheckRowProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** The words after the box; the whole row is its label, so a press on the words ticks it. */
  label: React.ReactNode;
  /** Attributes for the label row itself (`data-testid`, `data-*`, `lang`); every other prop lands on the input. */
  labelProps?: React.LabelHTMLAttributes<HTMLLabelElement> & DataAttributes;
};

/** A native checkbox and its words, one row, the browser's own box in the kit's accent. */
export function CheckRow({ label, labelProps, className, ...rest }: CheckRowProps) {
  return (
    <label {...labelProps} className={clsx('lit-check', labelProps?.className)}>
      <input {...rest} type="checkbox" className={className} />
      {label}
    </label>
  );
}
