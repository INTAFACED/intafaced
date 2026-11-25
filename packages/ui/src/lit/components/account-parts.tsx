/**
 * Parts of an account page that home and the money screens share: the row of big action keys (Deposit, Withdraw,
 * Convert, Trade), a panel's hairline-divided sections, a progress bar in segments, and one line of activity. No copy
 * here: every word arrives as a prop; amounts arrive formatted, and mask with the person's hide-balances switch.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { useHideBalances } from '../../components/numbers.js';
import { HIDDEN_MASK } from './b2-values.js';

/**
 * A row of equal action keys. From 37.5rem of the row's room they are wide bars (icon beside the word); on a phone
 * they are square icon keys with the word under them.
 */
export function ActionRow({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={clsx('lt-action-row', className)} />;
}

export type ActionButtonProps = {
  icon: React.ReactNode;
  label: string;
  /** The one lit key in the row (Deposit). */
  primary?: boolean;
  /** A link when given; a button otherwise. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  'data-testid'?: string;
};

export function ActionButton({ icon, label, primary, href, onClick, disabled, 'data-testid': testId }: ActionButtonProps) {
  const inner = (
    <>
      <span className="lt-action-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="lt-action-label">{label}</span>
    </>
  );
  const marks = { className: 'lt-action', 'data-primary': primary || undefined, 'data-testid': testId };
  return href && !disabled ? (
    <a {...marks} href={href} onClick={onClick}>
      {inner}
    </a>
  ) : (
    <button {...marks} type="button" onClick={onClick} disabled={disabled}>
      {inner}
    </button>
  );
}

/** A section of a panel, under a hairline: its title and an aside (a pin, a link) on one row, then its body. */
export function PanelSection({
  title,
  aside,
  className,
  children,
  ...rest
}: Omit<React.HTMLAttributes<HTMLElement>, 'title'> & { title?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section {...rest} className={clsx('lt-panel-section', className)}>
      {title !== undefined || aside !== undefined ? (
        <div className="lt-panel-section-head">
          {title !== undefined ? <h3 className="lt-panel-section-title">{title}</h3> : <span />}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Progress in segments (2 of 3 done): `done` lit, the rest dim. `label` says it in words for a screen reader. */
export function ProgressSegments({ total, done, label }: { total: number; done: number; label: string }) {
  return (
    <div className="lt-progress-segments" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} data-done={i < done || undefined} />
      ))}
    </div>
  );
}

export type ActivityRowProps = {
  /** An icon, or the counterparty's initials when there is no icon. */
  icon?: React.ReactNode;
  initials?: string;
  title: React.ReactNode;
  /** When, already formatted ("Today, 09:41"). */
  time: React.ReactNode;
  /** Signed and formatted ("+$40.00", "−$12.50"), or null when unknown. */
  amount: string | null;
  /** In or out: in reads in the up colour; out in the text colour. The sign is always in the text. */
  direction: 'in' | 'out';
  /** Under the amount (its asset, a status word). */
  detail?: React.ReactNode;
  href?: string;
  /** Overrides the hide-balances switch. */
  hidden?: boolean;
};

/** One line of activity: a circle, what happened and when, the signed amount at the end. Rows sit in an `ActivityList`. */
export function ActivityRow({ icon, initials, title, time, amount, direction, detail, href, hidden }: ActivityRowProps) {
  const fromSwitch = useHideBalances();
  const masked = hidden ?? fromSwitch;
  const body = (
    <>
      <span className="lt-activity-face" aria-hidden="true">
        {icon ?? initials}
      </span>
      <span className="lt-activity-what">
        <span className="lt-activity-title">{title}</span>
        <span className="lt-activity-time">{time}</span>
      </span>
      <span className="lt-activity-amount">
        <span className="lt-num" data-direction={direction} data-hidden={masked || undefined} dir="ltr">
          {masked ? HIDDEN_MASK : (amount ?? '—')}
        </span>
        {detail !== undefined ? <span className="lt-activity-detail">{detail}</span> : null}
      </span>
    </>
  );
  return <li className="lt-activity">{href ? <a href={href}>{body}</a> : <div>{body}</div>}</li>;
}

export function ActivityList({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ul className="lt-activity-list" aria-label={label}>
      {children}
    </ul>
  );
}
