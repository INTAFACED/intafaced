import { defineCopy } from '../../shared/i18n';

// English source only. Plain words; no mention of internal services.
export const contactCopy = defineCopy('public-contact', {
  titleSignedOut: 'Cannot sign in? Write to us',
  titleRecovery: 'Locked out? A person can help',
  bodySignedOut:
    'Support requests belong to a signed-in account, so you cannot open one from here. Send us an email instead and a person will read it.',
  bodyRecovery: 'If the reset above says it isn’t switched on, a person has to help. Support requests need a sign-in, so email us instead.',
  includeHeading: 'In your email, tell us',
  includeHandle: 'The email or handle on your account.',
  includeWhat: 'What happened, and what you saw on the screen.',
  includeWhen: 'When it happened, and which device or browser you used.',
  neverShare: 'Never write your password, recovery codes or one-time codes. We will never ask for them.',
  write: 'Email support',
  addressLabel: 'Or write to',
  addressNotSet: 'Support email is not set.',
  addressNotSetNote: 'No address has been published, so there is no email link on this page.',
  loadingContact: 'Loading contact details…',
  phoneLabel: 'Phone:',
  phoneNotSet: 'Support phone is not set.',
  hoursLabel: 'Chat hours:',
  contactUnread: 'The published contact details could not be read just now, so only what this page was built with is shown.',
  noForm: 'This opens a draft in your email app. Nothing is sent from this page.',
  noPromise: 'We cannot promise how fast we reply.',
  titleSignedIn: 'You are signed in',
  bodySignedIn: 'Open the support desk to start a request, follow a reply or search the help articles.',
  openDesk: 'Open the support desk',
  mailSubject: 'I cannot sign in to my account',
  mailSubjectGeneral: 'Question for the INTAFACED team',
  mailBody: 'My email or handle:\n\nWhat happened:\n\nWhat I saw on the screen:\n\n(Please do not write your password or any codes here.)',
});
