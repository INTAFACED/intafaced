import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { FollowAccountingView } from '@/components/trade-ops/copy-settlements';
import { readFollowAccounting } from '@/lib/trade-ops/copy-settlements-calls';

export const dynamic = 'force-dynamic';

/** One follow's position accounting for finance (CB-copy-pro-share-01, J-copy-bots-otc-11 #4): its fee shares and copied positions. */
export default async function FollowAccountingPage({ params }: { params: Promise<{ followId: string }> }) {
  const { session, config } = await requireFounderPage();
  const { followId } = await params;
  const read = await readFollowAccounting({ session, config }, decodeURIComponent(followId).slice(0, 64));
  return (
    <DeskPage
      title="Follow accounting"
      description="One follow's lead fee shares, judged as on Copy settlements, and its copied positions. Read only."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'refused' ? read.code : read.message}
    >
      <FollowAccountingView read={read} />
    </DeskPage>
  );
}
