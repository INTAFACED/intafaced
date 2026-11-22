import { Button, RefusalBox } from '@intafaced/ui/lit';
import type { ApiResult } from '../../shared/api';
import { useFailureView } from '../../shared/failure-view';

/**
 * A failed call in a public room drawn from the kit: the words shared/ui's `Failure` says, in the kit's refusal, found by
 * journeys as `data-testid="failure"`. `retry` adds Try again where the failure can clear by itself.
 */
export function Failed({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const view = useFailureView(result);
  return (
    <RefusalBox refusal={view.refusal} role={view.role} bodyLang={view.bodyLang} data-testid="failure">
      {retry && view.retryable ? (
        <Button tone="secondary" onClick={retry}>
          {view.retryLabel}
        </Button>
      ) : null}
    </RefusalBox>
  );
}
