import { defineCopy } from '../../shared/i18n';

const messages = {
  open: 'Features and balances…',
  title: 'Features and balances',
  close: 'Close',
  balancesTitle: 'Held by this sub-account',
  balancesEmpty: 'This sub-account holds nothing.',
  assetsUnavailable: 'We could not read this sub-account’s balances. Try again later.',
  featuresTitle: 'Trading features',
  featuresBody: 'Choose what this sub-account may trade. This records your choice; it moves no money.',
  loading: 'Loading…',
  unpublished: 'Features are not offered yet. Nothing can be turned on until they are set up.',
  frozenNote: 'This sub-account is frozen. Its features cannot be changed.',
  feature_spot: 'Spot trading',
  feature_convert: 'Convert',
  feature_futures: 'Futures',
  feature_algo: 'Algo orders',
  feature_copy: 'Copy trading',
  on: 'On',
  off: 'Off',
  notOffered: 'Not offered for this kind of sub-account',
  futuresParked: 'Parked: futures needs derivatives eligibility on your main account, which cannot be read yet.',
  turnOn: 'Turn on {feature}',
  turnOff: 'Turn off {feature}',
  working: 'Working…',
  refusedUnset: 'Features are not offered yet.',
  refusedNotOffered: 'That feature is not offered for this kind of sub-account.',
  refusedUnavailable: 'That feature is parked until it can be offered.',
  refusedFrozen: 'This sub-account is frozen. Its features cannot be changed.',
  refusedRevoked: 'This sub-account was deleted.',
  refusedNotFound: 'That sub-account was not found.',
  refusedDelegated: 'Sign in on this device. An API key or a sub-account cannot change features.',
} as const;

export const subAccountFeaturesMessages = messages;
export const subAccountFeaturesCopy = defineCopy('account.subaccountFeatures', messages);
