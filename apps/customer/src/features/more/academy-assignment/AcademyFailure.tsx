import { Button } from '@intafaced/ui/lit';
import { RefusalBox } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { uiCopy } from '../../../shared/ui-copy';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { academyFailureView } from './academy-failure';

/**
 * A failed Academy request in place, on the kit: Academy's typed refusal in its plain words, or the kit refusal with
 * Try again where a second attempt can change the answer.
 */
export function AcademyFailure({ failure, retry }: { failure: Extract<ApiResult<never>, { ok: false }>; retry?: () => void }) {
  const { t } = copy.useCopy();
  const ui = uiCopy.useCopy();
  const here = typeof location === 'undefined' ? '' : location.pathname + location.search;
  const view = academyFailureView(failure, t, ui, here);
  if (view.kind === 'words')
    return (
      <div data-testid="failure" role="status">
        <p>{view.words}</p>
      </div>
    );
  return (
    <div data-testid="failure">
      <RefusalBox refusal={view.refusal} />
      {retry && view.retry ? <Button onClick={retry}>{ui.t('retry')}</Button> : null}
    </div>
  );
}
