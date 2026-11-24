import { Button } from '@intafaced/ui/lit';
import { isVerifyFirst, type ApiResult } from './api';
import { VerifyFirstNote } from './verify-first';
import { useFailureWords } from './failure-words';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A failed read or write: what happened in plain words, the support reference, and Try again when it can help. */
export function FailureNote({ result, retry }: { result: Failed; retry?: () => void }) {
  const words = useFailureWords()(result);
  if (isVerifyFirst(result)) return <VerifyFirstNote code={result.code} />;
  return (
    <div data-testid="failure" className="lt-refusal" role={words.role}>
      <h3 className="lt-refusal-title">{words.title}</h3>
      <p className="lt-refusal-body" lang={words.bodyLang}>
        {words.body}
      </p>
      {words.action ? (
        <a className="lt-link" href={words.action.href}>
          {words.action.label}
        </a>
      ) : null}
      {words.reference ? <p className="lt-ref">{words.reference}</p> : null}
      {retry && words.retry ? (
        <Button tone="secondary" onClick={retry}>
          {words.retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
