import { defineCopy } from '../../../shared/i18n';

// The API explorer's words (/developers/explorer, DV-console-01, J-developer-15 #7). It reads with any key and writes
// only with a sandbox key; the edge refuses the explorer's write with a live key, and the page shows that refusal.
export const explorerCopy = defineCopy('developers-explorer', {
  lead: 'Build a request to the public API, see it as code, and send it with one of your keys. With a live key the explorer only reads. A write runs only with a sandbox key, at your sandbox address.',
  keyLabel: 'API key',
  keyHint: 'Paste a key. It stays in this page and is sent only with this request. A key starting ifc_test_ is a sandbox key.',
  keyLive: 'Live key: reads only.',
  keySandbox: 'Sandbox key: sent to your sandbox address.',
  requestLabel: 'Request',
  'route.balance': 'Read the account balance',
  'route.payments': 'List your business’s payments',
  'route.payment-create': 'Create a payment (write)',
  merchantLabel: 'Business id',
  merchantHint: 'Your business’s id, from the business page.',
  bodyLabel: 'Body (JSON)',
  bodyHint: 'For a sandbox card payment, take a card token from the sandbox’s test values page.',
  bodyInvalid: 'The body is not valid JSON. Nothing was sent.',
  codeTitle: 'As code',
  send: 'Send',
  sending: 'Sending…',
  needKey: 'Paste a key first. Nothing was sent.',
  sandboxUnread: 'Sign in to send with a sandbox key: the sandbox address comes from your sandboxes. Nothing was sent.',
  sandboxUnset: 'The sandbox address is not set, so a sandbox key cannot be used. Nothing was sent.',
  resultTitle: 'Answer',
  resultStatus: 'Status {status}',
  resultRefused: 'Refused: {code}',
  resultFailed: 'The request did not reach the API. Nothing is known to have run.',
});

export type ExplorerCopyKey = Parameters<ReturnType<typeof explorerCopy.useCopy>['t']>[0];
