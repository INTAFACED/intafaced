import type { ReactNode } from 'react';
import { Button } from '../../shared/ui';
import './academy-lms.css';

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

/** A control that cannot run, with the reason next to it rather than in a tooltip. */
export function DisabledWithReason({ label, reason, id }: { label: ReactNode; reason: ReactNode; id: string }) {
  return (
    <div className="academy-lms-disabled">
      <Button variant="secondary" disabled aria-describedby={id}>
        {label}
      </Button>
      <small id={id} className="lt-muted">
        {reason}
      </small>
    </div>
  );
}
