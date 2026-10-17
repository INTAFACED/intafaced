/**
 * Honest state for a region of a screen: nothing here yet (`empty`), the system said no (`refused`),
 * or a part is switched off or unreachable (`unavailable`). Same visual language as StateBlock.
 *
 * Product law: "parked" means visible with the REAL blocker named. It is never a "coming soon"
 * screen. So `reason` is a required prop for `refused` and `unavailable` (type-checked through a
 * discriminated union), it is rendered as its own line, and this component has no default copy at
 * all: titles, reasons and button labels always come from the caller.
 */
import * as React from 'react';
import { Ban, CloudOff, Inbox } from 'lucide-react';
import { Button } from './button.js';
import { cn } from './cn.js';

export type EmptyStateVariant = 'empty' | 'refused' | 'unavailable';
export type EmptyStateSize = 'inline' | 'panel' | 'page';
export type EmptyStateActionVariant = 'primary' | 'secondary' | 'ghost';

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  /** Renders a link instead of a button. */
  href?: string;
  variant?: EmptyStateActionVariant;
}

type Shared = Omit<React.ComponentProps<'div'>, 'title'> & {
  title: string;
  /** Small support code ("E-4031") so support can ask for it. */
  code?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /** Replaces the default icon of the variant. Decorative: it is hidden from screen readers. */
  icon?: React.ReactNode;
  /** inline = one row for table bodies and small cards, panel (default), page = tall and centred. */
  size?: EmptyStateSize;
};

export type EmptyStateProps = Shared &
  (
    | { variant?: 'empty'; /** One real line about why it is empty (optional). */ reason?: string }
    | { variant: 'refused' | 'unavailable'; /** The real blocker, in one line. Required. */ reason: string }
  );

const defaultIcon: Record<EmptyStateVariant, React.ComponentType<{ size?: number }>> = {
  empty: Inbox,
  refused: Ban,
  unavailable: CloudOff,
};

const iconTone: Record<EmptyStateVariant, string> = {
  empty: 'text-fg-3',
  refused: 'text-warn',
  unavailable: 'text-fg-3',
};

const iconSize: Record<EmptyStateSize, number> = { inline: 16, panel: 20, page: 24 };

const sizeClass: Record<EmptyStateSize, string> = {
  inline: 'flex-row flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 text-left',
  panel: 'flex-col items-center justify-center gap-1 px-4 py-8 text-center',
  page: 'mx-auto min-h-80 max-w-md flex-col items-center justify-center gap-2 px-4 py-24 text-center',
};

/** The lime primary button belongs to a plain empty region only; refused and unavailable get a quieter one. */
export function resolveActionVariant(
  state: EmptyStateVariant,
  requested: EmptyStateActionVariant | undefined,
  fallback: EmptyStateActionVariant,
): EmptyStateActionVariant {
  const v = requested ?? fallback;
  return v === 'primary' && state !== 'empty' ? 'secondary' : v;
}

function ActionButton({ action, variant, size }: { action: EmptyStateAction; variant: EmptyStateActionVariant; size: 32 | 40 }) {
  if (action.href) {
    return (
      <Button variant={variant} size={size} nativeButton={false} render={<a href={action.href} />}>
        {action.label}
      </Button>
    );
  }
  return (
    <Button variant={variant} size={size} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/** Empty, refused or unavailable region. refused and unavailable are `role="status"` and need a `reason`. */
export function EmptyState(props: EmptyStateProps) {
  const { variant = 'empty', size = 'panel', title, reason, code, action, secondaryAction, icon, className, ...rest } = props;
  const state: EmptyStateVariant = variant;
  const inline = size === 'inline';
  const Icon = defaultIcon[state];
  const buttonSize = inline ? 32 : 40;
  const hasReason = typeof reason === 'string' && reason.trim() !== '';
  const hasActions = Boolean(action || secondaryAction);

  return (
    <div
      data-slot="empty-state"
      data-variant={state}
      data-size={size}
      role={state === 'empty' ? undefined : 'status'}
      className={cn('flex', sizeClass[size], className)}
      {...rest}
    >
      <span data-slot="empty-state-icon" aria-hidden="true" className={cn('flex shrink-0', iconTone[state], size === 'page' && 'mb-1')}>
        {icon ?? <Icon size={iconSize[size]} />}
      </span>
      <div className={cn('flex min-w-0 flex-col gap-1', inline ? 'flex-1 basis-48' : 'items-center')}>
        <p data-slot="empty-state-title" className={cn('m-0 font-medium text-fg', inline ? 'text-base' : 'text-md')}>
          {title}
        </p>
        {hasReason ? (
          <p data-slot="empty-state-reason" className={cn('m-0 text-fg-2', inline ? 'text-sm' : 'text-base')}>
            {reason}
          </p>
        ) : null}
        {code ? (
          <p data-slot="empty-state-code" className="m-0 text-2xs text-fg-2">
            {code}
          </p>
        ) : null}
      </div>
      {hasActions ? (
        <div
          data-slot="empty-state-actions"
          className={cn('flex flex-wrap items-center gap-2', inline ? 'ml-auto' : 'mt-3 justify-center')}
        >
          {action ? (
            <ActionButton action={action} variant={resolveActionVariant(state, action.variant, 'primary')} size={buttonSize} />
          ) : null}
          {secondaryAction ? (
            <ActionButton
              action={secondaryAction}
              variant={resolveActionVariant(state, secondaryAction.variant, 'ghost')}
              size={buttonSize}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
