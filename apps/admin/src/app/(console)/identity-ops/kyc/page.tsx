import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { KycReviewQueue } from '@/components/kyc-review-queue';

/**
 * The verification review queue (I-kyc-compliance-02, J-identity-20 #1): open KYC cases a page at a time, claimed by one
 * reviewer each. Everything on it is identity's answer, read in the browser as the signed-in person.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('identity-ops');
  const signedIn = await requireFounderPage();
  return <KycReviewQueue me={signedIn.session.userId} />;
}
