/**
 * The money pages' own parts for a page on its Volt template, drawn only from the kit and the portal's kit parts
 * (`../volt/parts`). Each keeps the words, roles and test ids of the part it stands in for in `./common`.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { ListState } from '../hooks';
import type { ApiResult } from '../../../../shared/api';
import type { PortalApi } from '../api';
import { useMerchantAccess } from '../access/MerchantAccess';
import { newRequestId } from '../model';
import { refusalText } from '../refusal';
import { reason, type ReasonKey } from '../chrome/copy';
import { Button } from '@intafaced/ui/lit';
import { Empty, EntityList, Failure, Loading, NotLive, TestTag, type EntityColumn } from '../volt/parts';
import type { ListQuery } from './api';
import { mc } from './copy';
import { useTestMode } from './test-mode';
import { isStatementBusy } from './money-words';

/** Practice money: one line at the top of the page, while the business is not yet approved. */
export function TestBanner() {
  const { t } = mc.useCopy();
  if (!useTestMode()) return null;
  return (
    <p className="lt-hint" role="note">
      <TestTag /> {t('mnTestBanner')}
    </p>
  );
}

/** The one card for something that genuinely cannot be done yet, naming what it waits for (`why`, from `../chrome/copy`). */
export function NamedBlocker({ title, why, needs, children }: { title: string; why: ReasonKey; needs: string; children?: ReactNode }) {
  return (
    <NotLive reason={reason(why)} title={title} needs={needs}>
      {children}
    </NotLive>
  );
}

/** Loading, refused, empty and filled, for a list on these pages, with "Load more" under it (`ListBody` in `./common`). */
export function ListBody<T>({
  state,
  retry,
  onMore,
  empty,
  filtered,
  label,
  rowKey,
  columns,
  href,
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
  href?: (row: T) => string;
}) {
  const { t } = mc.useCopy();
  if (state.status === 'loading') return <Loading rows={4} />;
  if (state.status === 'failed') return <MoneyFailure result={state.failure} retry={retry} />;
  if (state.items.length === 0)
    return filtered?.active ? (
      <Empty
        title={t('mnNoMatchTitle')}
        action={
          <Button tone="secondary" onClick={filtered.clear}>
            {t('clearFilters')}
          </Button>
        }
      >
        {t('mnNoMatchBody')}
      </Empty>
    ) : (
      <Empty title={empty.title} action={empty.action}>
        {empty.body}
      </Empty>
    );
  return (
    <>
      <EntityList label={label} rows={state.items} rowKey={rowKey} columns={columns} href={href} />
      <LoadMore state={state} onMore={onMore} />
    </>
  );
}

/** "Load more" under a list (`LoadMore` in `./common`): only while another page exists. */
function LoadMore({ state, onMore }: { state: ListState<unknown>; onMore: () => void }) {
  const { t } = mc.useCopy();
  if (state.status !== 'ready' || !state.hasMore) return null;
  const failed = typeof state.more === 'object';
  return (
    <div className="lt-actions">
      <Button tone="secondary" onClick={onMore} disabled={state.more === 'loading'}>
        {state.more === 'loading' ? t('loadingMore') : failed ? t('tryAgain') : t('loadMore')}
      </Button>
      {failed && <p role="alert">{refusalText(state.more as Extract<ApiResult<unknown>, { ok: false }>)}</p>}
    </div>
  );
}

type ExportKindName = 'settlements' | 'payouts' | 'refunds';

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
  const requestId = useMemo(newRequestId, [kind, JSON.stringify(query)]);
  const allowed = can('exports.create');
  return (
    <div className="lt-actions">
      <Button
        tone="secondary"
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
            <a className="lt-link" href="/pay/reports/exports">
              {t('mnExportReports')}
            </a>
          </>
        )}
      </span>
      {typeof state === 'object' && <span role="alert">{state.message}</span>}
      {!allowed && <small className="lt-muted">{t('mnExportNotAllowed')}</small>}
    </div>
  );
}

/** A refusal with its plain words and a retry; a busy statement is a calm wait, not an error (`MoneyFailure` in `./common`). */
export function MoneyFailure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { t } = mc.useCopy();
  if (!isStatementBusy(result)) return <Failure result={result} retry={retry} />;
  return (
    <div data-testid="failure" className="lt-refusal" data-refusal="unreachable" role="status">
      <h3 className="lt-refusal-title">{t('stmBusyTitle')}</h3>
      <p className="lt-refusal-body">{t('rStatementBusy')}</p>
      {retry && (
        <Button tone="secondary" onClick={retry}>
          {t('stmBusyRetry')}
        </Button>
      )}
    </div>
  );
}
