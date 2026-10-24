import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifySubscribersDesk } from '@/components/notify-subscribers-desk';
import { loadSubscriberDesk } from '@/lib/notify/subscribers-server';

/**
 * The subscriber desk: status update subscribers by state, the channels and which have no sender, the delivery rows of
 * one published notice, the subscribe safeguards and imports. The first paint is svc-notify's own answer.
 */
export default async function NotifySubscribersPage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  return <NotifySubscribersDesk initial={await loadSubscriberDesk(founder, { state: null, noticeId: null })} />;
}
