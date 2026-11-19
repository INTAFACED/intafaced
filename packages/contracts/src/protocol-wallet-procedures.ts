import { defineProcedure, NO_INPUT, type RefusalStatus, type Refusals } from './procedure.js';
import {
  protocolAddressBookAddContactInputSchema,
  protocolAddressBookCreateGroupInputSchema,
  protocolAddressBookGroupInputSchema,
  protocolAddressBookListInputSchema,
  protocolAddressBookListOutputSchema,
  protocolAddressBookRemoveContactInputSchema,
  protocolAddressBookRemovedOutputSchema,
  protocolAddressBookRemoveGroupInputSchema,
  protocolContactSchema,
  protocolWalletGroupSchema,
  protocolWalletSessionChallengeInputSchema,
  protocolWalletSessionChallengeOutputSchema,
  protocolWalletSessionOpenInputSchema,
  protocolWalletSessionOpenOutputSchema,
} from './protocol-address-book.js';
import {
  protocolAddressReportInputSchema,
  protocolAddressReportReceiptSchema,
  protocolAddressRiskInputSchema,
  protocolAddressRiskSchema,
  protocolComplianceLabelApproveInputSchema,
  protocolComplianceLabelAskInputSchema,
  protocolComplianceReportsOutputSchema,
  protocolComplianceReviewSchema,
  protocolNameTagApproveInputSchema,
  protocolNameTagRequestInputSchema,
  protocolNameTagRequestSchema,
  protocolNameTagsOutputSchema,
  protocolOnboardingApproveInputSchema,
  protocolOnboardingChecklistSchema,
  protocolOnboardingOpenInputSchema,
  protocolOnboardingOutputSchema,
  protocolTierApproveInputSchema,
  protocolTierAskInputSchema,
  protocolTierRemoveInputSchema,
  protocolTokenTierSchema,
  protocolTokenTiersOutputSchema,
} from './protocol-address-risk.js';
import {
  protocolEmbeddedWalletCreateInputSchema,
  protocolEmbeddedWalletCreateOutputSchema,
  protocolEmbeddedWalletStatusOutputSchema,
} from './protocol-embedded-wallet.js';
import {
  protocolVenueWalletAddressInputSchema,
  protocolVenueWalletAuthorizedOutputSchema,
  protocolVenueWalletAuthorizeInputSchema,
  protocolVenueWalletChallengeInputSchema,
  protocolVenueWalletChallengeOutputSchema,
  protocolVenueWalletConnectionSchema,
  protocolVenueWalletDisconnectedOutputSchema,
  protocolVenueWalletOpenInputSchema,
  protocolVenueWalletStatusOutputSchema,
} from './protocol-venue-wallet.js';

/**
 * svc-protocol's wallet and trust calls, one record per call: the wallet session and address book
 * (`walletSession.*`, `addressBook.*`), the address risk card and its reports (`addressRisk.read`,
 * `addressReports.submit`), the operator trust desk (`compliance.*`), the venue wallet connection (`venueWallet.*`) and
 * the embedded wallet (`embeddedWallet.*`). The service mounts each from here, so its path, guard, input, output and
 * named refusals are this file. Each refusal is sent with its code leading the message and the code in `cause.code`.
 */

const base = { service: 'svc-protocol', module: 'protocol', transport: 'trpc' } as const;

/** Public on the Protocol plane: no sign-in, but a region the module is not served in is refused first. */
const JURISDICTION = { caller: 'jurisdiction', module: 'protocol', plane: 'protocol' } as const;
/** A signed-in caller holding `protocol:read`. */
const SIGNED_IN = { caller: 'scope', scope: 'protocol:read', module: 'protocol', plane: 'protocol' } as const;
/** A signed-in person (never a service) holding `protocol:read`. */
const PERSON = { ...SIGNED_IN, person: true } as const;
const OPERATOR_READ = { caller: 'scope', scope: 'admin:read', module: 'protocol', plane: 'protocol' } as const;
const OPERATOR_WRITE = { caller: 'scope', scope: 'admin:write', module: 'protocol', plane: 'protocol' } as const;

const refuse = (status: RefusalStatus, ...codes: string[]): Refusals => Object.fromEntries(codes.map((c) => [c, status]));
const join = (...parts: Refusals[]): Refusals => Object.freeze(Object.assign({}, ...parts) as Refusals);

const ADDRESS = '0x00000000000000000000000000000000000a11ce';
const ID = '00000000-0000-4000-8000-000000000001';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const SESSION = 'TEST-session';

// ── walletSession / addressBook (`addressBookTrpcError`) ─────────────────────────────────────────────────────────

const SESSION_UNSET = refuse('PRECONDITION_FAILED', 'protocol.wallet_session_unset');
/** Every `addressBook.*` call turns its token into the owning address first. */
const BOOK_SESSION = join(SESSION_UNSET, refuse('UNAUTHORIZED', 'protocol.wallet_session_invalid'));

export const PROTOCOL_WALLET_SESSION_CHALLENGE = defineProcedure({
  ...base,
  name: 'protocol.walletSession.challenge',
  kind: 'mutation',
  path: 'walletSession.challenge',
  access: JURISDICTION,
  refusals: join(SESSION_UNSET, refuse('BAD_REQUEST', 'protocol.wallet_session_origin_unlisted')),
  input: protocolWalletSessionChallengeInputSchema,
  output: protocolWalletSessionChallengeOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, origin: 'https://example.com' } },
    { verdict: 'refuse', input: { address: '0x12', origin: 'https://example.com' } },
    { verdict: 'refuse', input: { address: ADDRESS } },
  ],
});

export const PROTOCOL_WALLET_SESSION_OPEN = defineProcedure({
  ...base,
  name: 'protocol.walletSession.open',
  kind: 'mutation',
  path: 'walletSession.open',
  access: JURISDICTION,
  refusals: join(
    SESSION_UNSET,
    refuse('UNAUTHORIZED', 'protocol.wallet_challenge_invalid'),
    refuse('FORBIDDEN', 'protocol.wallet_signature_not_owner'),
  ),
  input: protocolWalletSessionOpenInputSchema,
  output: protocolWalletSessionOpenOutputSchema,
  samples: [
    { verdict: 'accept', input: { challenge: 'TEST-challenge', signature: SIGNATURE } },
    { verdict: 'refuse', input: { challenge: 'TEST-challenge', signature: '0xab' } },
    { verdict: 'refuse', input: { signature: SIGNATURE } },
  ],
});

export const PROTOCOL_ADDRESS_BOOK_LIST = defineProcedure({
  ...base,
  name: 'protocol.addressBook.list',
  kind: 'mutation',
  path: 'addressBook.list',
  access: JURISDICTION,
  refusals: BOOK_SESSION,
  input: protocolAddressBookListInputSchema,
  output: protocolAddressBookListOutputSchema,
  samples: [
    { verdict: 'accept', input: { session: SESSION } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { session: '' } },
  ],
});

export const PROTOCOL_ADDRESS_BOOK_ADD_CONTACT = defineProcedure({
  ...base,
  name: 'protocol.addressBook.addContact',
  kind: 'mutation',
  path: 'addressBook.addContact',
  access: JURISDICTION,
  refusals: join(
    BOOK_SESSION,
    refuse('PRECONDITION_FAILED', 'protocol.address_book_max_contacts_unset'),
    refuse('CONFLICT', 'protocol.address_book_full', 'protocol.contact_duplicate'),
    refuse('BAD_REQUEST', 'protocol.contact_label_invalid', 'protocol.contact_address_invalid', 'protocol.contact_self'),
  ),
  input: protocolAddressBookAddContactInputSchema,
  output: protocolContactSchema,
  samples: [
    { verdict: 'accept', input: { session: SESSION, label: 'TEST', address: ADDRESS } },
    // Loose on the wire: the service answers a wrong address with its own code, never as a malformed input.
    { verdict: 'accept', input: { session: SESSION, label: 'TEST', address: 'not-an-address' } },
    { verdict: 'refuse', input: { session: SESSION, label: 7, address: ADDRESS } },
    { verdict: 'refuse', input: { label: 'TEST', address: ADDRESS } },
  ],
});

export const PROTOCOL_ADDRESS_BOOK_REMOVE_CONTACT = defineProcedure({
  ...base,
  name: 'protocol.addressBook.removeContact',
  kind: 'mutation',
  path: 'addressBook.removeContact',
  access: JURISDICTION,
  refusals: join(BOOK_SESSION, refuse('NOT_FOUND', 'protocol.contact_not_found')),
  input: protocolAddressBookRemoveContactInputSchema,
  output: protocolAddressBookRemovedOutputSchema,
  samples: [
    { verdict: 'accept', input: { session: SESSION, id: ID } },
    { verdict: 'refuse', input: { session: SESSION, id: 'x' } },
  ],
});

export const PROTOCOL_ADDRESS_BOOK_CREATE_GROUP = defineProcedure({
  ...base,
  name: 'protocol.addressBook.createGroup',
  kind: 'mutation',
  path: 'addressBook.createGroup',
  access: JURISDICTION,
  refusals: join(
    BOOK_SESSION,
    refuse('PRECONDITION_FAILED', 'protocol.wallet_groups_max_unset'),
    refuse('CONFLICT', 'protocol.wallet_groups_full', 'protocol.group_name_duplicate'),
    refuse(
      'BAD_REQUEST',
      'protocol.group_name_invalid',
      'protocol.group_members_empty',
      'protocol.group_member_unknown',
      'protocol.contact_address_invalid',
    ),
  ),
  input: protocolAddressBookCreateGroupInputSchema,
  output: protocolWalletGroupSchema,
  samples: [
    { verdict: 'accept', input: { session: SESSION, name: 'TEST', members: [ADDRESS] } },
    { verdict: 'accept', input: { session: SESSION, name: 'TEST', members: [] } },
    { verdict: 'refuse', input: { session: SESSION, name: 'TEST', members: ADDRESS } },
  ],
});

export const PROTOCOL_ADDRESS_BOOK_GROUP = defineProcedure({
  ...base,
  name: 'protocol.addressBook.group',
  kind: 'mutation',
  path: 'addressBook.group',
  access: JURISDICTION,
  refusals: join(BOOK_SESSION, refuse('NOT_FOUND', 'protocol.group_not_found')),
  input: protocolAddressBookGroupInputSchema,
  output: protocolWalletGroupSchema,
  samples: [
    { verdict: 'accept', input: { session: SESSION, id: ID } },
    { verdict: 'refuse', input: { session: SESSION } },
  ],
});

export const PROTOCOL_ADDRESS_BOOK_REMOVE_GROUP = defineProcedure({
  ...base,
  name: 'protocol.addressBook.removeGroup',
  kind: 'mutation',
  path: 'addressBook.removeGroup',
  access: JURISDICTION,
  refusals: join(BOOK_SESSION, refuse('NOT_FOUND', 'protocol.group_not_found')),
  input: protocolAddressBookRemoveGroupInputSchema,
  output: protocolAddressBookRemovedOutputSchema,
  samples: [
    { verdict: 'accept', input: { session: SESSION, id: ID } },
    { verdict: 'refuse', input: { session: SESSION, id: 'x' } },
  ],
});

// ── addressRisk / addressReports ─────────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_ADDRESS_RISK_READ = defineProcedure({
  ...base,
  name: 'protocol.addressRisk.read',
  kind: 'query',
  path: 'addressRisk.read',
  access: JURISDICTION,
  refusals: join(),
  input: protocolAddressRiskInputSchema,
  output: protocolAddressRiskSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS } },
    { verdict: 'refuse', input: { address: '0x12' } },
  ],
});

export const PROTOCOL_ADDRESS_REPORTS_SUBMIT = defineProcedure({
  ...base,
  name: 'protocol.addressReports.submit',
  kind: 'mutation',
  path: 'addressReports.submit',
  access: SIGNED_IN,
  refusals: join(
    refuse('CONFLICT', 'protocol.reports.duplicate'),
    refuse('BAD_REQUEST', 'protocol.reports.address_invalid', 'protocol.reports.evidence_invalid'),
  ),
  input: protocolAddressReportInputSchema,
  output: protocolAddressReportReceiptSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, kind: 'scam' } },
    { verdict: 'accept', input: { address: ADDRESS, kind: 'phishing', evidenceUrl: 'https://example.com/TEST', note: 'TEST' } },
    { verdict: 'refuse', input: { address: ADDRESS, kind: 'spam' } },
    { verdict: 'refuse', input: { kind: 'scam' } },
  ],
});

// ── compliance (`complianceTrpc`: an unknown item is NOT_FOUND, every other refusal CONFLICT) ─────────────────────────

export const PROTOCOL_COMPLIANCE_REPORTS_LIST = defineProcedure({
  ...base,
  name: 'protocol.compliance.reports.list',
  kind: 'query',
  path: 'compliance.reports.list',
  access: OPERATOR_READ,
  refusals: join(),
  input: NO_INPUT,
  output: protocolComplianceReportsOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_COMPLIANCE_LABELS_ASK = defineProcedure({
  ...base,
  name: 'protocol.compliance.labels.ask',
  kind: 'mutation',
  path: 'compliance.labels.ask',
  access: OPERATOR_WRITE,
  refusals: join(refuse('NOT_FOUND', 'protocol.compliance.report_unknown'), refuse('CONFLICT', 'protocol.compliance.review_pending')),
  input: protocolComplianceLabelAskInputSchema,
  output: protocolComplianceReviewSchema,
  samples: [
    { verdict: 'accept', input: { reportId: ID, kind: 'phishing', reason: 'TEST' } },
    { verdict: 'refuse', input: { reportId: ID, kind: 'verdict', reason: 'TEST' } },
    { verdict: 'refuse', input: { reportId: ID, kind: 'phishing', reason: '' } },
  ],
});

export const PROTOCOL_COMPLIANCE_LABELS_APPROVE = defineProcedure({
  ...base,
  name: 'protocol.compliance.labels.approve',
  kind: 'mutation',
  path: 'compliance.labels.approve',
  access: OPERATOR_WRITE,
  refusals: join(refuse('NOT_FOUND', 'protocol.compliance.review_unknown'), refuse('CONFLICT', 'protocol.compliance.same_reviewer')),
  input: protocolComplianceLabelApproveInputSchema,
  output: protocolComplianceReviewSchema,
  samples: [
    { verdict: 'accept', input: { reviewId: ID } },
    { verdict: 'refuse', input: { reviewId: 1 } },
  ],
});

export const PROTOCOL_COMPLIANCE_TIERS_LIST = defineProcedure({
  ...base,
  name: 'protocol.compliance.tiers.list',
  kind: 'query',
  path: 'compliance.tiers.list',
  access: OPERATOR_READ,
  refusals: join(),
  input: NO_INPUT,
  output: protocolTokenTiersOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_COMPLIANCE_TIERS_ASK = defineProcedure({
  ...base,
  name: 'protocol.compliance.tiers.ask',
  kind: 'mutation',
  path: 'compliance.tiers.ask',
  access: OPERATOR_WRITE,
  refusals: refuse('CONFLICT', 'protocol.tiers.request_pending'),
  input: protocolTierAskInputSchema,
  output: protocolTokenTierSchema,
  samples: [
    { verdict: 'accept', input: { token: ADDRESS, tier: 'verified', reason: 'TEST' } },
    { verdict: 'refuse', input: { token: ADDRESS, tier: 'trusted', reason: 'TEST' } },
    { verdict: 'refuse', input: { token: '', tier: 'verified', reason: 'TEST' } },
  ],
});

export const PROTOCOL_COMPLIANCE_TIERS_APPROVE = defineProcedure({
  ...base,
  name: 'protocol.compliance.tiers.approve',
  kind: 'mutation',
  path: 'compliance.tiers.approve',
  access: OPERATOR_WRITE,
  refusals: join(refuse('NOT_FOUND', 'protocol.tiers.request_unknown'), refuse('CONFLICT', 'protocol.tiers.same_approver')),
  input: protocolTierApproveInputSchema,
  output: protocolTokenTierSchema,
  samples: [
    { verdict: 'accept', input: { requestId: ID } },
    { verdict: 'refuse', input: {} },
  ],
});

export const PROTOCOL_COMPLIANCE_TIERS_REMOVE = defineProcedure({
  ...base,
  name: 'protocol.compliance.tiers.remove',
  kind: 'mutation',
  path: 'compliance.tiers.remove',
  access: OPERATOR_WRITE,
  refusals: refuse('CONFLICT', 'protocol.tiers.none_set'),
  input: protocolTierRemoveInputSchema,
  output: protocolTokenTierSchema,
  samples: [
    { verdict: 'accept', input: { token: ADDRESS, reason: 'TEST' } },
    { verdict: 'refuse', input: { token: ADDRESS, reason: '' } },
  ],
});

export const PROTOCOL_COMPLIANCE_ONBOARDING_LIST = defineProcedure({
  ...base,
  name: 'protocol.compliance.onboarding.list',
  kind: 'query',
  path: 'compliance.onboarding.list',
  access: OPERATOR_READ,
  refusals: join(),
  input: NO_INPUT,
  output: protocolOnboardingOutputSchema,
  samples: [{ verdict: 'accept' }],
});

const BLANK_CHECKLIST = {
  pool: 'TEST',
  legalEntity: null,
  tokenContract: null,
  checkerAddress: null,
  wrapperAddress: null,
  routingRegistration: null,
} as const;

export const PROTOCOL_COMPLIANCE_ONBOARDING_OPEN = defineProcedure({
  ...base,
  name: 'protocol.compliance.onboarding.open',
  kind: 'mutation',
  path: 'compliance.onboarding.open',
  access: OPERATOR_WRITE,
  refusals: refuse('CONFLICT', 'protocol.onboarding.duplicate'),
  input: protocolOnboardingOpenInputSchema,
  output: protocolOnboardingChecklistSchema,
  samples: [
    { verdict: 'accept', input: BLANK_CHECKLIST },
    { verdict: 'accept', input: { ...BLANK_CHECKLIST, legalEntity: 'TEST', tokenContract: ADDRESS } },
    { verdict: 'refuse', input: { ...BLANK_CHECKLIST, pool: '' } },
    { verdict: 'refuse', input: { ...BLANK_CHECKLIST, tokenContract: '0x12' } },
  ],
});

export const PROTOCOL_COMPLIANCE_ONBOARDING_APPROVE = defineProcedure({
  ...base,
  name: 'protocol.compliance.onboarding.approve',
  kind: 'mutation',
  path: 'compliance.onboarding.approve',
  access: OPERATOR_WRITE,
  refusals: join(
    refuse('NOT_FOUND', 'protocol.onboarding.unknown'),
    refuse('CONFLICT', 'protocol.onboarding.same_approver', 'protocol.onboarding.incomplete'),
  ),
  input: protocolOnboardingApproveInputSchema,
  output: protocolOnboardingChecklistSchema,
  samples: [
    { verdict: 'accept', input: { checklistId: ID, reason: 'TEST' } },
    { verdict: 'refuse', input: { checklistId: ID } },
  ],
});

export const PROTOCOL_COMPLIANCE_NAME_TAGS_LIST = defineProcedure({
  ...base,
  name: 'protocol.compliance.nameTags.list',
  kind: 'query',
  path: 'compliance.nameTags.list',
  access: OPERATOR_READ,
  refusals: join(),
  input: NO_INPUT,
  output: protocolNameTagsOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_COMPLIANCE_NAME_TAGS_REQUEST = defineProcedure({
  ...base,
  name: 'protocol.compliance.nameTags.request',
  kind: 'mutation',
  path: 'compliance.nameTags.request',
  access: OPERATOR_WRITE,
  refusals: refuse('CONFLICT', 'protocol.nametags.request_pending'),
  input: protocolNameTagRequestInputSchema,
  output: protocolNameTagRequestSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, tag: 'TEST', reason: 'TEST' } },
    { verdict: 'refuse', input: { address: ADDRESS, tag: '', reason: 'TEST' } },
  ],
});

export const PROTOCOL_COMPLIANCE_NAME_TAGS_APPROVE = defineProcedure({
  ...base,
  name: 'protocol.compliance.nameTags.approve',
  kind: 'mutation',
  path: 'compliance.nameTags.approve',
  access: OPERATOR_WRITE,
  refusals: join(
    refuse('NOT_FOUND', 'protocol.nametags.request_unknown'),
    refuse('CONFLICT', 'protocol.nametags.no_proof', 'protocol.nametags.same_approver'),
  ),
  input: protocolNameTagApproveInputSchema,
  output: protocolNameTagRequestSchema,
  samples: [
    { verdict: 'accept', input: { requestId: ID } },
    { verdict: 'refuse', input: { requestId: 'x' } },
  ],
});

// ── venueWallet (`venueWalletTrpcError`) ─────────────────────────────────────────────────────────────────────────

const VENUE_SANCTIONS = join(
  refuse('PRECONDITION_FAILED', 'protocol.wallet_sanctions_unset'),
  refuse('FORBIDDEN', 'protocol.wallet_sanctioned'),
);

export const PROTOCOL_VENUE_WALLET_CHALLENGE = defineProcedure({
  ...base,
  name: 'protocol.venueWallet.challenge',
  kind: 'mutation',
  path: 'venueWallet.challenge',
  access: PERSON,
  refusals: join(
    VENUE_SANCTIONS,
    refuse('PRECONDITION_FAILED', 'protocol.wallet_session_unset', 'protocol.venue_connection_ttl_unset'),
    refuse('BAD_REQUEST', 'protocol.wallet_session_origin_unlisted'),
  ),
  input: protocolVenueWalletChallengeInputSchema,
  output: protocolVenueWalletChallengeOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, origin: 'https://example.com' } },
    { verdict: 'refuse', input: { address: '0x12', origin: 'https://example.com' } },
  ],
});

export const PROTOCOL_VENUE_WALLET_OPEN = defineProcedure({
  ...base,
  name: 'protocol.venueWallet.open',
  kind: 'mutation',
  path: 'venueWallet.open',
  access: PERSON,
  refusals: join(
    VENUE_SANCTIONS,
    refuse('PRECONDITION_FAILED', 'protocol.wallet_session_unset'),
    refuse('BAD_REQUEST', 'protocol.wallet_challenge_invalid'),
    refuse('FORBIDDEN', 'protocol.wallet_signature_not_owner'),
    refuse('CONFLICT', 'protocol.venue_challenge_used'),
  ),
  input: protocolVenueWalletOpenInputSchema,
  output: protocolVenueWalletConnectionSchema,
  samples: [
    { verdict: 'accept', input: { challenge: 'TEST-challenge', signature: SIGNATURE } },
    { verdict: 'refuse', input: { challenge: 'TEST-challenge' } },
  ],
});

export const PROTOCOL_VENUE_WALLET_STATUS = defineProcedure({
  ...base,
  name: 'protocol.venueWallet.status',
  kind: 'query',
  path: 'venueWallet.status',
  access: PERSON,
  refusals: join(),
  input: NO_INPUT,
  output: protocolVenueWalletStatusOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_VENUE_WALLET_DISCONNECT = defineProcedure({
  ...base,
  name: 'protocol.venueWallet.disconnect',
  kind: 'mutation',
  path: 'venueWallet.disconnect',
  access: PERSON,
  refusals: join(),
  input: protocolVenueWalletAddressInputSchema,
  output: protocolVenueWalletDisconnectedOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS } },
    { verdict: 'refuse', input: {} },
  ],
});

export const PROTOCOL_VENUE_WALLET_AUTHORIZE = defineProcedure({
  ...base,
  name: 'protocol.venueWallet.authorize',
  kind: 'mutation',
  path: 'venueWallet.authorize',
  access: PERSON,
  refusals: join(VENUE_SANCTIONS, refuse('PRECONDITION_FAILED', 'protocol.venue_connection_none', 'protocol.venue_connection_expired')),
  input: protocolVenueWalletAuthorizeInputSchema,
  output: protocolVenueWalletAuthorizedOutputSchema,
  samples: [
    { verdict: 'accept', input: { address: ADDRESS, action: 'deposit' } },
    { verdict: 'refuse', input: { address: ADDRESS, action: 'trade' } },
  ],
});

// ── embeddedWallet (`embeddedWalletTrpcError`) ───────────────────────────────────────────────────────────────────

export const PROTOCOL_EMBEDDED_WALLET_STATUS = defineProcedure({
  ...base,
  name: 'protocol.embeddedWallet.status',
  kind: 'query',
  path: 'embeddedWallet.status',
  access: PERSON,
  refusals: join(),
  input: NO_INPUT,
  output: protocolEmbeddedWalletStatusOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const PROTOCOL_EMBEDDED_WALLET_CREATE = defineProcedure({
  ...base,
  name: 'protocol.embeddedWallet.create',
  kind: 'mutation',
  path: 'embeddedWallet.create',
  access: PERSON,
  refusals: join(
    refuse('PRECONDITION_FAILED', 'wallet.embedded_provider_unset', 'wallet.embedded_provider_unwired'),
    refuse('SERVICE_UNAVAILABLE', 'wallet.embedded_provider_down'),
    refuse('CONFLICT', 'wallet.embedded_wallet_mismatch'),
  ),
  input: protocolEmbeddedWalletCreateInputSchema,
  output: protocolEmbeddedWalletCreateOutputSchema,
  samples: [
    { verdict: 'accept', input: { passkey: { credentialId: 'TEST-credential', publicKey: 'TEST-key', algorithm: -7 } } },
    { verdict: 'refuse', input: { passkey: { credentialId: 'TEST-credential', publicKey: 'TEST-key', algorithm: -8 } } },
    { verdict: 'refuse', input: {} },
  ],
});

export const PROTOCOL_WALLET_PROCEDURES = [
  PROTOCOL_WALLET_SESSION_CHALLENGE,
  PROTOCOL_WALLET_SESSION_OPEN,
  PROTOCOL_ADDRESS_BOOK_LIST,
  PROTOCOL_ADDRESS_BOOK_ADD_CONTACT,
  PROTOCOL_ADDRESS_BOOK_REMOVE_CONTACT,
  PROTOCOL_ADDRESS_BOOK_CREATE_GROUP,
  PROTOCOL_ADDRESS_BOOK_GROUP,
  PROTOCOL_ADDRESS_BOOK_REMOVE_GROUP,
  PROTOCOL_ADDRESS_RISK_READ,
  PROTOCOL_ADDRESS_REPORTS_SUBMIT,
  PROTOCOL_COMPLIANCE_REPORTS_LIST,
  PROTOCOL_COMPLIANCE_LABELS_ASK,
  PROTOCOL_COMPLIANCE_LABELS_APPROVE,
  PROTOCOL_COMPLIANCE_TIERS_LIST,
  PROTOCOL_COMPLIANCE_TIERS_ASK,
  PROTOCOL_COMPLIANCE_TIERS_APPROVE,
  PROTOCOL_COMPLIANCE_TIERS_REMOVE,
  PROTOCOL_COMPLIANCE_ONBOARDING_LIST,
  PROTOCOL_COMPLIANCE_ONBOARDING_OPEN,
  PROTOCOL_COMPLIANCE_ONBOARDING_APPROVE,
  PROTOCOL_COMPLIANCE_NAME_TAGS_LIST,
  PROTOCOL_COMPLIANCE_NAME_TAGS_REQUEST,
  PROTOCOL_COMPLIANCE_NAME_TAGS_APPROVE,
  PROTOCOL_VENUE_WALLET_CHALLENGE,
  PROTOCOL_VENUE_WALLET_OPEN,
  PROTOCOL_VENUE_WALLET_STATUS,
  PROTOCOL_VENUE_WALLET_DISCONNECT,
  PROTOCOL_VENUE_WALLET_AUTHORIZE,
  PROTOCOL_EMBEDDED_WALLET_STATUS,
  PROTOCOL_EMBEDDED_WALLET_CREATE,
] as const;
