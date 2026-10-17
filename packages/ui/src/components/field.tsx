'use client';

/**
 * Field: label, hint and error text around one form control (usually an Input).
 * Built on Base UI's Field, so the label is tied to the control (for/id), and
 * the hint and error are tied to it through aria-describedby. Base UI only adds
 * aria-describedby and aria-invalid after the page is in the browser; we also
 * write them ourselves, so they are right in server-rendered HTML too.
 * Input reads its density, invalid, required and disabled state from here.
 */
import * as React from 'react';
import { Field as FieldPrimitive } from '@base-ui/react/field';
import { CircleAlert } from 'lucide-react';
import { cn } from './cn.js';
import { DEFAULT_DENSITY, type Density } from './density.js';

/** What a Field tells the control inside it. Null when there is no Field around. */
export interface FieldContextValue {
  density: Density;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
  /** Space-separated ids of the hint and the error text that exist right now. */
  describedBy: string | undefined;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

/** Used by Input. Returns null outside a Field. */
export function useFieldContext(): FieldContextValue | null {
  return React.useContext(FieldContext);
}

export interface FieldProps {
  label?: React.ReactNode;
  /** Help text under the control. */
  hint?: React.ReactNode;
  /** Error text. Setting it marks the control invalid and announces the text. */
  error?: string;
  /** Shows a visible "*" and sets `required` on the control. */
  required?: boolean;
  /** Spoken in place of the "*" for screen readers. Default "required". */
  requiredLabel?: string;
  disabled?: boolean;
  density?: Density;
  /** `vertical` (default): label above. `horizontal`: label on the left, for dense desk forms. */
  orientation?: 'vertical' | 'horizontal';
  /** Top-right of the label row, e.g. a "Max" link button. */
  labelAction?: React.ReactNode;
  className?: string;
  /** Usually one <Input />. */
  children?: React.ReactNode;
}

/** Label, control, hint and error as one unit. `data-density`, `data-invalid` and `data-disabled` are on the root. */
export function Field({
  label,
  hint,
  error,
  required = false,
  requiredLabel = 'required',
  disabled = false,
  density = DEFAULT_DENSITY,
  orientation = 'vertical',
  labelAction,
  className,
  children,
}: FieldProps) {
  const uid = React.useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const hasError = Boolean(error);
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== '';
  const horizontal = orientation === 'horizontal';
  const describedBy = [hasHint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(' ') || undefined;

  const ctx = React.useMemo<FieldContextValue>(
    () => ({ density, invalid: hasError, required, disabled, describedBy }),
    [density, hasError, required, disabled, describedBy],
  );

  const hasLabelRow = label !== undefined && label !== null && label !== false && label !== '';

  return (
    <FieldContext.Provider value={ctx}>
      <FieldPrimitive.Root
        invalid={hasError}
        disabled={disabled}
        data-slot="field"
        data-density={density}
        data-orientation={orientation}
        className={cn(
          horizontal ? 'grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1' : 'flex min-w-0 flex-col gap-1.5',
          className,
        )}
      >
        {hasLabelRow || labelAction ? (
          <div
            data-slot="field-label-row"
            className={cn(
              'flex min-w-0 items-center justify-between gap-2',
              horizontal &&
                cn('flex-col items-start justify-center gap-0.5', density === 'dense' ? 'min-h-(--if-ctl-h-dense)' : 'min-h-(--if-ctl-h)'),
            )}
          >
            {hasLabelRow ? (
              <FieldPrimitive.Label
                data-slot="field-label"
                className={cn('min-w-0 font-medium text-fg-2 data-disabled:opacity-40', density === 'dense' ? 'text-xs' : 'text-sm')}
              >
                {label}
                {required ? (
                  <>
                    <span aria-hidden="true" className="ms-0.5 text-fg-2">
                      *
                    </span>
                    <span className="sr-only"> {requiredLabel}</span>
                  </>
                ) : null}
              </FieldPrimitive.Label>
            ) : null}
            {labelAction ? (
              <span data-slot="field-label-action" className="shrink-0 text-xs">
                {labelAction}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className={cn('min-w-0', horizontal && 'col-start-2')}>{children}</div>
        {hasHint ? (
          <FieldPrimitive.Description id={hintId} data-slot="field-hint" className={cn('text-xs text-fg-2', horizontal && 'col-start-2')}>
            {hint}
          </FieldPrimitive.Description>
        ) : null}
        <FieldPrimitive.Error
          match={hasError}
          id={errorId}
          role="alert"
          data-slot="field-error"
          className={cn('flex items-start gap-1 text-xs text-error-text', horizontal && 'col-start-2')}
        >
          {hasError ? (
            <>
              <CircleAlert aria-hidden="true" size={14} strokeWidth={2} className="mt-px shrink-0" />
              <span>{error}</span>
            </>
          ) : null}
        </FieldPrimitive.Error>
      </FieldPrimitive.Root>
    </FieldContext.Provider>
  );
}
