import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, Failure } from '../../shared/ui';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyRefusalText } from './academy-flows';
import type { AcademyPath, CertificateState, LessonStatus } from './academy-lms';
import './academy-lms.css';

const pathKeys = {
  foundations: 'pathFoundations',
  markets: 'pathMarkets',
  builder: 'pathBuilder',
  sovereign: 'pathSovereign',
} as const;
const kindKeys = { playbook: 'kindPlaybook', workbook: 'kindWorkbook', lesson: 'kindLesson' } as const;
/** A lesson's kind as a person reads it. A kind this app does not know is shown as sent. */
export const kindLabel = (t: (typeof copy)['t'], kind: string): string =>
  kind in kindKeys ? t(kindKeys[kind as keyof typeof kindKeys]) : kind;
export const pathLabel = (t: (typeof copy)['t'], path: AcademyPath) => t(pathKeys[path]);

/**
 * A bar is only drawn from a real ratio. Callers pass null when nothing is tracked and get text instead.
 * It is a meter (a settled measure of lessons recorded), not a progressbar: a progressbar announces work still in
 * flight, so assistive tech and any "is it still loading" check would read a finished 4-of-7 bar as a read that never ends.
 */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="academy-lms-bar"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${value}%`}
      aria-label={label}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

const statusKeys = { recorded: 'statusRecorded', pending: 'statusPending', open: 'statusOpen' } as const;
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
  issuing: 'stateIssuing',
  revoked: 'stateRevoked',
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

/**
 * A failed Academy request. The service's typed refusals are worded here in plain language; anything else (a dropped
 * connection, a sign-in problem) goes to the shared failure panel, which words those.
 */
export function AcademyRefusal({ failure, retry }: { failure: Extract<ApiResult<never>, { ok: false }>; retry?: () => void }) {
  const { t } = copy.useCopy();
  const words = academyRefusalText(failure, t);
  if (words === null) return <Failure result={failure} retry={retry} />;
  return (
    <div data-testid="failure" className="failure" role="status">
      <p>{words}</p>
    </div>
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
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  reason: ReactNode | null;
  reasonId: string;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <div className="academy-lms-disabled">
      <Button {...props} disabled={reason !== null} aria-describedby={reason !== null ? reasonId : undefined}>
        {children}
      </Button>
      {reason !== null && (
        <small id={reasonId} className="muted">
          {reason}
        </small>
      )}
    </div>
  );
}

/** A control that cannot run, with the reason next to it rather than in a tooltip. */
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
