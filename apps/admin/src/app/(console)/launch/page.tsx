import { requireFounderPage } from '@/lib/founder-page';
import { LaunchSequence } from '@/components/launch-sequence';
import { readOperatorEnv } from '@/lib/operator-env';

export default async function LaunchSequencePage() {
  await requireFounderPage();
  const env = readOperatorEnv();
  return <LaunchSequence currentDrop={env.drop} flagEnv={env.flagEnv} />;
}
