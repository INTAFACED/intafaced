'use client';
/**
 * Small shared pieces for the new CRM screens, built on the kit (`@intafaced/ui`) and Tailwind. Lime is used for the one main
 * action on a screen and for the overdue/now signal, nowhere else.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, cn } from '@intafaced/ui';

/* ------------------------------------------------------------------ chips */

const chipBase =
  'inline-flex min-h-9 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-sm font-medium ' +
  'transition-colors duration-(--if-t-fast) ease-if max-[600px]:min-h-11 ' +
  'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

/** A choice the founder taps instead of typing. `selected` is announced with aria-pressed. */
export function ChoiceChip({ selected, className, ...props }: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        chipBase,
        selected ? 'border-fg bg-raised text-fg' : 'border-line-strong bg-transparent text-fg-2 hover:border-line-stronger hover:text-fg',
        className,
      )}
      {...props}
    />
  );
}

export function ChipRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap gap-2', className)}>
      {children}
    </div>
  );
}

/** A small label above a group of controls. */
export function FieldLabel({ children, className, ...props }: ComponentProps<'p'>) {
  return (
    <p className={cn('mb-1.5 text-xs font-medium tracking-wide text-fg-2 uppercase', className)} {...props}>
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ tags */

/** A neutral tag with a grey dot: stage, audience. Stages never use lime. */
export function Tag({ children, dot, className, title }: { children: ReactNode; dot?: boolean; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 max-w-full items-center gap-1.5 whitespace-nowrap rounded-xs border border-line-strong px-1.5 text-2xs text-fg-2',
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fg-3" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** An owner's initial in a small ring: "N" or "P". The full name is the accessible label. */
export function OwnerInitial({ name }: { name: string }) {
  return (
    <span
      role="img"
      aria-label={`Owner: ${name}`}
      title={name}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-2xs font-medium text-fg"
    >
      {name.charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/* ------------------------------------------------------------------ messages */

const noticeTone = {
  info: 'border-line-strong bg-field text-fg',
  ok: 'border-line-strong bg-field text-fg',
  warn: 'border-warn/50 bg-warn/10 text-fg',
  danger: 'border-down/60 bg-down-bg text-fg',
} as const;

/** A message box: saved, restored, stale, error. Pass `role="alert"` for something that went wrong, `role="status"` for something done. */
export function Notice({
  tone = 'info',
  actions,
  children,
  className,
  ...props
}: { tone?: keyof typeof noticeTone; actions?: ReactNode } & Omit<ComponentProps<'div'>, 'title'>) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-sm border px-3 py-2 text-sm', noticeTone[tone], className)}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** A plain text button for secondary actions inside a notice or a row. */
export function TextButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex min-h-8 items-center rounded-xs px-1 text-sm font-medium text-fg underline decoration-line-stronger underline-offset-4 ' +
          'hover:decoration-fg max-[600px]:min-h-11 disabled:cursor-not-allowed disabled:opacity-40 ' +
          'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime',
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ sheet */

/**
 * A modal sheet: a centred panel at desktop width, a panel rising from the bottom on a phone. The kit's Dialog supplies the
 * focus trap, Escape and the scrim.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[90dvh] overflow-y-auto p-5',
          wide ? 'max-w-2xl' : 'max-w-lg',
          'max-[600px]:top-auto max-[600px]:bottom-0 max-[600px]:left-0 max-[600px]:w-full max-[600px]:max-w-none max-[600px]:translate-x-0 max-[600px]:translate-y-0 max-[600px]:rounded-b-none',
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="flex flex-col gap-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/** A text input in the kit's field style, with the 44 px phone height. */
export function TextField({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full min-w-0 rounded-sm border border-line-strong bg-field px-3 text-base text-fg placeholder:text-fg-3 max-[600px]:h-11',
        'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    />
  );
}
export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-24 w-full min-w-0 rounded-sm border border-line-strong bg-field px-3 py-2 text-base text-fg placeholder:text-fg-3',
        'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime',
        className,
      )}
      {...props}
    />
  );
}
