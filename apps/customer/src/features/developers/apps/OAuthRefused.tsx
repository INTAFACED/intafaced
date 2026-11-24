import type { ApiResult } from '../../../shared/api';
import { appsCopy, refusalCopyKey } from './apps-copy';

type T = ReturnType<typeof appsCopy.useCopy>['t'];
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** The service's own `oauth.*` code in the person's words; any other refusal says it was refused and shows its code. */
export function Refused({ failure, t }: { failure: Refusal; t: T }) {
  const code = failure.code;
  const key = refusalCopyKey(code);
  const known = key ? t(key) : t('otherRefusal');
  return (
    <div role="alert" className="lt-refusal">
      <strong className="lt-refusal-title">{t('refusedHeading')}</strong>
      <p className="lt-refusal-body">{known}</p>
      {code ? (
        <p className="lt-muted">
          {t('codeLabel')}: <code className="lt-mono">{code}</code>
        </p>
      ) : null}
    </div>
  );
}
