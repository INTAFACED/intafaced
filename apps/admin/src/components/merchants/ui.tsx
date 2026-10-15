import type { ReactNode } from 'react';
import { Chip } from '@/components/chip';
import type { ChipSpec } from '@/lib/merchants/chips';
import { formatAmount, formatMoney, type AssetAmount } from '@/lib/merchants/money';
import type { PayFailure } from '@/lib/merchants/pay-call';
import { explainRefusal } from '@/lib/merchants/registry-model';
import { describeFreshness, type Freshness } from '@/lib/merchants/time';
import './merchants.css';

/** Shared, server-renderable pieces of the Merchants panel. */

export function PageHead({
  title,
  purpose,
  back,
  actions,
  badge,
}: {
  title: string;
  purpose: string;
  back?: { href: string; label: string };
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="mp-head">
      <div className="mp-head__text">
        {back ? (
          <a className="mp-back" href={back.href}>
            <span aria-hidden="true">←</span> {back.label}
          </a>
        ) : null}
        <h1>
          {title} {badge}
        </h1>
        <p>{purpose}</p>
      </div>
      {actions ? <div className="mp-head__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  sub,
  actions,
  children,
  flush = false,
  id,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className="mp-card" aria-labelledby={headingId} id={id}>
      <div className="mp-card__head">
        <div>
          <h2 id={headingId}>{title}</h2>
          {sub ? <p>{sub}</p> : null}
        </div>
        {actions ? <div className="mp-card__actions">{actions}</div> : null}
      </div>
      <div className={flush ? 'mp-card__body mp-card__body--flush' : 'mp-card__body'}>{children}</div>
    </section>
  );
}

export function StatusChip({ spec }: { spec: ChipSpec }) {
  return (
    <Chip tone={spec.tone} title={spec.hint}>
      {spec.label}
    </Chip>
  );
}

export function KpiTile({
  label,
  value,
  period,
  note,
  href,
}: {
  label: string;
  value: ReactNode;
  period: string;
  note?: string;
  href?: string;
}) {
  const inner = (
    <>
      <span className="mp-kpi__label">{label}</span>
      <span className="mp-kpi__value">{value}</span>
      <span className="mp-kpi__period">{period}</span>
      {note ? <span className="mp-kpi__note">{note}</span> : null}
    </>
  );
  return href ? (
    <a className="mp-kpi mp-kpi--link" href={href}>
      {inner}
    </a>
  ) : (
    <div className="mp-kpi">{inner}</div>
  );
}

/** Per-asset amounts, one line each. Two assets are never added together. An empty list is "none", not zero. */
export function Amounts({ rows, empty = 'None', inline = false }: { rows: readonly AssetAmount[]; empty?: string; inline?: boolean }) {
  if (rows.length === 0) return <span className="mp-muted">{empty}</span>;
  return (
    <span className="mp-amounts" data-inline={inline ? 'true' : undefined}>
      {rows.map((row) => (
        <span key={row.assetCode} className="mp-amount">
          <span className="mp-num">{formatAmount(row.amount)}</span> <span className="mp-asset">{row.assetCode}</span>
        </span>
      ))}
    </span>
  );
}

export function MoneyText({ amount, assetCode }: { amount: string; assetCode: string }) {
  return <span className="mp-num">{formatMoney(amount, assetCode)}</span>;
}

/** "As of" and lag, with a stale banner when the data is old or its age is unknown (spec B11, B12). */
export function AsOf({ freshness, label = 'Data' }: { freshness: Freshness; label?: string }) {
  const view = describeFreshness(freshness);
  return (
    <div className="mp-asof" data-state={view.state} role="status">
      <span className="mp-asof__dot" aria-hidden="true" />
      <span>
        <strong>
          {label} as of {view.asOf}
        </strong>{' '}
        · {view.lag}
        {view.state === 'stale' ? ' · stale: older than 5 minutes' : ''}
        {view.state === 'unknown' ? ' · freshness not measured, so not shown as live' : ''}
      </span>
    </div>
  );
}

export type StateKind = 'empty' | 'error' | 'not_built' | 'forbidden' | 'info';

export function StateBlock({
  kind,
  title,
  children,
  action,
  requestId,
}: {
  kind: StateKind;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  requestId?: string | null;
}) {
  return (
    <div className="mp-state" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <p>{children}</p>
      {requestId ? <p className="mp-state__ref">Request reference: {requestId}</p> : null}
      {action ? <div className="mp-state__action">{action}</div> : null}
    </div>
  );
}

/** What a failed read looks like, in plain English. `what` completes "…could not be loaded". */
export function FailureState({ failure, what, retryHref }: { failure: PayFailure; what: string; retryHref?: string }) {
  const retry = retryHref ? (
    <a className="mp-btn" href={retryHref}>
      Try again
    </a>
  ) : undefined;
  switch (failure.kind) {
    case 'not_built':
      return (
        <StateBlock kind="not_built" title="Not built yet" requestId={failure.requestId}>
          {what} needs a service procedure that is not switched on yet (<code>{failure.procedure}</code>). Nothing is shown rather than a
          made-up number. It will fill in by itself once the procedure is on.
        </StateBlock>
      );
    case 'forbidden':
      return (
        <StateBlock kind="forbidden" title="Not available to this sign-in" requestId={failure.requestId} action={retry}>
          The service did not accept your founder session for {what}. Sign out and in again; if it persists, another founder must check your
          access.
        </StateBlock>
      );
    case 'not_found':
      return (
        <StateBlock kind="empty" title="Nothing found" requestId={failure.requestId}>
          There is nothing here for {what}.
        </StateBlock>
      );
    case 'refused': {
      const plain = explainRefusal(failure.refusal.code, failure.refusal.message, failure.refusal.status);
      return (
        <StateBlock kind="error" title={plain.title} requestId={failure.requestId} action={retry}>
          {plain.body} {plain.next}
        </StateBlock>
      );
    }
    case 'invalid':
      return (
        <StateBlock kind="error" title={`${what} could not be read`} requestId={failure.requestId} action={retry}>
          The service answered in a shape this console does not understand, so nothing is shown. Nothing was changed.
        </StateBlock>
      );
    default:
      return (
        <StateBlock kind="error" title={`${what} could not be loaded`} requestId={failure.requestId} action={retry}>
          The service did not answer in time. This is an error, not an empty list. Nothing was changed.
        </StateBlock>
      );
  }
}

/** Skeleton block for loading states. Announced once, not per row. */
export function Skeleton({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="mp-skel" role="status" aria-busy="true" aria-live="polite">
      <span className="mp-visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="mp-skel__bar" aria-hidden="true" />
      ))}
    </div>
  );
}

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
