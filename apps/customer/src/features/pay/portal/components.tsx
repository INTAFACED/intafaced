import type { ReactNode } from 'react';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { Button, EmptyState } from '../../../shared/ui';
import { PayTime } from '../components';
import type { ListState } from './hooks';
import { staleness, lagParts } from './model';
import { portalCopy, type PlainKey } from './copy';
import { isComingSoon, refusalText, refusalTitle } from './refusal';
import type { AssetAmount, Freshness } from './schemas';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** Loading skeleton (B11): the shape of the page that is coming, announced once to assistive tech. */
export function PortalLoading({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="pp-skeleton" role="status" aria-busy="true">
      <span className="pp-sr">{label ?? t('loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="pp-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

/** A procedure that is not built or not mounted yet is not an error: say when it arrives, and show nothing made up. */
export function ComingSoon({ title, children }: { title?: string; children?: ReactNode }) {
  const { t } = portalCopy.useCopy();
  return (
    <section className="pp-soon" aria-label={title ?? t('comingSoonTitle')}>
      <span className="pp-soon-tag">{t('comingSoonTag')}</span>
      <h3>{title ?? t('comingSoonTitle')}</h3>
      <p>{children ?? t('comingSoonBody')}</p>
    </section>
  );
}

export function PortalFailure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { t } = portalCopy.useCopy();
  if (isComingSoon(result)) return <ComingSoon />;
  return (
    <div className="failure" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <h3>{refusalTitle(result)}</h3>
      <p>{refusalText(result)}</p>
      {result.reason === 'unauthorized' ? (
        <a
          className="text-link"
          href={`/login?redirect=${encodeURIComponent(typeof location === 'undefined' ? '/pay/merchant' : location.pathname + location.search)}`}
        >
          {t('signIn')}
        </a>
      ) : (
        retry &&
        result.reason !== 'uncertain' && (
          <Button variant="secondary" onClick={retry}>
            {t('tryAgain')}
          </Button>
        )
      )}
    </div>
  );
}

/** Loading, refused and empty for a paged list; the rows themselves come from `children`. */
export function ListShell<T>({
  state,
  empty,
  retry,
  children,
}: {
  state: ListState<T>;
  empty: { title: string; body: string; action?: ReactNode };
  retry: () => void;
  children: (items: T[]) => ReactNode;
}) {
  if (state.status === 'loading') return <PortalLoading />;
  if (state.status === 'failed') return <PortalFailure result={state.failure} retry={retry} />;
  if (state.items.length === 0)
    return (
      <EmptyState title={empty.title} action={empty.action}>
        {empty.body}
      </EmptyState>
    );
  return <>{children(state.items)}</>;
}

/** Row count and "Load more" (B3). The count says "so far" while another page exists, so it is never read as a total. */
export function MoreFooter<T>({ state, onMore }: { state: Extract<ListState<T>, { status: 'ready' }>; onMore: () => void }) {
  const { t } = portalCopy.useCopy();
  const failed = typeof state.more === 'object';
  return (
    <div className="pp-more">
      <p className="muted" role="status">
        {state.hasMore ? t('rowsSoFar', { count: state.items.length }) : t('rowsAll', { count: state.items.length })}
      </p>
      {state.hasMore && (
        <Button variant="secondary" onClick={onMore} disabled={state.more === 'loading'}>
          {state.more === 'loading' ? t('loadingMore') : failed ? t('tryAgain') : t('loadMore')}
        </Button>
      )}
      {failed && (
        <p className="error-text" role="alert">
          {refusalText(state.more as Failed)}
        </p>
      )}
    </div>
  );
}

export function Kpi({
  label,
  period,
  value,
  note,
  href,
  tone,
}: {
  label: string;
  period?: string;
  value: ReactNode;
  note?: ReactNode;
  href?: string;
  tone?: 'attention';
}) {
  const body = (
    <>
      <span className="pp-kpi-label">
        {label}
        {period && <em>{period}</em>}
      </span>
      <strong className="pp-kpi-value numeric">{value}</strong>
      {note && <small className="pp-kpi-note">{note}</small>}
    </>
  );
  return href ? (
    <a className={`pp-kpi pp-kpi--link${tone ? ` pp-kpi--${tone}` : ''}`} href={href}>
      {body}
    </a>
  ) : (
    <div className={`pp-kpi${tone ? ` pp-kpi--${tone}` : ''}`}>{body}</div>
  );
}
export function KpiGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pp-kpis" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** One line per asset. Two assets are never added together; an empty list is "nothing yet", not zero. */
export function MoneyLines({ items, emptyLabel }: { items: readonly AssetAmount[]; emptyLabel?: string }) {
  const { t } = portalCopy.useCopy();
  if (items.length === 0)
    return (
      <span className="pp-none" title={emptyLabel ?? t('noPaymentsInPeriod')}>
        —
      </span>
    );
  return (
    <span className="pp-lines">
      {items.map((item) => (
        <span key={item.assetCode} className="pp-line">
          {displayAmount(item.amount)}{' '}
          <span className="pp-unit" lang="zxx">
            {item.assetCode}
          </span>
        </span>
      ))}
    </span>
  );
}
export function Money({ value, asset }: { value: string; asset: string }) {
  return (
    <span className="numeric pp-money">
      {displayAmount(value)}{' '}
      <span className="pp-unit" lang="zxx">
        {asset}
      </span>
    </span>
  );
}

/** "As of" and lag on every metric (B12). Unknown freshness is stated, never dressed as live. */
export function AsOf({ freshness }: { freshness: Freshness }) {
  const { t } = portalCopy.useCopy();
  const state = staleness(freshness);
  if (state.kind === 'unknown')
    return (
      <p className="pp-asof pp-asof--warn" role="status">
        {t('asOfUnknown')}
      </p>
    );
  const lag = lagParts(state.lagSeconds);
  const lagText =
    lag.unit === 'seconds'
      ? t('lagSeconds', { n: lag.n })
      : lag.unit === 'minutes'
        ? t('lagMinutes', { n: lag.n })
        : t('lagHours', { n: lag.n });
  return (
    <p className={`pp-asof${state.kind === 'stale' ? ' pp-asof--warn' : ''}`} role="status">
      {t('asOf')} <PayTime value={freshness.asOf!} /> · {lagText}
      {state.kind === 'stale' && <> · {t('staleWarning')}</>}
    </p>
  );
}

const tone = {
  good: 'pp-chip--good',
  attention: 'pp-chip--attention',
  bad: 'pp-chip--bad',
  neutral: '',
} as const;
type Tone = keyof typeof tone;
const chips = {
  dispute: {
    open: ['chipDispute_open', 'tipDispute_open', 'attention'],
    contested: ['chipDispute_contested', 'tipDispute_contested', 'neutral'],
    accepted: ['chipDispute_accepted', 'tipDispute_accepted', 'neutral'],
    won: ['chipDispute_won', 'tipDispute_won', 'good'],
    lost: ['chipDispute_lost', 'tipDispute_lost', 'bad'],
  },
  kyb: {
    none: ['chipKyb_none', 'tipKyb_none', 'neutral'],
    pending: ['chipKyb_pending', 'tipKyb_pending', 'attention'],
    approved: ['chipKyb_approved', 'tipKyb_approved', 'good'],
    rejected: ['chipKyb_rejected', 'tipKyb_rejected', 'bad'],
  },
  export: {
    queued: ['chipExport_queued', 'tipExport_queued', 'neutral'],
    running: ['chipExport_running', 'tipExport_running', 'neutral'],
    ready: ['chipExport_ready', 'tipExport_ready', 'good'],
    failed: ['chipExport_failed', 'tipExport_failed', 'bad'],
  },
  member: {
    active: ['chipMember_active', 'tipMember_active', 'good'],
    invited: ['chipMember_invited', 'tipMember_invited', 'attention'],
    removed: ['chipMember_removed', 'tipMember_removed', 'neutral'],
  },
  payment: {
    created: ['chipPayment_created', 'tipPayment_created', 'neutral'],
    authorized: ['chipPayment_authorized', 'tipPayment_authorized', 'neutral'],
    captured: ['chipPayment_captured', 'tipPayment_captured', 'good'],
    settled: ['chipPayment_settled', 'tipPayment_settled', 'good'],
    refunded: ['chipPayment_refunded', 'tipPayment_refunded', 'neutral'],
    disputed: ['chipPayment_disputed', 'tipPayment_disputed', 'attention'],
    failed: ['chipPayment_failed', 'tipPayment_failed', 'bad'],
  },
  merchant: {
    pending: ['chipMerchant_pending', 'tipMerchant_pending', 'attention'],
    active: ['chipMerchant_active', 'tipMerchant_active', 'good'],
    suspended: ['chipMerchant_suspended', 'tipMerchant_suspended', 'bad'],
    closed: ['chipMerchant_closed', 'tipMerchant_closed', 'neutral'],
  },
} as const satisfies Record<string, Record<string, readonly [PlainKey, PlainKey, Tone]>>;
export type ChipKind = keyof typeof chips;

/** One shared vocabulary per entity (B4): words plus a dot, never colour alone, with a plain-English explanation. */
export function Chip({ kind, value }: { kind: ChipKind; value: string }) {
  const { t } = portalCopy.useCopy();
  const entry = (chips[kind] as Record<string, readonly [PlainKey, PlainKey, Tone]>)[value];
  if (!entry) return <span className="pp-chip">{value}</span>;
  const [label, tip, toneName] = entry;
  return (
    <span className={`pp-chip ${tone[toneName]}`} title={t(tip)}>
      <span className="pp-chip-dot" aria-hidden="true" />
      {t(label)}
      <span className="pp-sr"> ({t(tip)})</span>
    </span>
  );
}

export type TimelineItem = { at: string; title: string; detail?: string };
export function Timeline({ items, label }: { items: readonly TimelineItem[]; label: string }) {
  return (
    <ol className="pp-timeline" aria-label={label}>
      {items.map((item, i) => (
        <li key={`${item.at}:${i}`}>
          <span className="pp-timeline-dot" aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p className="muted">{item.detail}</p>}
            <small className="muted">
              <PayTime value={item.at} />
            </small>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="field pp-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-link pp-back" href={href}>
      ← {children}
    </a>
  );
}

/** A summary line of key facts (B5): label and value pairs, ids copyable by selection. */
export function Facts({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="pp-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Loading and refusal for one read that is not a list. */
export function Gate<T>({
  resource,
  retry,
  rows,
  children,
}: {
  resource: import('../../../shared/resource').Resource<T>;
  retry: () => void;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <PortalLoading rows={rows} />;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={retry} />;
  return <>{children(resource.data)}</>;
}
