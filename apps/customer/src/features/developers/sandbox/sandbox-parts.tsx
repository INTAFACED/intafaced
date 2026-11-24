/** The sandbox rooms' shared parts, drawn only from the Volt kit: a typed refusal and the sandbox address. */
import type { ApiResult } from '../../../shared/api';
import { sandboxCopy, sandboxRefusalKey } from './sandbox-copy';
import { Failure } from './kit-parts';

export type T = ReturnType<typeof sandboxCopy.useCopy>['t'];
export type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** A typed refusal in the person's words, with its code kept on the element and shown as the support reference. */
export function Refused({ failure, t }: { failure: Refusal; t: T }) {
  const key = sandboxRefusalKey(failure.code);
  if (!key && !failure.code) return <Failure result={failure} />;
  return (
    <div role="alert" className="lt-refusal" data-code={failure.code}>
      <strong className="lt-refusal-title">{t('refusedHeading')}</strong>
      <p className="lt-refusal-body">{key ? t(key) : t('otherRefusal')}</p>
      <p className="lt-ref">
        {t('codeLabel')}: <code lang="und">{failure.code}</code>
      </p>
    </div>
  );
}

export function BaseUrl({ baseUrl, t }: { baseUrl: string | null; t: T }) {
  return (
    <>
      {baseUrl ? (
        <p>
          {t('baseUrlLabel')}:{' '}
          <code lang="und" data-testid="sandbox-base-url">
            {baseUrl}
          </code>
        </p>
      ) : (
        <p className="lt-hint" data-testid="sandbox-base-url-unset">
          {t('baseUrlUnset')}
        </p>
      )}
      <p>
        <a className="lt-link" href="/developers/sandbox/test-values">
          {t('testValuesLink')}
        </a>
      </p>
    </>
  );
}
