import { defineCopy } from '../../../shared/i18n';

/**
 * Copy for the wallet room's Accounts and Safety sections (D-portfolio-wallet-02, D-developer-compliance-02). English only
 * for now. Nothing here promises recovery, claims an audit or names a vendor.
 */
const en = {
  // Accounts
  subAccountsTitle: 'Sub-accounts',
  subAccountsNote: 'This wallet and its smart account on this network. Your wallet signs for both; we hold no key.',
  accountsWrongNetwork: 'Your wallet is on another network. Switch it to this network to see its accounts here.',
  hdr_account: 'Account',
  hdr_address: 'Address',
  hdr_status: 'Status',
  accountWallet: 'This wallet',
  accountWalletStatus: 'Connected: it signs for every account here',
  accountSmart: 'Smart account',
  accountDeployed: 'Deployed',
  accountNotDeployed: 'Not deployed: it is created the first time you use it',
  accountFactoryUnset: 'Not available: the smart account factory is not deployed on this network.',
  accountReading: 'Reading the network…',
  custodialNote: 'Exchange sub-accounts are a separate thing and are not offered, so there is nothing to open for them here.',
  multisigTitle: 'Multi-signature accounts',
  multisigNote:
    'A shared account needs a set number of its signers to approve each action, each with their own wallet. No one can approve for another signer.',
  multisigCreate: 'Create a multi-signature account',
  multisigBlocked:
    'The multi-signature contract is not deployed on this network, so a shared account cannot be made. How many signers it may have is also waiting for a decision.',
  // Safety
  safetyTitle: 'Stay safe',
  safetyNote: 'Habits that keep a wallet safe. Each one opens the control it is about.',
  lesson_address: 'Check an address before you send: look it up and read its risk card.',
  lesson_addressLink: 'Look up an address',
  lesson_testSend: 'Send a small amount first to an address you have not used before.',
  lesson_testSendLink: 'Send',
  lesson_book: 'Save the addresses you trust, so a look-alike stands out.',
  lesson_bookLink: 'Address book',
  lesson_approvals: 'Allow a contract only the amount you need, and revoke what you no longer use.',
  lesson_approvalsLink: 'Approvals',
  lesson_sessions: 'Give a session key a spending cap and an expiry, and revoke it when you are done.',
  lesson_sessionsLink: 'Session keys',
  lesson_tokens: 'Check a token before you buy it: its page shows what is known about it and what is not.',
  lesson_tokensLink: 'Tokens',
  lesson_audit: 'Read the audit state before you trust a contract with your funds.',
  lesson_auditLink: 'Audit room',
  neverAsk: 'We will never ask for your recovery phrase or private key. Anyone who asks for them is trying to steal from you.',
  compromiseTitle: 'If your wallet is compromised',
  compromiseNote:
    'Activity you did not make means the key of your wallet is known to someone else. Stop signing anything with it, then do these steps in order.',
  compromise_sessions: 'Revoke session keys',
  compromise_sessionsWhy: 'so no app or key can act for you any more.',
  compromise_approvals: 'Revoke approvals',
  compromise_approvalsWhy: 'so no contract can move your tokens.',
  compromise_move: 'Move your funds',
  compromise_moveWhy: 'to a new wallet whose recovery phrase only you have seen, then stop using this address.',
  compromiseNoRecovery: 'We cannot reverse a transaction or recover funds sent from a compromised wallet.',
  disclosureTitle: 'Security disclosures',
  bountyUnset: 'No bounty programme is running.',
  disclosureUnset: 'The disclosure policy is not published.',
  disclosureAudit: 'What has and has not been audited:',
} as const;

export const safetyCopy = defineCopy('customer.protocol.wallet.safety', en);
