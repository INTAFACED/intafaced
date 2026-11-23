// volt-room: /notifications
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import type { ScreenProps } from '../../app/screen-types';
import { alertsCopy } from './alerts-copy';
import AlertsPage from './AlertsPage';
import { centreCopy } from './centre-copy';
import { notifyCopy } from './copy';
import DeliveryLog from './DeliveryLog';
import NotificationSettings from './NotificationSettings';
import NotificationsPage from './NotificationsPage';
import { NotifyNav, type NotifyView } from './NotifyNav';

const viewOf = (search: string): NotifyView => {
  const view = new URLSearchParams(search).get('view');
  return view === 'settings' || view === 'delivery' || view === 'alerts' ? view : 'inbox';
};

/**
 * The Notifications centre (UI-SPEC 5.12) on the record-list template: the inbox at `/notifications`, price alerts at
 * `/notifications?view=alerts`, preferences at `/notifications?view=settings` and the delivery history at
 * `/notifications?view=delivery`. The four parts share one frame: the part's name as the room's title, and the links between them.
 */
export default function NotificationsScreen({ search }: ScreenProps) {
  const view = viewOf(search);
  const inbox = notifyCopy.useCopy();
  const centre = centreCopy.useCopy();
  const alerts = alertsCopy.useCopy();
  const title =
    view === 'settings'
      ? centre.t('prefsTitle')
      : view === 'delivery'
        ? centre.t('deliveryTitle')
        : view === 'alerts'
          ? alerts.t('title')
          : inbox.t('Notifications');
  return (
    <div data-testid="if-notify">
      <RecordListTemplate
        title={title}
        state={{ kind: 'ready' }}
        filters={<NotifyNav current={view} />}
        list={
          view === 'settings' ? (
            <NotificationSettings />
          ) : view === 'delivery' ? (
            <DeliveryLog />
          ) : view === 'alerts' ? (
            <AlertsPage />
          ) : (
            <NotificationsPage />
          )
        }
      />
    </div>
  );
}
