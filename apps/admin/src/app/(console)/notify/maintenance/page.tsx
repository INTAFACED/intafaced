import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifyMaintenanceDesk } from '@/components/notify-maintenance-desk';
import { loadMaintenanceDesk } from '@/lib/notify/maintenance-server';

/**
 * The maintenance desk: scheduled maintenance windows (drafts too) with the state svc-notify derives, the operators'
 * moves and the reminders, and the second-founder approval each publish spends. The first paint is the services' answer.
 */
export default async function NotifyMaintenancePage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  return <NotifyMaintenanceDesk initial={await loadMaintenanceDesk(founder)} />;
}
