import { StateBlock } from '@intafaced/ui';
import { classifyRefusal, refusalCopy } from '../../../data';
import type { ApiResult } from '../../../shared/api';

export type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** Typed refusals (and sign-in or permission problems) get words; anything else is a retry. */
export function isRefusal(failure: Failure): boolean {
  if (failure.reason === 'unauthorized' || failure.reason === 'forbidden') return true;
  return Boolean(failure.code) && classifyRefusal(failure.code) !== 'unknown';
}

/** The code to hand to `refusalCopy`: a sign-in problem with no code still reads as "sign in again". */
export function refusalCodeOf(failure: Failure): string {
  if (failure.code) return failure.code;
  return failure.reason === 'unauthorized' ? 'auth.required' : 'scope.denied';
}

/** A read that did not work, inside the panel that failed (UI-SPEC 4.3). Never shows the raw service code. */
export function ReadFailure({
  failure,
  retry,
  title,
  retryLabel,
  className,
}: {
  failure: Failure;
  retry: () => void;
  title: string;
  retryLabel: string;
  className?: string;
}) {
  if (isRefusal(failure)) {
    const words = refusalCopy(refusalCodeOf(failure));
    return (
      <StateBlock kind="refused" className={className} title={words.title} body={words.body} code={words.reference} action={words.action} />
    );
  }
  return <StateBlock kind="error" className={className} title={title} onRetry={retry} retryLabel={retryLabel} />;
}
