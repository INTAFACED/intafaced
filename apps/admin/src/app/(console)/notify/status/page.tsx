import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifyStatusDesk } from '@/components/notify-status-desk';
import { loadStatusDesk } from '@/lib/notify/status-server';

/**
 * The public status page desk: what visitors read on /status now, the founders' definition of it, readings entered by
 * hand for outside dependencies, and badge snippets. The first paint is svc-notify's own answer, with its read time.
 */
export default async function NotifyStatusPage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  return <NotifyStatusDesk initial={await loadStatusDesk(founder)} />;
}
