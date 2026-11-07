import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { RefusalLine } from '@/components/kyc-review-queue';
import { BUSINESS_SEES } from '@/lib/kyc-review/business';
import { UUID } from '@/lib/kyc-review/model';
import { readBusinessApplication } from '@/lib/kyc-review/server';

/**
 * One business application (I-kyc-compliance-25, J-identity-20 #9): its verification status as svc-pay holds it, read now
 * as the signed-in reviewer, and the exact words the business reads for that status. The decision stays svc-pay's
 * two-person `kyb.decide`.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ merchantId: string }> }) {
  requireModulePage('identity-ops');
  const signedIn = await requireFounderPage();
  const { merchantId } = await params;
  if (!UUID.test(merchantId)) notFound();
  const read = await readBusinessApplication(signedIn, merchantId);
  const asOf = new Date().toISOString();
  return (
    <main className="dk-stack" data-testid="kyb-application" data-merchant={merchantId}>
      <p>
        <Link href="/identity-ops/kyc">← Verification queue</Link>
      </p>
      <h1>
        Business application <code>{merchantId.slice(0, 8)}</code>
      </h1>
      {!read.ok ? (
        <RefusalLine refusal={read.refusal} testId="kyb-application-refusal" />
      ) : (
        <dl className="dk-facts">
          <dt>Status</dt>
          <dd data-testid="kyb-application-status" data-status={read.data.kybStatus}>
            {read.data.kybStatus}
          </dd>
          <dt>The business sees</dt>
          <dd data-testid="kyb-application-business-sees">{BUSINESS_SEES[read.data.kybStatus]}</dd>
          <dt>Verification reference</dt>
          <dd>{read.data.kybRef ?? 'None given'}</dd>
          <dt>Read at</dt>
          <dd>
            <time dateTime={asOf}>{asOf}</time>
          </dd>
        </dl>
      )}
    </main>
  );
}
