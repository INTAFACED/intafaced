import { defineCopy } from '../../../shared/i18n';

// /developers/support (J-developer-17 #5; DV-portal-03): where to take an API problem and what to send with it. The contacts
// are the owner's own settings in the support service (support.contactChannels); blank reads "contact not set", never a guess.
export const developerSupportCopy = defineCopy('developers-support', {
  lead: 'When a call fails and the error page does not explain it, our support team can find the call from its request id.',
  sendTitle: 'What to send',
  sendRequestId: 'The request id: the x-request-id header of the reply, also requestId in every error body.',
  sendWhen: 'When you made the call, with its time zone.',
  sendCall: 'The method and path you called, and the status and error code you got back.',
  sendAddress: 'The IP address you called from, if the key has an IP list.',
  sendHeaders: 'The headers you sent, without their values for authorization and the signature headers.',
  neverTitle: 'Never send',
  neverKey: 'Never send a whole API key or its signing secret, here or anywhere. Send the key’s prefix (the first characters, ifc_…) only.',
  contactsTitle: 'Contacts',
  email: 'Email',
  phone: 'Phone',
  chatHours: 'Chat hours',
  contactNotSet: 'contact not set',
  contactLoading: 'Loading the contacts…',
  contactUnread: 'The contacts could not be loaded. The request form below still works.',
  ticketTitle: 'Open a request',
  ticketBody: 'A request reaches the support desk with your account attached. Put the request id in its subject or message.',
  ticketOpen: 'Open a request form',
  ticketSignIn: 'Sign in to open a request',
  ticketSubject: 'API problem: request id ',
  catalogueTitle: 'Check the error first',
  catalogueErrors: 'Error codes and what to do about each',
  catalogueAuth: 'Authentication and permission errors',
  catalogueStatus: 'Service status',
  back: 'Developer home',
});
