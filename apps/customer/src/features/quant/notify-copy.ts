import { defineCopy } from '../../shared/i18n';

// A strategy's notification channels and fill alerts (AL-live-06, AL-alerts-01; J-algo-dev-04 #5, #6, #7).
const en = {
  channelsTitle: 'Notifications',
  channelsIntro:
    'Choose where this strategy’s notices go. Notices come from the server, so they arrive with the app closed. Every notice says paper: nothing here is a real order.',
  inapp: 'In the app',
  inappAlways: 'In the app (always on)',
  email: 'Email',
  sms: 'Text message',
  push: 'Push to this device',
  webhook: 'My own webhook',
  chat: 'A chat app',
  save: 'Save notification channels',
  saving: 'Saving',
  saved: 'Saved. Notices go to: {channels}.',
  current: 'Notices go to: {channels}.',
  vendorNotice:
    '{channel} needs a delivery provider, which is not connected in this build. The notice still appears in the app, and the {channel} attempt is recorded as not sent.',
  unavailable: '{channel} has no sender in this build, so it cannot be chosen. Nothing was saved.',
  alertsTitle: 'Fill alerts',
  alertsIntro:
    'A fill alert sends a notice each time a paper run of one version fills an order, with your own message. It watches that version only: changing the strategy makes a new version, which needs its own alert.',
  noAlerts: 'This strategy has no fill alert yet.',
  add: 'Add a fill alert',
  addTitle: 'Add a fill alert',
  version: 'Version',
  versionOf: 'Version {version}',
  template: 'Message',
  fields: 'Fields you can use: {fields}. Nothing else in braces is allowed.',
  preview: 'Preview with TEST values: {text}',
  create: 'Save alert',
  creating: 'Saving',
  cancel: 'Cancel',
  created: 'The fill alert is saved for version {version}.',
  invalid: 'The message cannot be used: {detail}.',
  event: 'Event',
  onFill: 'Each fill',
  createdAt: 'Added (UTC)',
} as const;

export const notifyCopy = defineCopy('quant.notify', en);
