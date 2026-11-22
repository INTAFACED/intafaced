import type { ApiResult } from '../../shared/api';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyRefusalText } from './academy-flows';
import { FailureNote } from './volt-parts';

/**
 * A failed Academy request. The service's typed refusals are worded here in plain language; anything else (a dropped
 * connection, a sign-in problem) goes to the shared failure note, which words those.
 */
export function AcademyRefusal({ failure, retry }: { failure: Extract<ApiResult<never>, { ok: false }>; retry?: () => void }) {
  const { t } = copy.useCopy();
  const words = academyRefusalText(failure, t);
  if (words === null) return <FailureNote result={failure} retry={retry} />;
  return (
    <div data-testid="failure" className="lt-refusal" role="status">
      <p className="lt-refusal-body">{words}</p>
    </div>
  );
}
