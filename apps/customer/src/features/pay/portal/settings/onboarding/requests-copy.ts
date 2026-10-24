import { defineCopy } from '../../../../../shared/i18n';

/**
 * Words only the information requests use (the Compliance page): what INTAFACED asked for, by when, the answer and who
 * closed it. Plain English: what happened, why, what to do next.
 */
const en = {
  title: 'Information requests',
  body: 'When INTAFACED needs something more to verify your business, it asks here, with a date to answer by.',
  empty: 'INTAFACED hasn’t asked for anything more.',
  pastDueBanner: 'An information request is past its due date. Answer it below so verification can continue.',
  state_open: 'Open',
  state_answered: 'Answered',
  state_closed: 'Closed',
  pastDue: 'Past due',
  dueBy: 'Answer by',
  asked: 'Asked',
  yourAnswer: 'Your answer',
  answeredOn: 'Sent',
  fileSent: 'File sent: {size}, passed the malware check',
  closedBy: 'Closed by INTAFACED reviewer {who}',
  closedOn: 'Closed',
  closeNote: 'INTAFACED’s note',
  noteLabel: 'Your note',
  fileLabel: 'Choose a file to send with your answer',
  send: 'Send answer',
  sending: 'Sending…',
  sent: 'Your answer was sent.',
  needSomething: 'Write a note or choose a file first.',
  limits: 'Files up to {size}. Accepted: {types}. Every file is checked for malware before it is kept.',
  noScanner: 'Files can’t be sent right now because the malware check isn’t connected. You can still answer with a note.',
  noRules: 'Files can’t be sent because no upload limits are published. You can still answer with a note.',

  // ---- plain words for refusals
  rInfected: 'The malware check found a threat in this file, so it wasn’t kept. Send a clean copy.',
  rScanUnset: 'Files can’t be checked for malware right now, so nothing was sent. Answer with a note instead.',
  rScanFailed: 'The malware check didn’t answer, so nothing was sent. Try again in a moment.',
  rAnswered: 'This request already has your answer. INTAFACED will close it once it has looked.',
  rClosed: 'INTAFACED closed this request, so it takes no answer.',
  rNotFound: 'This request can’t be found. Reload the page.',
  rEmpty: 'Write a note or choose a file first.',
  rFileInvalid: 'The file couldn’t be read. Choose it again.',
} as const;

export const requestsCopy = defineCopy('pay.portal.settings.requests', en);
/** The wording as written, for the copy lint. */
export const requestsMessages: Record<string, string> = en;
