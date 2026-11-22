/**
 * The money pages' own parts for a page on its Volt template, drawn only from the kit and the portal's kit parts
 * (`../volt/parts`). Each keeps the words, roles and test ids of the part it stands in for in `./common`.
 */
import type { ReactNode } from 'react';
import type { ListState } from '../hooks';
import type { ApiResult } from '../../../../shared/api';
import { refusalText } from '../refusal';
import { reason, type ReasonKey } from '../chrome/copy';
import { Button } from '@intafaced/ui/lit';
import { Empty, EntityList, Failure, Loading, NotLive, TestTag, type EntityColumn } from '../volt/parts';
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
  label,
  rowKey,
  columns,
  href,
}: {
  state: ListState<T>;
  retry: () => void;
  onMore: () => void;
  empty: { title: string; body: string; action?: ReactNode };
  label: string;
  rowKey: (row: T) => string;
  columns: readonly EntityColumn<T>[];
  href?: (row: T) => string;
}) {
  if (state.status === 'loading') return <Loading rows={4} />;
  if (state.status === 'failed') return <Failure result={state.failure} retry={retry} />;
  if (state.items.length === 0)
    return (
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
