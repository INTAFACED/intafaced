import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { useTestMode } from './test-mode';
import { PortalFailure, TestTag } from '../components';
import type { ListState } from '../hooks';
import { refusalText } from '../refusal';
import type { ApiResult } from '../../../../shared/api';
import { NotLiveCard } from '../chrome/NotLiveCard';
import { reason, type ReasonKey } from '../chrome/copy';
import { mc } from './copy';
import { isStatementBusy } from './money-words';

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
