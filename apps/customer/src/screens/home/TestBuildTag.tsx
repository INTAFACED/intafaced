import { homeCopy } from './copy';
import { StatusTag } from './volt-parts';
import { isTestBuild } from '../../shared/test-build';

/** On a test build every balance is TEST money, so the total says so (AGENTS.md product law: TEST figures carry TEST). */
export function TestBuildTag() {
  const { t } = homeCopy.useCopy();
  return isTestBuild() ? <StatusTag testId="home-total-test" test status="pending" label={t('TEST')} /> : null;
}
