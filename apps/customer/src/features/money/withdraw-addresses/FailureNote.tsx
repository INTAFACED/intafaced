import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';

/** A failed read in the same words, role and try-again rule as the shared `Failure`, drawn with the kit. */
export function FailureNote({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const w = useFailureWords(result, Boolean(retry));
  return (
    <div data-testid="failure" role={w.alert ? 'alert' : 'status'}>
      <h3>{w.title}</h3>
      <p lang={w.bodyLang}>{w.body}</p>
      {w.action && (
        <a className="lt-link" href={w.action.href}>
          {w.action.label}
        </a>
      )}
      {w.reference && <small>{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}
