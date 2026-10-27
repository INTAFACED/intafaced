import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import type { ApiResult } from '../../../shared/api';
import { MoneyDisplay } from './presentation';
import { Button, StateBlock, StatusTag } from '@intafaced/ui';
import { EmptyState } from '../ui-kit';
import { DateTime } from './ui/DateTime';
import type { ListState } from './hooks';
import { activeHalts, spanParts, staleness, lagParts, type PayoutState } from './model';
import { portalCopy } from './copy';
import { StatusChip } from './ui/StatusChip';
import { CopyReference } from './ui/CopyReference';
import { uiCopy } from './ui/copy';
import type { ChipKind } from './ui/status-vocabulary';
import { NotLiveCard } from './chrome/NotLiveCard';
import { isNotLive, notLiveReason, refusalText, refusalTitle } from './refusal';
import type { AssetAmount, Freshness, HaltScope, HaltStatus } from './schemas';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** One page says each refusal once: the first failure to draw a given title and text keeps it, the rest draw nothing. */
type Once = { claim: (key: string, owner: string) => boolean; release: (key: string, owner: string) => void };
const RefusalOnce = createContext<Once | null>(null);
export function RefusalOnceProvider({ children }: { children: ReactNode }) {
  const owners = useRef(new Map<string, string>());
  const store = useRef<Once>({
    claim: (key, owner) => {
      const held = owners.current.get(key);
      if (held === undefined) owners.current.set(key, owner);
      return held === undefined || held === owner;
    },
    release: (key, owner) => {
      if (owners.current.get(key) === owner) owners.current.delete(key);
    },
  });
  return <RefusalOnce.Provider value={store.current}>{children}</RefusalOnce.Provider>;
}

/** Loading skeleton (B11): the shape of the page that is coming, announced once to assistive tech. */
export function PortalLoading({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = portalCopy.useCopy();
  return <StateBlock kind="loading" rows={rows} label={label ?? t('loading')} />;
}

/** A feature that is not live yet. One calm card; see NotLiveCard. */
export const NotLive = NotLiveCard;

/**
 * A refusal in plain words. When the service has not switched the feature on, it is a card naming the blocker instead:
 * pass `notLive` to word it for the page, or the code's own reason (or a general one) is used.
 */
export function PortalFailure({ result, retry, notLive }: { result: Failed; retry?: () => void; notLive?: string }) {
  const { t } = portalCopy.useCopy();
  const { t: u } = uiCopy.useCopy();
  const once = useContext(RefusalOnce);
  const id = useId();
  const key = `${refusalTitle(result)}|${refusalText(result)}`;
  useEffect(() => () => once?.release(key, id), [once, key, id]);
  if (isNotLive(result)) return <NotLive reason={notLive ?? notLiveReason(result)} />;
  // The same refusal, twice on one page, is said once.
  if (once && !once.claim(key, id)) return null;
  return (
    <div data-testid="failure" className="failure" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <h3>{refusalTitle(result)}</h3>
      <p>{refusalText(result)}</p>
      {result.requestId && (
        <p className="muted">
          {u('reference')} <CopyReference value={result.requestId} what={u('reference')} />
        </p>
      )}
      {result.reason === 'unauthorized' ? (
        <a
          className="text-link"
          href={`/login?redirect=${encodeURIComponent(typeof location === 'undefined' ? '/pay/merchant' : location.pathname + location.search)}`}
        >
          {t('signIn')}
        </a>
      ) : (
        // Asking again never turns a "you may not" into a "yes", so a refusal for permission has no Try again.
        retry &&
        result.reason !== 'uncertain' &&
        result.reason !== 'forbidden' && (
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
          <MoneyDisplay value={item.amount} asset={item.assetCode} unit={item.assetCode} />
        </span>
      ))}
    </span>
  );
}
export function Money({ value, asset }: { value: string; asset: string }) {
  return (
    <span className="numeric pp-money">
      <MoneyDisplay value={value} asset={asset} unit={asset} />
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
      {t('asOf')} <DateTime value={freshness.asOf!} /> · {lagText}
      {state.kind === 'stale' && <> · {t('staleWarning')}</>}
    </p>
  );
}

/** One shared vocabulary per entity (B4): the words come from `ui/StatusChip`. Kept under this name for existing pages. */
export function Chip({ kind, value }: { kind: ChipKind; value: string }) {
  return <StatusChip entity={kind} value={value} />;
}

export { Timeline, type TimelineEvent as TimelineItem } from './ui/Timeline';

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
    <dl data-testid="pp-facts" className="pp-facts">
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

// ---- W3b -------------------------------------------------------------------------------------------------

/** "As of" for a list the page read straight from the account's records (B12): there is no projection, so no lag. */
export function ReadAt({ at }: { at: string | null }) {
  const { t } = portalCopy.useCopy();
  if (!at) return null;
  return (
    <p className="pp-asof" role="status">
      {t('readAt')} <DateTime value={at} />
    </p>
  );
}

/** A figure or setting nobody has configured. It is never a zero and never a default. */
export function NotConfigured({ children }: { children?: ReactNode }) {
  const { t } = portalCopy.useCopy();
  return <span className="pp-notconf">{children ?? t('notConfigured')}</span>;
}
export function TestTag() {
  const { t } = portalCopy.useCopy();
  return (
    <span className="pp-test" title={t('testValueTip')}>
      {t('testValue')}
    </span>
  );
}

/** A length of time in words ("3 h", "just now"). Used for the age and the time left on a request. */
export function SpanText({ ms }: { ms: number }) {
  const { t } = portalCopy.useCopy();
  const span = spanParts(ms);
  if (span.unit === 'minutes' && span.n === 0) return <>{t('spanNow')}</>;
  return (
    <>
      {span.unit === 'minutes'
        ? t('spanMinutes', { n: span.n })
        : span.unit === 'hours'
          ? t('spanHours', { n: span.n })
          : t('spanDays', { n: span.n })}
    </>
  );
}

/** Operation pauses (B11): which operation is paused and since when. An unreadable pause store counts as paused. */
export function HaltBanner({
  resource,
  scopes,
}: {
  resource: import('../../../shared/resource').Resource<HaltStatus>;
  scopes: readonly HaltScope[];
}) {
  const { t } = portalCopy.useCopy();
  if (resource.status === 'loading') return null;
  // A refused or failed read (a team member's read is refused too) is not "nothing is paused": say we could not check.
  if (resource.status === 'failed')
    return (
      <p className="pp-callout pp-callout--warn" role="alert">
        {t('haltCheckFailed', { ops: scopes.map((s) => t(`haltOpName_${s}` as 'haltOpName_intake')).join(t('haltOr')) })}
      </p>
    );
  const { unreadable, halts } = activeHalts(resource.data, scopes);
  if (unreadable)
    return (
      <p className="pp-callout pp-callout--warn" role="alert">
        {t('haltUnreadable')}
      </p>
    );
  if (halts.length === 0) return null;
  return (
    <div className="pp-callout pp-callout--warn" role="alert">
      {halts.map((h) => {
        const where =
          h.level === 'merchant' ? t('haltYours') : h.level === 'rail' ? t('haltRail', { rail: h.railId ?? '' }) : t('haltGlobal');
        return (
          <p key={`${h.scope}:${h.level}:${h.railId ?? ''}`}>
            <strong>{t(`haltOp_${h.scope}` as 'haltOp_intake')}</strong> {where}{' '}
            {h.changedAt ? (
              <>
                {t('haltSince')} <DateTime value={h.changedAt} />.{' '}
              </>
            ) : null}
            {t('haltEffect')}
          </p>
        );
      })}
    </div>
  );
}

/** Ordered steps with no clock where the service keeps none: it says so once instead of inventing times. */
export function Steps({
  items,
  label,
}: {
  items: ReadonlyArray<{ title: string; detail?: string; state: 'done' | 'current' | 'todo' | 'bad' }>;
  label: string;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <ol className="pp-timeline pp-steps-list" aria-label={label}>
      {items.map((item, i) => (
        <li key={i} className={`pp-stepitem pp-stepitem--${item.state}`}>
          <span className="pp-timeline-dot" aria-hidden="true" />
          <div>
            <strong>
              {item.title}
              <span className="pp-sr"> ({t(`stepItem_${item.state}` as 'stepItem_done')})</span>
            </strong>
            {item.detail && <p className="muted">{item.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A used-against-limit bar. The numbers beside it are exact; the bar is only a picture of them. */
export function UsageBar({ pct, label }: { pct: number; label: string }) {
  const { t } = portalCopy.useCopy();
  const full = pct >= 100;
  return (
    <div className="pp-usage" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span className={`pp-usage-fill${full ? ' pp-usage-fill--full' : ''}`} style={{ width: `${pct}%` }} />
      <span className="pp-sr">{full ? t('usageFull') : t('usagePct', { pct: Math.round(pct) })}</span>
    </div>
  );
}
export type { PayoutState };
