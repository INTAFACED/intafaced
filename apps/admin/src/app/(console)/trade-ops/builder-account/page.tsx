import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { BuilderAccount } from '@/components/trade-ops/builder-account';
import { readBuilderAccount } from '@/lib/trade-ops/builder-account';

/**
 * Builder account (J-ops-console-28): our builder address's account mode at each venue, beside the mode the venue requires
 * for collecting builder fees, and the alerts to the owner's named contact. Every mode is the venue's own figure; opening
 * the page is one more check. Nothing here moves money or changes a mode.
 */
export const dynamic = 'force-dynamic';

export default async function BuilderAccountPage() {
  requireModulePage('tradeops');
  const { session, config } = await requireFounderPage();
  const read = await readBuilderAccount({ session, config });
  const unknownRows = read.kind === 'ok' ? read.data.venues.filter((v) => v.verdict === 'unknown').map((v) => v.venueId) : [];
  return (
    <DeskPage
      title="Builder account"
      description="Our builder address's account mode at each venue, beside the mode the venue requires for collecting builder fees."
      asOf={read.kind === 'ok' ? read.data.asOf : read.asOf}
      state={read.kind === 'ok' ? (unknownRows.length ? 'unknown' : 'live') : read.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={
        read.kind === 'ok'
          ? unknownRows.length
            ? `Not read: ${unknownRows.join(', ')}`
            : undefined
          : read.kind === 'unknown'
            ? read.message
            : read.code
      }
    >
      {read.kind === 'ok' ? (
        <BuilderAccount view={read.data} />
      ) : (
        <ReadProblem outcome={read} title="The builder account could not be read" />
      )}
    </DeskPage>
  );
}
