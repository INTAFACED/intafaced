import { defineCopy } from '../../shared/i18n';

// The trading checks on /verification (J-cex-spot-01 #3, OWNER 258 (4)). English source only. A held account reads a
// neutral "under review" that never says why; nothing here names a list, a check vendor or what was compared.
export const verificationTradingCopy = defineCopy('account.verificationTrading', {
  form: 'Trading checks',
  intro: 'To trade, give your legal name and confirm the country you live in. Nothing else is asked for.',
  legalName: 'Legal name',
  legalNameHint: 'Your full name, as you use it on official papers.',
  country: 'Country you live in',
  countryPick: 'Choose a country',
  confirm: 'I live in {country}',
  run: 'Run the checks',
  running: 'Running the checks',
  failedTitle: 'The trading checks could not be read',
  cleared: 'Verified for trading',
  clearedBody: 'Sign in again to trade with your new level.',
  held: 'Your account is under review',
  heldBody: 'A person is looking at your details. Nothing more is needed from you now, and we will email you when it is done.',
  paused: 'The trading checks are paused right now, so nothing was checked or changed. Try again later.',
  unconfigured: 'The trading checks are not available here, so nothing was checked or changed.',
  birthUnknown: 'We do not have your date of birth on record. Ask Support to add it, then run the checks again.',
  unconfirmed: 'Tick the box to confirm the country you live in.',
  countryInvalid: 'Choose the country you live in from the list.',
  regionBlocked: 'Trading is not offered for this country right now. Nothing was changed.',
  nameInvalid: 'Enter your legal name.',
  levelHeld: 'Your account is already verified for trading.',
  bankTitle: 'Verification for the bank',
  bankBody: 'Cards, bank accounts and higher limits need a fuller verification with your documents. Trading does not.',
  bankOpen: 'Start verification for the bank',
});
