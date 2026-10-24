import { ConsoleModeDesk } from '@/components/console-mode-desk';
import { loadConsoleMode } from '@/lib/console-mode/server';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';

/** Maintenance mode (`/tools/console-mode`, OPS-admin-access-08). The first paint is svc-ops' own answer with the time it was read. */
export const dynamic = 'force-dynamic';

export default async function ConsoleModePage() {
  requireModulePage('tools');
  const founder = await requireFounderPage();
  return <ConsoleModeDesk initial={await loadConsoleMode(founder)} userId={founder.session.userId} />;
}
