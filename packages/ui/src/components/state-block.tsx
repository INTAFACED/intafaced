'use client';

import * as React from 'react';
import { Button } from './button.js';
import { Skeleton } from './skeleton.js';
import { cn } from './cn.js';

export interface StateAction {
  label: string;
  onClick?: () => void;
  /** Renders a link instead of a button. */
  href?: string;
}

export type StateBlockProps = {
  className?: string;
  /** A test hook for the room that places this block (data-testid). */
  testId?: string;
} & (
  | {
      /** Skeleton rows of the exact final size; no layout shift when data arrives. */
      kind: 'loading';
      rows?: number;
      rowHeight?: number;
      /** Hide the screen-reader announcement when a parent already announces. */
      label?: string;
    }
  | {
      /** One line and at most one button, inside the panel. */
      kind: 'empty';
      title: React.ReactNode;
      body?: React.ReactNode;
      action?: StateAction;
    }
  | {
      /** Network, 5xx or 502: inside the failing panel only. */
      kind: 'error';
      /** "Couldn't load {thing}." unless `title` is given. */
      thing?: string;
      title?: string;
      onRetry: () => void;
      retryLabel?: string;
    }
  | {
      /** Typed 4xx refusal; copy comes from the app's refusalCopy(code). */
      kind: 'refused';
      title: string;
      body: React.ReactNode;
      /** Shown in `text-2xs fg-3` so support can ask for it. */
      code?: string;
      action?: StateAction;
    }
);

function ActionButton({ action, variant }: { action: StateAction; variant: 'primary' | 'secondary' }) {
  if (action.href) {
    return (
      <Button variant={variant} size={40} nativeButton={false} role="link" render={<a href={action.href} />}>
        {action.label}
      </Button>
    );
  }
  return (
    <Button variant={variant} size={40} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/** The four standard states of UI-SPEC 4.3. Copy always arrives as props. */
export function StateBlock(props: StateBlockProps) {
  if (props.kind === 'loading') {
    const rows = props.rows ?? 3;
    return (
      <div
        data-slot="state-block"
        data-testid={props.testId}
        data-kind="loading"
        role="status"
        aria-busy="true"
        aria-label={props.label}
        className={cn('flex flex-col gap-2', props.className)}
      >
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} height={props.rowHeight ?? 48} className="w-full" />
        ))}
      </div>
    );
  }

  const base = 'flex flex-col items-center justify-center gap-1 px-4 py-8 text-center';
  if (props.kind === 'empty') {
    return (
      <div data-slot="state-block" data-testid={props.testId} data-kind="empty" className={cn(base, props.className)}>
        <h3 className="text-md font-medium text-fg">{props.title}</h3>
        {props.body ? <p className="text-base text-fg-2">{props.body}</p> : null}
        {props.action ? (
          <div className="mt-3">
            <ActionButton action={props.action} variant="primary" />
          </div>
        ) : null}
      </div>
    );
  }
  if (props.kind === 'error') {
    const title = props.title ?? `Couldn't load ${props.thing ?? 'this'}.`;
    return (
      <div data-slot="state-block" data-testid={props.testId} data-kind="error" role="alert" className={cn(base, props.className)}>
        <p className="text-md font-medium text-fg">{title}</p>
        <div className="mt-3">
          <Button variant="secondary" size={40} onClick={props.onRetry}>
            {props.retryLabel ?? 'Try again'}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div data-slot="state-block" data-testid={props.testId} data-kind="refused" className={cn(base, props.className)}>
      <p className="text-md font-medium text-fg">{props.title}</p>
      <p className="text-base text-fg-2">{props.body}</p>
      {props.action ? (
        <div className="mt-3">
          <ActionButton action={props.action} variant="secondary" />
        </div>
      ) : null}
      {props.code ? <p className="mt-2 text-2xs text-fg-3">{props.code}</p> : null}
    </div>
  );
}
