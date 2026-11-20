import { defineCopy } from '../../shared/i18n';

/** The API version panel on /uc/safe/api-keys (J-developer-16 #5). */
const messages = {
  title: 'API version',
  intro:
    'A program names the API version it was written for in the intafaced-version header. A key call without the header uses this account default. With neither, the call is refused, never answered as the newest version.',
  defaultLabel: 'Account default',
  notSet: 'not set',
  setAt: 'set {when}',
  versionsTitle: 'Published versions',
  newest: 'newest',
  choose: 'Version to use by default',
  save: 'Set as default',
  saving: 'Setting the default',
  saved: 'The account default is now {version}.',
  unchanged: 'The account default was already {version}. Nothing changed.',
  loading: 'Reading the account default',
  deprecationsTitle: 'Deprecated fields',
  deprecationsNone: 'No field is deprecated.',
  colField: 'Field',
  colReplacement: 'Use instead',
  colSince: 'Deprecated in',
  colRemoval: 'Removal date',
  removalNotSet: 'removal date not set',
  deprecationsNote: 'A reply to a request that sends a deprecated field carries the Deprecation header and an intafaced-advisories entry.',
  'refused.version.unknown': 'That is not a published API version. Nothing changed.',
  'refused.identity.api_version_session_only': 'An API key cannot change the API version. Sign in on a device. Nothing changed.',
} as const;

export const apiVersionCopy = defineCopy('account.api-version', messages);
