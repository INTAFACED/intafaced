import type { ScreenProps } from '../../app/screen-types';
import NotificationSettings from './NotificationSettings';
import NotificationsPage from './NotificationsPage';

/** Notifications (UI-SPEC 5.12): the inbox at `/notifications`, and its settings at `/notifications?view=settings`. */
export default function NotificationsScreen({ search }: ScreenProps) {
  return new URLSearchParams(search).get('view') === 'settings' ? <NotificationSettings /> : <NotificationsPage />;
}
