import type { DeskLink, Unavailable } from './types';

/**
 * What the Accounts desk cannot do yet, and where to go instead. Shown under the lookup so nobody reads an empty page as
 * "there is nothing to find". Restricting an identity already revokes its sessions and credentials at identity, so a
 * separate session-kill control is not missing for that case.
 */
export const ACCOUNT_GAPS: readonly Unavailable[] = [
  {
    id: 'accounts.list',
    label: 'A list or search of restricted accounts',
    reason:
      'Identity records each restriction in the account’s control history but has no read that lists restricted accounts. Find a customer by handle or email above, or inspect an account by its id.',
    need: 18,
  },
  {
    id: 'accounts.metrics',
    label: 'Counts of accounts by status, sign-ups and verification',
    reason: 'Identity exposes no aggregate read for operators, so there is no figure to show and none is estimated.',
    need: 28,
  },
  {
    id: 'accounts.sessions',
    label: 'Another person’s sessions, devices and security events',
    reason:
      'listSessions, revokeAllSessions and panicRevoke act only on the signed-in user’s own account. The operator lever that exists is Restrict access, which revokes sessions and credentials.',
    need: 28,
  },
];

export const ACCOUNT_LINKS: readonly DeskLink[] = [
  {
    href: '/tools',
    label: 'KYC queue (Operator tools)',
    why: 'Pending KYC records are listed there, and approved or rejected with the second factor.',
  },
  { href: '/support', label: 'Support queue', why: 'Account problems arrive as tickets.' },
];
