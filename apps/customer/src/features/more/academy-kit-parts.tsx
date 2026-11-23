import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { safeReturnTo } from '../../app/navigation';
import type { CertificateState, LessonStatus } from './academy-lms';
import { academyLmsCopy as copy } from './academy-lms-copy';

/**
 * The Academy catalogue rooms' small parts drawn with the kit (intafaced issue 9566): the share of a course or path
 * recorded, a lesson's or a certificate's status, a button that says why it is off, and Sign in back to this page. The words and marks are the old parts' (AcademyLmsParts.tsx).
 */

/**
 * A share recorded, drawn only from a real ratio; callers pass null when nothing is tracked and get text instead. It is a
 * meter (a settled measure), not a progress bar: a progress bar announces work still in flight, so assistive tech and any
 * "is it still loading" check would read a finished 4-of-7 bar as a read that never ends. The browser's own meter, since
 * the kit's Meter is a limit's use read out as a progress bar.
 */
export function ProgressMeter({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <meter
      min={0}
      max={100}
      value={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${value}%`}
      aria-label={label}
    />
  );
}

const statusKeys = { recorded: 'statusRecorded', pending: 'statusPending', open: 'statusOpen' } as const;

/** Whether a lesson is recorded, waiting or open, in words with the kit chip's mark. */
export function LessonStatusChip({ status }: { status: LessonStatus }) {
  const { Copy } = copy.useCopy();
  return (
    <span className="lt-chip" data-status={status}>
      <span className="lt-chip-mark" aria-hidden="true" />
      <Copy k={statusKeys[status]} />
    </span>
  );
}

const stateKeys = {
  earned: 'stateEarned',
  ready: 'stateReady',
  issuing: 'stateIssuing',
  revoked: 'stateRevoked',
  'in-progress': 'stateInProgress',
  'not-started': 'stateNotStarted',
} as const;

/** Where a certificate stands (earned, ready, issuing, revoked, in progress, not started), in words with the kit chip's mark. */
export function CertificateChip({ state }: { state: CertificateState }) {
  const { Copy } = copy.useCopy();
  return (
    <span className="lt-chip" data-status={state}>
      <span className="lt-chip-mark" aria-hidden="true" />
      <Copy k={stateKeys[state]} />
    </span>
  );
}

/**
 * A button that states why it is off. The reason sits next to the button, not in a tooltip, and the button points at it,
 * so a screen reader hears it with the button. When the button is on, no reason is shown.
 */
export function GuardedButton({
  reason,
  reasonId,
  children,
  tone = 'primary',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  reason: ReactNode | null;
  reasonId: string;
  tone?: 'primary' | 'secondary';
}) {
  return (
    <div className="lt-actions">
      <Button {...props} tone={tone} disabled={reason !== null} aria-describedby={reason !== null ? reasonId : undefined}>
        {children}
      </Button>
      {reason !== null && (
        <small id={reasonId} className="lt-muted">
          {reason}
        </small>
      )}
    </div>
  );
}

/** Sign in, then come back to the page the visitor is on. */
export function AcademySignIn() {
  const { Copy } = copy.useCopy();
  const here = safeReturnTo(location.pathname + location.search);
  return (
    <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent(here)}`}>
      <Copy k="publicSignIn" />
    </a>
  );
}
