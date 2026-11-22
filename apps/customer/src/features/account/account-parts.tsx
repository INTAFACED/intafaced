import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../shared/api';
import { useFailureWords } from '../../shared/failure-words';
import { uiCopy } from '../../shared/ui-copy';

/**
 * The account rooms' small parts, drawn with the Volt kit. Each keeps the words, roles and ids of the `shared/ui` part
 * it stands in for (Failure, Loading), which other rooms still use as they are.
 */

/** A failed read or change, in the words the app's Failure says. */
export function FailureBox({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
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

/** A read still on its way, in the words the app's Loading says. */
export function LoadingLine({ label }: { label?: ReactNode }) {
  const { Copy } = uiCopy.useCopy();
  return <p role="status">{label ?? <Copy k="loading" />}…</p>;
}
