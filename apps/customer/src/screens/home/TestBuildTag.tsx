import { homeCopy } from './copy';
import { StatusTag } from './deps';
import { isTestBuild } from '../../shared/test-build';

/** On a test build every balance is TEST money, so the total says so (AGENTS.md product law: TEST figures carry TEST). */
export function TestBuildTag() {
  const { t } = homeCopy.useCopy();
  return isTestBuild() ? (
    <StatusTag data-testid="home-total-test" data-status="test" className="home-total__test" status="pending" label={t('TEST')} />
  ) : null;
}
