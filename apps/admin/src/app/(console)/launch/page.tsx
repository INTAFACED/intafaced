import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { LaunchSequence } from '@/components/launch-sequence';
import { readOperatorEnv } from '@/lib/operator-env';

export default async function LaunchSequencePage() {
  requireModulePage('launch');
  await requireFounderPage();
  const env = readOperatorEnv();
  return <LaunchSequence currentDrop={env.drop} flagEnv={env.flagEnv} />;
}
