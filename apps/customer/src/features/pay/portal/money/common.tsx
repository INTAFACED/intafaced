import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { useMerchantAccess, useOptionalMerchantAccess } from '../access/MerchantAccess';
import { PortalFailure, PortalLoading, TestTag } from '../components';
import type { ListState } from '../hooks';
import { newRequestId } from '../model';
import { isNotLive, refusalText } from '../refusal';
import { formatDay } from '../ui/format';
import { EntityList, type EntityCard, type EntityColumn } from '../ui/EntityList';
import { dateRange, type ListFilters } from '../ui/FilterRow';
import type { PortalApi } from '../api';
import type { ApiResult } from '../../../../shared/api';
import { NotLiveCard } from '../chrome/NotLiveCard';
import { reason, type ReasonKey } from '../chrome/copy';
import { mc } from './copy';
import type { ListQuery } from './api';

/** The service allows one statement scan per merchant at a time; a second call is refused as busy. */
export function isStatementBusy(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  const code = result.code?.startsWith('pay.') ? result.code : (/^(pay\.[a-z0-9_]+)/.exec(result.message)?.[1] ?? result.code ?? '');
  return code === 'pay.statement_busy';
}

/** A refusal with its plain words and a retry; a busy statement is a calm wait, not an error. */
export function MoneyFailure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { t } = mc.useCopy();
  if (!isStatementBusy(result)) return <PortalFailure result={result} retry={retry} />;
  return (
    <div data-testid="failure" className="failure" role="status">
      <h3>{t('stmBusyTitle')}</h3>
      <p>{t('rStatementBusy')}</p>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          {t('stmBusyRetry')}
        </Button>
      )}
    </div>
  );
}

/** A button that is a link: the one way these pages send a merchant somewhere. */
export function LinkButton({
  href,
  children,
  variant = 'secondary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Button variant={variant} nativeButton={false} role="link" render={<a href={href} />}>
      {children}
    </Button>
  );
}

/** True when the account runs on test money: its business is not yet approved, so every figure is practice. */
export function useTestMode(): boolean {
  const access = useOptionalMerchantAccess()?.access;
  return access?.status === 'ready' && access.kybStatus !== null && access.kybStatus !== 'approved';
}

export function TestBanner() {
  const { t } = mc.useCopy();
  if (!useTestMode()) return null;
  return (
    <p className="pp-callout" role="note">
      <TestTag /> {t('mnTestBanner')}
    </p>
  );
}

/**
 * The one card for something that genuinely cannot be done yet. It names what it is waiting for (`why`, from
 * `chrome/copy.ts`) and is never a stand-in for a page whose service already exists. `needs` is for the review board.
 */
export function NamedBlocker({ title, why, needs, children }: { title: string; why: ReasonKey; needs: string; children?: ReactNode }) {
  return (
    <NotLiveCard reason={reason(why)} title={title} needs={needs}>
      {children}
    </NotLiveCard>
  );
}

/** "Load more" under a list. The count lives in the filter row, so it is never read as a total. */
export function LoadMore({ state, onMore }: { state: ListState<unknown>; onMore: () => void }) {
  const { t } = mc.useCopy();
  if (state.status !== 'ready' || !state.hasMore) return null;
  const failed = typeof state.more === 'object';
  return (
    <div className="pp-more">
      <Button variant="secondary" onClick={onMore} disabled={state.more === 'loading'}>
        {state.more === 'loading' ? t('loadingMore') : failed ? t('tryAgain') : t('loadMore')}
      </Button>
      {failed && (
        <p className="error-text" role="alert">
          {refusalText(state.more as Extract<ApiResult<unknown>, { ok: false }>)}
        </p>
      )}
    </div>
  );
}

/**
 * Loading, refused, empty and filled, for any list here. `blocked` is what to show when the list's service is not
 * released yet; without it a refusal is shown with its plain words and a retry.
 */
export function ListBody<T>({
  state,
  retry,
  onMore,
  empty,
  filtered,
  label,
  rowKey,
  columns,
  card,
  href,
  blocked,
}: {
  state: ListState<T>;
  retry: () => void;
  onMore: () => void;
  empty: { title: string; body: string; action?: ReactNode };
  /** Filters are on: an empty result then offers to clear them instead of explaining what the list is. */
  filtered?: { clear: () => void; active: boolean };
  label: string;
  rowKey: (row: T) => string;
  columns: readonly EntityColumn<T>[];
  card: (row: T) => EntityCard;
  href?: (row: T) => string;
  blocked?: ReactNode;
}) {
  const { t } = mc.useCopy();
  if (state.status === 'loading') return <PortalLoading rows={4} />;
  if (state.status === 'failed')
    return blocked && isNotLive(state.failure) ? <>{blocked}</> : <MoneyFailure result={state.failure} retry={retry} />;
  if (state.items.length === 0)
    return filtered?.active ? (
      <EmptyState
        title={t('mnNoMatchTitle')}
        action={
          <Button variant="secondary" onClick={filtered.clear}>
            {t('clearFilters')}
          </Button>
        }
      >
        {t('mnNoMatchBody')}
      </EmptyState>
    ) : (
      <EmptyState title={empty.title} action={empty.action}>
        {empty.body}
      </EmptyState>
    );
  return (
    <>
      <EntityList label={label} rows={state.items} rowKey={rowKey} columns={columns} card={card} href={href} />
      <LoadMore state={state} onMore={onMore} />
    </>
  );
}

/** The service's view of the filter row: blank is left out, and the date choice becomes real bounds. */
export function useListQuery(filters: ListFilters, extra: ListQuery = {}): ListQuery & Record<string, string> {
  const { date, from, to, status, asset, search } = filters;
  return useMemo(() => {
    const range = dateRange(date, Date.now(), { from, to });
    return {
      ...(status ? { status } : {}),
      ...(asset ? { assetId: asset } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
      ...extra,
    } as ListQuery & Record<string, string>;
    // `extra` is built fresh each render by callers; its values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, from, to, status, asset, search, JSON.stringify(extra)]);
}

export type ExportKindName = 'settlements' | 'payouts' | 'refunds' | 'ledger_statement';

/**
 * Asks the service for a file of exactly what the list shows (its current filters). The file is made in the
 * background and appears under Reports. Where the service cannot, the page offers a labelled copy of this page.
 */
export function ExportButton({
  portal,
  kind,
  query,
  fallback,
}: {
  portal: PortalApi;
  kind: ExportKindName;
  query: ListQuery;
  fallback?: ReactNode;
}) {
  const { t } = mc.useCopy();
  const { can } = useMerchantAccess();
  const [state, setState] = useState<'idle' | 'busy' | 'started' | { message: string }>('idle');
  // A different view is a different request; the same view clicked twice replays the first.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const requestId = useMemo(newRequestId, [kind, JSON.stringify(query)]);
  const allowed = can('exports.create');
  return (
    <div className="pp-actions">
      <Button
        variant="secondary"
        disabled={!allowed || state === 'busy'}
        title={allowed ? undefined : t('mnExportNotAllowed')}
        onClick={async () => {
          setState('busy');
          const result = await portal.moneyExportCreate({
            requestId,
            kind,
            filters: {
              ...(query.from ? { from: query.from } : {}),
              ...(query.to ? { to: query.to } : {}),
              ...(query.status ? { status: query.status } : {}),
              ...(query.assetId ? { assetId: query.assetId } : {}),
            },
          });
          setState(result.ok ? 'started' : { message: refusalText(result) });
        }}
      >
        {state === 'busy' ? t('mnExportStarting') : t('mnExportView')}
      </Button>
      {fallback}
      <span role="status">
        {state === 'started' && (
          <>
            {t('mnExportStarted')}{' '}
            <a className="text-link" href="/pay/reports/exports">
              {t('mnExportReports')}
            </a>
          </>
        )}
      </span>
      {typeof state === 'object' && (
        <span role="alert" className="error-text">
          {state.message}
        </span>
      )}
      {!allowed && <small className="muted">{t('mnExportNotAllowed')}</small>}
    </div>
  );
}

/** A person's name: "You" for the signed-in user, their team name where the list has it, otherwise a short id. */
export function whoIs(id: string, me: string | null, names: ReadonlyMap<string, string>, you: string): string {
  if (id === me) return you;
  return names.get(id) ?? `${id.slice(0, 8)}…`;
}

/**
 * "Payout to ••4421 · Oct 15": named by where it went and the day its settlement was finalised, on every page. With no
 * date to hand the name drops it ("Payout to ••4421") rather than borrowing a different day, such as the day it was asked for.
 */
export function payoutName(
  t: ReturnType<typeof mc.useCopy>['t'],
  locale: string,
  row: { createdAt?: string | null },
  approval?: { destinationMasked?: string } | null,
): string {
  const to = approval?.destinationMasked;
  if (!row.createdAt) return to ? t('payoutNameToBare', { to }) : t('payoutNameBare');
  const when = shortDay(row.createdAt, locale);
  return to ? t('payoutNameTo', { to, when }) : t('payoutNamePlain', { when });
}

/** "Oct 15, 2026", in the browser's time zone (the same day the list shows for this row). */
export function shortDay(value: string, locale: string): string {
  return formatDay(value, locale) ?? value;
}

/** A refusal this page words itself (an address that cannot be right), shaped like a service refusal. */
export function localRefusal(message: string): Extract<ApiResult<never>, { ok: false }> {
  return { ok: false, reason: 'error', code: 'portal.local', message };
}
