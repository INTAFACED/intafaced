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
  everyHost: 'Refused for every host:',
  TEST: 'TEST',
  testHosts: 'TEST · These are this machine’s own local sites, checked by the local test stack. No deployment is shown.',
  lastGood: 'Every host was served at {at}. That check has been out of date since {since}.',
});
