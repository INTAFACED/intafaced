import type { ScreenProps } from '../../app/screen-types';
import DeliveryLog from './DeliveryLog';
import NotificationSettings from './NotificationSettings';
import NotificationsPage from './NotificationsPage';

/**
 * The Notifications centre (UI-SPEC 5.12): the inbox at `/notifications`, preferences at `/notifications?view=settings`
 * and the delivery history at `/notifications?view=delivery`.
 */
export default function NotificationsScreen({ search }: ScreenProps) {
  const view = new URLSearchParams(search).get('view');
  return view === 'settings' ? <NotificationSettings /> : view === 'delivery' ? <DeliveryLog /> : <NotificationsPage />;
}
