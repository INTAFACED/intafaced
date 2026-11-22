import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';

/** A failed read, in the words `Failure` (shared/ui) says it, drawn with the kit. */
export function SalaryFailure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
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
