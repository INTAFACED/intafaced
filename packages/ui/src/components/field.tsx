import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn, focusRing } from './cn.js';

/** Labelled text field. Keeps browser validation and links helper/error copy to the input. */
export function Field({
  label,
  hint,
  error,
  className,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}) {
  const generatedId = useId();
  const id = input.id ?? `${input.name ?? 'field'}-${generatedId}`;
  const describedBy = [input['aria-describedby'], hint || error ? `${id}-help` : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <label data-slot="field" className={cn('flex min-w-0 flex-col gap-2 text-sm text-fg-2', className)} htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <input
        {...input}
        id={id}
        aria-labelledby={input['aria-label'] ? undefined : `${id}-label`}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={cn(
          'h-10 w-full min-w-0 rounded-sm border border-transparent bg-field px-3 text-base text-fg placeholder:text-fg-2 disabled:opacity-40 aria-invalid:border-down-text',
          focusRing,
        )}
      />
      {(hint || error) && (
        <small id={`${id}-help`} className={error ? 'text-down-text' : 'text-fg-2'}>
          {error ?? hint}
        </small>
      )}
    </label>
  );
}
