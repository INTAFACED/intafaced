import { defineCopy } from '../../shared/i18n';

export const verificationCapabilitiesCopy = defineCopy('account.verificationCapabilities', {
  title: 'Capabilities',
  intro: 'What your verification lets you do. An approved level turns on what it includes at once.',
  failedTitle: 'Capabilities could not be read',
  unmapped: 'No capabilities are linked to verification levels in this build, so an approval turns none on.',
  custody_crypto: 'Hold crypto',
  custody_fiat: 'Hold cash',
  transfer_crypto: 'Send and receive crypto',
  transfer_fiat: 'Send and receive cash',
  trade_crypto: 'Trade crypto',
  unrequested: 'Not requested',
  pending: 'Pending review',
  active: 'Active',
  inactive: 'Switched off',
  grantedAt: 'Comes with level {level}',
  notGranted: 'No level includes this',
  inactiveHelp: 'Compliance switched this off. A new request does not turn it back on. Ask Support why.',
  none: 'Not verified',
  basic: 'Basic',
  full: 'Full',
  institutional: 'Institutional',
});
