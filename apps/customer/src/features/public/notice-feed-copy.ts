import { defineCopy } from '../../shared/i18n';

export const noticeFeedCopy = defineCopy('notice-feed', {
  loading: 'Loading notices',
  loadFailed: 'The notices could not be loaded.',
  tryAgain: 'Try again',
  none: 'No public notices are published',
  noneBody: 'Announcements, maintenance windows and incident reports appear here when one is published. None is published right now.',
  kind_announcement: 'Announcement',
  kind_maintenance: 'Maintenance',
  kind_incident: 'Incident',
  kind_changelog: 'Changelog',
  published: 'Published {date}',
  window: 'Window {from} to {to}',
  windowNotSet: 'not set',
  maintenance_scheduled: 'Scheduled',
  maintenance_in_progress: 'In progress',
  maintenance_completed: 'Completed',
  maintenance_end_unset: 'Started, end not set',
  maintenance_time_unset: 'Time not set',
  open: 'Read',
  detailNone: 'This notice is not published',
  detailNoneBody: 'No notice with this reference exists in the feed.',
});
