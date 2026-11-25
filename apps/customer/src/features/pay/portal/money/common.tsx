import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import { PortalFailure } from '../components';
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

export { useTestMode } from './test-mode';

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
