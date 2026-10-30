import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { LaunchSequence } from '@/components/launch-sequence';
import { IssuerLens } from '@/components/launch-issuers/issuer-lens';
import { readIssuerLens } from '@/lib/launch-issuers/server';
import { readOperatorEnv } from '@/lib/operator-env';

export const dynamic = 'force-dynamic';

export default async function LaunchSequencePage() {
  requireModulePage('launch');
  const founder = await requireFounderPage();
  const env = readOperatorEnv();
  const lens = await readIssuerLens(founder);
  return (
    <>
      <IssuerLens read={lens} userId={founder.session.userId} />
      <LaunchSequence currentDrop={env.drop} flagEnv={env.flagEnv} />
    </>
  );
}
