import type { ReactNode } from 'react';
import { Button } from '../../shared/ui';
import { academyLmsCopy as copy } from './academy-lms-copy';
import type { AcademyPath, CertificateState, LessonStatus } from './academy-lms';
import './academy-lms.css';

const pathKeys = {
  foundations: 'pathFoundations',
  markets: 'pathMarkets',
  builder: 'pathBuilder',
  sovereign: 'pathSovereign',
} as const;
export const pathLabel = (t: (typeof copy)['t'], path: AcademyPath) => t(pathKeys[path]);

/**
 * A bar is only drawn from a real ratio. Callers pass null when nothing is tracked and get text instead.
 * It is a meter (a settled measure of lessons recorded), not a progressbar: a progressbar announces work still in
 * flight, so assistive tech and any "is it still loading" check would read a finished 4-of-7 bar as a read that never ends.
 */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="academy-lms-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

const statusKeys = { recorded: 'statusRecorded', pending: 'statusPending', untracked: 'statusUntracked' } as const;
export function StatusChip({ status }: { status: LessonStatus }) {
  const { Copy } = copy.useCopy();
  return (
    <span className="academy-lms-chip" data-status={status}>
      <Copy k={statusKeys[status]} />
    </span>
  );
}

const stateKeys = {
  earned: 'stateEarned',
  ready: 'stateReady',
  'in-progress': 'stateInProgress',
  'not-started': 'stateNotStarted',
} as const;
export function CertificateChip({ state }: { state: CertificateState }) {
  const { Copy } = copy.useCopy();
  return (
    <span className="academy-lms-chip" data-status={state}>
      <Copy k={stateKeys[state]} />
    </span>
  );
}

/** A control that cannot run today, with the reason next to it rather than in a tooltip. */
export function DisabledWithReason({ label, reason, id }: { label: ReactNode; reason: ReactNode; id: string }) {
  return (
    <div className="academy-lms-disabled">
      <Button variant="secondary" disabled aria-describedby={id}>
        {label}
      </Button>
      <small id={id} className="muted">
        {reason}
      </small>
    </div>
  );
}
