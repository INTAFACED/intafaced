import { PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { CopyDesk } from '@/components/trade-ops/copy-desk';
import { readLeadDesk } from '@/lib/trade-ops/copy-lead-calls';

export const dynamic = 'force-dynamic';

/**
 * Copy trading: who may lead. Applications wait oldest first; an approval needs the lead criteria set and a second
 * founder; a rejection and a suspension each keep their reason in the audit. Pooled masters, whitelists, takeovers and
 * levels show their honest state until they are built. The freshness is said in the room's own words, so the one
 * status line on this page is the result of the last action.
 */
export default async function CopyTradingPage() {
  const { session, config } = await requireFounderPage();
  const read = await readLeadDesk({ session, config });
  return (
    <DeskPage
      title="Copy trading"
      description={`Vet who may lead copy trading, with a second founder for every approval. ${
        read.kind === 'ok' ? `Read at ${read.asOf.slice(11, 19)} UTC.` : 'The desk could not be read.'
      }`}
    >
      <PageSection title="Leads and applications">
        <CopyDesk initial={read} userId={session.userId} />
      </PageSection>
    </DeskPage>
  );
}
