import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { KycLevelSettingsEditor } from '@/components/kyc-level-settings';

/** Per-level requirements and review times (I-kyc-compliance-05, J-identity-20 #7): a change waits for a second person. */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('identity-ops');
  const signedIn = await requireFounderPage();
  return (
    <main className="dk-stack">
      <p>
        <Link href="/identity-ops/kyc">← Verification queue</Link>
      </p>
      <KycLevelSettingsEditor me={signedIn.session.userId} />
    </main>
  );
}
