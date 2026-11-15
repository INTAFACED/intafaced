import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { RulebookRoom } from '@/components/trade-ops/rulebook-room';
import { loadRulebookDesk } from '@/lib/trade-ops/rulebook-calls';

/**
 * Trading rulebook (RC-cex-spot-08, J-cex-spot-20 #6): the version customers read at /rulebook, its history, and the
 * two-person publish of a new version. A published version never changes; a change is a new version.
 */
export const dynamic = 'force-dynamic';

export default async function RulebookPage() {
  const { session, config } = await requireFounderPage();
  const view = await loadRulebookDesk({ session, config });
  const history = view.history;
  return (
    <DeskPage
      title="Trading rulebook"
      description="The rules customers read at /rulebook. Every section is owner text; a version missing a section is refused, a published version never changes, and a new one needs a second founder."
      asOf={view.asOf}
      state={history.kind === 'ok' ? 'live' : history.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={history.kind === 'ok' ? undefined : history.kind === 'unknown' ? history.message : history.code}
    >
      <RulebookRoom initial={view} />
    </DeskPage>
  );
}
