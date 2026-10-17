import type { ReactNode } from 'react';

/**
 * The top of a detail page. For money, the title is the amount and the status ("120.00 USDT · Paid"). It carries a
 * way back, one line saying what this is, and at most one primary action.
 */
export function DetailHeader({
  back,
  title,
  status,
  subtitle,
  action,
}: {
  back: { href: string; label: string };
  title: ReactNode;
  status?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="pp-detail-head">
      <a className="text-link" href={back.href}>
        {back.label}
      </a>
      <div className="pp-detail-title">
        <div>
          <h2>
            {title}
            {status && <> {status}</>}
          </h2>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {action}
      </div>
    </header>
  );
}
