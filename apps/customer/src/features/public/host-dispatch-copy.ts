import { defineCopy } from '../../shared/i18n';

export const hostDispatchCopy = defineCopy('public.host-dispatch', {
  title: 'Where this app is served',
  checking: 'Reading the host check…',
  checkedAt: 'Checked',
  apex: 'Apex host',
  app: 'App host',
  join: 'Join host',
  served: 'served',
  notNamed: 'not named',
  'host.receipt_missing': 'This deployment has published no host check, so no host is shown as served.',
  'host.receipt_invalid': 'The published host check could not be read, so no host is shown as served.',
  'host.receipt_unreadable': 'The host check could not be fetched, so no host is shown as served.',
  lastGood: 'Every host was last served at {at}; that check is out of date.',
});
