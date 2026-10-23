import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifyNoticesDesk } from '@/components/notify-notices-desk';
import { loadNoticesDesk } from '@/lib/notify/notices-server';

/**
 * The announcement desk: announcements (drafts too) with the category each is filed under, the founders' category list,
 * and the second-founder approval each publish spends. The first paint is the services' answer.
 */
export default async function NotifyNoticesPage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  return <NotifyNoticesDesk initial={await loadNoticesDesk(founder)} />;
}
