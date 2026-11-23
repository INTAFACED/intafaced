import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { useTestMode } from './test-mode';
import { PortalFailure, PortalLoading, TestTag } from '../components';
import type { ListState } from '../hooks';
import { isNotLive, refusalText } from '../refusal';
import { EntityList, type EntityCard, type EntityColumn } from '../ui/EntityList';
import type { ApiResult } from '../../../../shared/api';
import { NotLiveCard } from '../chrome/NotLiveCard';
import { reason, type ReasonKey } from '../chrome/copy';
import { mc } from './copy';
import { isStatementBusy } from './money-words';
export { localRefusal, shortDay } from './money-words';

/** A refusal with its plain words and a retry; a busy statement is a calm wait, not an error. */
export function MoneyFailure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { t } = mc.useCopy();
  if (!isStatementBusy(result)) return <PortalFailure result={result} retry={retry} />;
  return (
    <div data-testid="failure" className="lt-refusal" role="status">
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

export { useTestMode } from './test-mode';

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
