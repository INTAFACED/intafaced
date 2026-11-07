import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { KycCaseReview } from '@/components/kyc-case-review';
import { UUID } from '@/lib/kyc-review/model';

/**
 * One verification case on the review queue (I-kyc-compliance-02, J-identity-20 #2): the record, reason codes, history and
 * notes, and the decision. Everything on it is identity's answer, read as the signed-in reviewer.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  requireModulePage('identity-ops');
  const signedIn = await requireFounderPage();
  const { caseId } = await params;
  if (!UUID.test(caseId)) notFound();
  return (
    <main className="dk-stack">
      <p>
        <Link href="/identity-ops/kyc">← Verification queue</Link>
      </p>
      <h1>
        Verification case <code>{caseId.slice(0, 8)}</code>
      </h1>
      <KycCaseReview caseId={caseId} me={signedIn.session.userId} />
    </main>
  );
}
