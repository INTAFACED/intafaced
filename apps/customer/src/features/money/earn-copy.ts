import { defineCopy } from '../../shared/i18n';
export const earnCopy = defineCopy('customer.money.earn', {
  description: 'Your principal, maturity and configured pools. Accrued interest and complete position history are unavailable.',
  locked: 'Fixed-term principal cannot be withdrawn before maturity.',
  maturityMissing: 'Maturity is unavailable. Withdrawal remains unavailable until a valid maturity is returned.',
  noFixed: 'No fixed maturity supplied',
  position: 'Position reference',
  readFailed: 'Current {subject} could not be checked. No request was sent. Close this review and refresh before trying again.',
  subjectPosition: 'owned position and maturity',
  subjectPool: 'configured pool terms',
  subjectPolicy: 'automation configuration',
  changed: 'The reviewed position, pool or configuration has changed. No request was sent. Close this review and refresh.',
  thresholdHint: 'Keep this exact positive quantity in your main account. This instruction reserves no funds.',
  keepAvailable: 'Keep available',
  withdrawalOutcome:
    'A confirmed response is required. An unknown withdrawal remains guarded; refreshing positions cannot establish its outcome.',
  automationDisabled: 'Automated deposits are disabled by current Bank configuration. Existing instructions remain available below.',
  unavailableHistory: 'This bounded list contains active positions only. Pending/closed history and earned interest are unavailable.',
  refresh: 'Refresh',
} as const);
