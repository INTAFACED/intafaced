import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { HealthBoard } from '@/components/health-board';
import { boardReads, buildBoard } from '@/lib/module-health/board';
import { loadReads } from '@/lib/ops-desk/server';

/**
 * The module health board: one row per platform module, read as the signed-in founder when the page opens. A refresh is a
 * new read of the page; nothing is cached.
 */
export default async function Page() {
  requireModulePage('killswitches');
  const founder = await requireFounderPage();
  const startedAt = new Date();
  const rows = buildBoard(await loadReads(founder, boardReads(), startedAt));
  return <HealthBoard rows={rows} startedAt={startedAt.toISOString()} />;
}
