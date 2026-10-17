import 'server-only';
import { readOperatorEnv } from '@/lib/operator-env';

/**
 * Anything other than `APP_ENV=prod` is not real money: local previews, tests
 * and staging. The badge says so on every Merchants page so a screenshot is
 * never mistaken for live figures. If the environment cannot be read the badge
 * is shown, because the wrong answer to "is this real?" must be "no".
 */
export function isTestData(): boolean {
  try {
    return readOperatorEnv().appEnv !== 'prod';
  } catch {
    return true;
  }
}

export function TestDataBadge() {
  if (!isTestData()) return null;
  return (
    <p className="mp-testdata" role="note" data-testid="test-data-badge">
      <span className="mp-testdata__dot" aria-hidden="true" />
      <strong>Test data</strong>
      <span className="mp-testdata__hint">Not real money. Figures here come from a non-production environment.</span>
    </p>
  );
}
