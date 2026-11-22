/**
 * The merchant portal's shared parts for a page on its Volt template, drawn only from the kit (`@intafaced/ui/lit`, its
 * templates and their `lt-` classes). Each keeps the words, roles, names and test ids of the part it stands in for in
 * `../components.tsx` and `../ui/`, so a page moves onto the kit without a test or a journey noticing; the logic (what a
 * refusal says, how old figures are) stays where it was and is only called from here.
 */
import { useState, type ReactNode } from 'react';
import type { ApiResult } from '../../../../shared/api';
import type { Resource } from '../../../../shared/resource';
import { Button, Select } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { useSaidOnce } from '../components';
import { portalCopy } from '../copy';
import { chromeCopy } from '../chrome/copy';
import type { AllowlistCode } from '../chrome/NotLiveCard';
import { useNow, type ListState } from '../hooks';
import { isNotLive, notLiveReason, refusalText, refusalTitle } from '../refusal';
import { uiCopy } from '../ui/copy';
import { DateTime, formatDateTime } from '../ui/DateTime';
import { ageSeconds } from '../ui/Freshness';
import type { KpiTileProps } from '../ui/Kpi';
import type { ChipKind } from '../ui/status-vocabulary';
import { statusWords, type StatusEntity, type StatusTone } from '../ui/StatusChip';
import { STALE_AFTER_SECONDS } from '../model';
import type { TimelineEvent } from '../ui/Timeline';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** One part of a page: its heading, a line on what it is for, its one action and its rows. */
export function Section({
  title,
  titleLanguage,
  description,
  action,
  id,
  children,
}: {
  title: string;
  titleLanguage?: string;
  description?: string;
  action?: ReactNode;
  /** Where the page's section index links to. */
  id?: string;
  children: ReactNode;
}) {
  return (
    <section data-testid="pay-section" id={id}>
      <h2 lang={titleLanguage}>{title}</h2>
      {description && <p className="lt-hint">{description}</p>}
      {action ? <div className="lt-actions">{action}</div> : null}
      {children}
    </section>
  );
}

/** The shape of what is coming, announced once to assistive tech. */
export function Loading({ rows = 3, label }: { rows?: number; label?: string }) {
  const { t } = portalCopy.useCopy();
  return (
    <div data-slot="state-block" data-kind="loading" role="status" aria-busy="true" aria-label={label ?? t('loading')}>
      <Skeleton shape="rows" count={rows} />
    </div>
  );
}

/** Nothing here yet, said honestly, with what to do about it. */
export function Empty({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div data-slot="state-block" data-kind="empty" className="lt-empty">
      <h3 className="lt-empty-title">{title}</h3>
      {children ? <p className="lt-empty-body">{children}</p> : null}
      {action ? <div className="lt-actions">{action}</div> : null}
    </div>
  );
}

/** A feature that is not live yet: one calm card that names what it waits for (see `../chrome/NotLiveCard`). */
export function NotLive({
  reason,
  title,
  needs,
  code,
  children,
}: {
  reason: string;
  title?: string;
  needs?: string;
  code?: AllowlistCode;
  children?: ReactNode;
}) {
  chromeCopy.useCopy();
  return (
    <section data-testid="pfo-soon" className="lt-held" aria-label={title ?? reason} data-needs={needs} data-code={code}>
      <p>{reason}</p>
      {code && (
        <p className="lt-ref">
          <code>{code}</code>
        </p>
      )}
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
    </section>
  );
}

/** An id the merchant may need to quote. Copying says it worked, or says it didn't, to everyone including screen readers. */
export function CopyReference({ value, what }: { value: string; what?: string }) {
  const { t } = uiCopy.useCopy();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className="lt-actions">
      <code className="lt-mono">{value}</code>
      <Button
        tone="quiet"
        aria-label={what ? t('copyLabel', { what }) : undefined}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      >
        {t('copy')}
      </Button>
      <span role={state === 'failed' ? 'alert' : 'status'}>
        {state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : ''}
      </span>
    </span>
  );
}

/**
 * A refusal in plain words. When the service has not switched the feature on, it is the not-live card instead; the same
 * refusal twice on one page is said once (the frame's `RefusalOnceProvider`).
 */
export function Failure({ result, retry, notLive }: { result: Failed; retry?: () => void; notLive?: string }) {
  const { t } = portalCopy.useCopy();
  const { t: u } = uiCopy.useCopy();
  const claim = useSaidOnce(`${refusalTitle(result)}|${refusalText(result)}`);
  if (isNotLive(result)) return <NotLive reason={notLive ?? notLiveReason(result)} />;
  if (!claim()) return null;
  return (
    <div
      data-testid="failure"
      className="lt-refusal"
      data-refusal={result.reason === 'uncertain' ? 'unreachable' : 'refused'}
      role={result.reason === 'uncertain' ? 'alert' : 'status'}
    >
      <h3 className="lt-refusal-title">{refusalTitle(result)}</h3>
      <p className="lt-refusal-body">{refusalText(result)}</p>
      {result.requestId && (
        <p className="lt-ref">
          {u('reference')} <CopyReference value={result.requestId} what={u('reference')} />
        </p>
      )}
      {result.reason === 'unauthorized' ? (
        <a
          className="lt-link"
          href={`/login?redirect=${encodeURIComponent(typeof location === 'undefined' ? '/pay/merchant' : location.pathname + location.search)}`}
        >
          {t('signIn')}
        </a>
      ) : (
        // Asking again never turns a "you may not" into a "yes", so a refusal for permission has no Try again.
        retry &&
        result.reason !== 'uncertain' &&
        result.reason !== 'forbidden' && (
          <Button tone="secondary" onClick={retry}>
            {t('tryAgain')}
          </Button>
        )
      )}
    </div>
  );
}

/** Loading and refusal for one read that is not a list. */
export function Gate<T>({
  resource,
  retry,
  rows,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Loading rows={rows} />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={retry} />;
  return <>{children(resource.data)}</>;
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
  if (state.status === 'loading') return <Loading />;
  if (state.status === 'failed') return <Failure result={state.failure} retry={retry} />;
  if (state.items.length === 0)
    return (
      <Empty title={empty.title} action={empty.action}>
        {empty.body}
      </Empty>
    );
  return <>{children(state.items)}</>;
}

/** Row count and "Load more". The count says "so far" while another page exists, so it is never read as a total. */
export function MoreFooter<T>({ state, onMore }: { state: Extract<ListState<T>, { status: 'ready' }>; onMore: () => void }) {
  const { t } = portalCopy.useCopy();
  const failed = typeof state.more === 'object';
  return (
    <div className="lt-actions">
      <p className="lt-hint" role="status">
        {state.hasMore ? t('rowsSoFar', { count: state.items.length }) : t('rowsAll', { count: state.items.length })}
      </p>
      {state.hasMore && (
        <Button tone="secondary" onClick={onMore} disabled={state.more === 'loading'}>
          {state.more === 'loading' ? t('loadingMore') : failed ? t('tryAgain') : t('loadMore')}
        </Button>
      )}
      {failed && <p role="alert">{refusalText(state.more as Failed)}</p>}
    </div>
  );
}

/** A choice from a short list, its options as `[value, words]` pairs. */
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
    <Select
      label={label}
      value={value}
      onChange={onChange}
      hint={hint}
      disabled={disabled}
      options={options.map(([v, text]) => ({ value: v, label: text }))}
    />
  );
}

/** A summary of key facts: label and value pairs, ids copyable by selection. */
export function Facts({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl data-testid="pp-facts" className="lt-kv">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A table in the kit's look, named as a region so a reader (and a test) finds it by its name. */
export function Grid({ label, headers, children }: { label: string; headers: readonly ReactNode[]; children: ReactNode }) {
  return (
    <div data-slot="data-table" tabIndex={0} role="region" aria-label={label}>
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export type EntityColumn<T> = { header: ReactNode; cell: (row: T) => ReactNode };

/** The one list: a table of rows; a row with a detail page has an explicit "Open" link. */
export function EntityList<T>({
  label,
  rows,
  rowKey,
  columns,
  href,
}: {
  label: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  columns: readonly EntityColumn<T>[];
  href?: (row: T) => string;
}) {
  const { t } = uiCopy.useCopy();
  return (
    <div data-testid="pe-table">
      <Grid label={label} headers={[...columns.map((c) => c.header), ...(href ? [<span className="lt-sr">{t('open')}</span>] : [])]}>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column, i) => (
              <td key={i}>{column.cell(row)}</td>
            ))}
            {href && (
              <td>
                <a className="lt-link" href={href(row)}>
                  {t('open')}
                </a>
              </td>
            )}
          </tr>
        ))}
      </Grid>
    </div>
  );
}

const CHIP: Record<StatusTone, 'done' | 'pending' | 'failed' | 'unknown'> = {
  done: 'done',
  progress: 'unknown',
  action: 'pending',
  failed: 'failed',
};

/** A status in words with a shape mark, never colour alone. */
export function ToneChip({ tone, label, tip }: { tone: StatusTone; label: string; tip?: string }) {
  return (
    <span
      data-testid="pp-chip"
      className="lt-chip"
      data-status={CHIP[tone]}
      data-tone={tone}
      title={tip}
      aria-label={tip ? `${label} (${tip})` : undefined}
    >
      <span className="lt-chip-mark" aria-hidden="true" />
      {label}
    </span>
  );
}

/** One status vocabulary for every entity (`../ui/StatusChip`): the word carries the meaning. */
export function StatusChip({ entity, value }: { entity: StatusEntity; value: string }) {
  const { t } = portalCopy.useCopy();
  const { t: u } = uiCopy.useCopy();
  const words = statusWords(entity, value, t, u);
  return <ToneChip tone={words.tone} label={words.label} tip={words.tip} />;
}

export function Chip({ kind, value }: { kind: ChipKind; value: string }) {
  return <StatusChip entity={kind} value={value} />;
}

/** Newest or oldest first is the page's choice; every event carries its time, or says the service keeps none. */
export function Timeline({ items, label }: { items: readonly TimelineEvent[]; label: string }) {
  const { t } = uiCopy.useCopy();
  return (
    <ol aria-label={label}>
      {items.map((item, i) => (
        <li key={`${item.at ?? 'unrecorded'}:${i}`}>
          <strong>{item.title}</strong>
          {item.detail && <p className="lt-hint">{item.detail}</p>}
          <small className="lt-hint">{item.at ? <DateTime value={item.at} /> : t('timeNotRecorded')}</small>
        </li>
      ))}
    </ol>
  );
}

/** The most figures a strip may show (`KPI_MAX` in `../ui/Kpi`): more reads as a wall. */
const KPI_LIMIT = 8;

/** Figures that each open the list holding the same numbers, and name their period. */
export function KpiStrip({ label, tiles }: { label: string; tiles: readonly KpiTileProps[] }) {
  return (
    <ul className="lt-kv" role="group" aria-label={label}>
      {tiles.slice(0, KPI_LIMIT).map((tile) => (
        <li key={`${tile.label}:${tile.period}`} data-tone={tile.tone}>
          <a className="lt-row-link" href={tile.href}>
            <span>
              {tile.label} <em>{tile.period}</em>
            </span>{' '}
            <strong>{tile.value}</strong>
            {tile.note && (
              <>
                {' '}
                <small className="lt-hint">{tile.note}</small>
              </>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** "Updated 2 min ago", once per page. Past the stale line it adds a calm note. */
export function Freshness({ asOf, lagSeconds = 0 }: { asOf: string | null; lagSeconds?: number }) {
  const { t } = uiCopy.useCopy();
  const now = useNow();
  if (!asOf) return null;
  const age = ageSeconds(asOf, now, lagSeconds);
  const text =
    age < 60
      ? t('updatedJustNow')
      : age < 3600
        ? t('updatedMinutes', { n: Math.floor(age / 60) })
        : age < 86_400
          ? t('updatedHours', { n: Math.floor(age / 3600) })
          : t('updatedDays', { n: Math.floor(age / 86_400) });
  const stale = age > STALE_AFTER_SECONDS;
  return (
    <p className="lt-hint" role="status" data-stale={stale || undefined}>
      {text}
      {stale && <> · {t('figuresBehind')}</>}
    </p>
  );
}

/** "Last changed by Sam · Oct 15, 10:40 PM". When the record does not say, it says so instead of guessing. */
export function AuditPanel({ who, at }: { who: string | null; at: string | null }) {
  const { t, requestedLocale } = uiCopy.useCopy();
  const when = at ? formatDateTime(at, requestedLocale)?.short : undefined;
  return <p className="lt-hint">{who && when ? t('lastChanged', { who, when }) : t('lastChangedUnknown')}</p>;
}

const LINK_LOOK = { primary: 'lt-button lt-button-primary', secondary: 'lt-button lt-button-secondary' } as const;

/** A link drawn as one of the kit's buttons: a page's one action, or a step to another page. */
export function LinkButton({ href, tone = 'secondary', children }: { href: string; tone?: 'primary' | 'secondary'; children: ReactNode }) {
  const look = LINK_LOOK[tone];
  return (
    <a className={look} href={href}>
      {children}
    </a>
  );
}

/**
 * Loading and refusal for one read. A read the service has not switched on yet becomes a card naming what it waits for
 * (`waiting.reason`) instead of an error, so the page still says what is missing and why (`../settings/account/ui`).
 */
export function ReadGate<T>({
  resource,
  retry,
  waiting,
  rows,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  waiting: { reason: string; body: string; needs?: string };
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'failed' && isNotLive(resource.failure))
    return (
      <NotLive reason={waiting.reason} needs={waiting.needs}>
        {waiting.body}
      </NotLive>
    );
  return (
    <Gate resource={resource} retry={retry} {...(rows ? { rows } : {})}>
      {children}
    </Gate>
  );
}

/** Label and value rows (`PayDetails` in `../../components`): a label in its own language when it has one. */
export function Details({ values }: { values: [string, ReactNode, string?][] }) {
  return (
    <dl className="lt-kv">
      {values.map(([label, value, labelLanguage]) => (
        <div key={label}>
          <dt lang={labelLanguage}>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
