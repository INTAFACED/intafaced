/**
 * StatusNote: a few words in the flow of a room about where something stands, that is not a refusal and not a toast:
 * a send still confirming, a payment held for review, a link that filled the form in, a line that could not load with
 * its Try again. `neutral` and `warn` are a polite status; `error` is an alert, said at once. Its actions are the
 * caller's own buttons or links. Refused or parked work uses RefusalBox instead. Words arrive as props.
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type StatusNoteProps = {
  /** neutral: where something stands. warn: it needs a look. error: it failed, and is said at once. */
  tone?: 'neutral' | 'warn' | 'error';
  /** A short first line, in bold. */
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Its next steps, the caller's own buttons or links, after the words. */
  actions?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
};

export function StatusNote({ tone = 'neutral', title, children, actions, className, 'data-testid': testId }: StatusNoteProps) {
  return (
    <div className={clsx('lit-note', className)} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}>
      {title ? <p data-part="title">{title}</p> : null}
      {children ? <div data-part="body">{children}</div> : null}
      {actions ? <div data-part="actions">{actions}</div> : null}
    </div>
  );
}
