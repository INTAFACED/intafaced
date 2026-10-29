import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  approveKycCase,
  assertRejectable,
  listKycCases,
  openKycCase,
  rejectKycCase,
  type KycRejectDecision,
  type KycRejectReasons,
} from '../kyc/cases.js';
import {
  assertDeactivatable,
  assertRequestable,
  deactivateCapability,
  grantOnApproval,
  listCapabilities,
  markRequested,
  releaseOnReject,
  type KycCapabilityMap,
} from '../kyc/capabilities.js';
import type { KycCapabilitiesOutput, KycCapability } from '@intafaced/contracts/identity-kyc-capabilities';
import { assertAttemptsLeft, readKycAttempts, type KycAttemptLimit } from '../kyc/attempts.js';
import type { KycAttempts } from '@intafaced/contracts/identity-kyc-attempts';
import type { KycCase } from '@intafaced/contracts/identity-kyc-cases';
import type { ApiKeyRevokedBy } from '@intafaced/contracts/api-keys';
import type {
  AccountState,
  CampaignParticipant,
  EmailProof,
  ServiceMailAccepted,
  ServiceMailRequest,
  TrustedDeviceState,
} from '@intafaced/contracts';
import {
  assertDelegatableScopes,
  FOUNDER_SESSION_SCOPE_ALLOWLIST,
  isPayStepUpScope,
  issueAccessToken,
  PAY_STEP_UP_ACCESS_TTL_SECONDS,
  PAY_STEP_UP_FACTOR_TTL_SECONDS,
  scopesForFounderSession,
  SESSION_SCOPES,
  type PayStepUpScope,
  type Scope,
  type TokenConfig,
} from '@intafaced/auth';
import type { EventBus } from '@intafaced/events';
import {
  assertPasswordNotBreached,
  assertPasswordShape,
  assertPasswordNotIdentity,
  dummyPasswordHash,
  generateApiKey,
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  verifyPassword,
  WeakPasswordError,
} from './passwords.js';
import { assertNotSecurityLocked } from './security-lock.js';
import { assertLeavesAWayIn, lockedSigninMethods, startWalletChallenge, walletSigninAccount, type WalletConfig } from './signin-methods.js';
import { accountHasSecondFactor, assertMayAddFactor, assertMayRemoveFactor, checkMayAddFactor, type FactorActor } from './factor-gate.js';
import { confirmEmail, isEmailConfirmed, requestEmailConfirmation } from './email-confirmation.js';
import {
  confirmSignUp,
  resendSignUp,
  startSignUp,
  type AccountType,
  type SignUpAccepted,
  type SignUpDeps,
  type SignUpPolicy,
  type SignUpStart,
} from './sign-up.js';
import {
  checkLoginCode,
  consumeLoginCode,
  requestLoginCode,
  resendLoginCode,
  type LoginCodeAccepted,
  type LoginCodeDeps,
  type LoginCodePolicy,
} from './login-code.js';
import { handleRetiredByOther, lockHandleClaim } from '../profile/handle-settings.js';
import { queueServiceMail } from './service-mail.js';
import { queuePasswordChangedNotice } from './password-changed-notice.js';
import { queueFactorChangedNotice } from './factor-changed-notice.js';
import {
  cancelMfaReset,
  completeDueMfaReset,
  confirmMfaReset,
  MfaResetError,
  mfaResetConfigured,
  mfaResetStatus,
  startMfaReset,
  stopMfaResetByProof,
  type MfaResetDeps,
  type MfaResetView,
} from './mfa-reset.js';
import type { SupportRecoveryDeps } from './support-recovery.js';
import {
  approveFromSession,
  approveWithCode,
  completeAuthorisation,
  deviceLabel,
  gateDevice,
  listDevices,
  pendingAuthorisations,
  removeDevice,
  trustDevice,
  trustedDeviceState,
  TrustedDeviceError,
  type NewDevicePolicy,
  type TrustedDeviceDeps,
  type TrustedDeviceRow,
} from './trusted-devices.js';
import {
  completePasswordReset,
  publishedPasswordResetTtlSeconds,
  relayMailOutbox,
  requestHandleRecovery,
  requestPasswordReset,
  type PasswordResetMail,
} from './password-reset.js';
import type { MerchantEmailInviteClaimer } from './merchant-email-invite-claim.js';

export { isEmailConfirmed };
import { generateRecoveryCodes, generateSecret, matchTotpStep, totpUri } from './totp.js';
import { encryptTotpSecret, materializeTotpSecret, parseTotpSecretKey } from './totp-crypto.js';
import { apiKeyOriginAllowed } from './api-key-origin.js';
import { currentRequestIp, currentUserAgent } from './request-meta.js';
import { recordSuccess, reserveAttempt, type AttemptKind } from './attempt-lockout.js';
import { matchInvite, type FounderEnrolmentConfig } from './founder-enrolment.js';
import { SqlPendingTotpEnrolmentStore, type PendingTotpEnrolmentStore } from './pending-totp-store.js';
import {
  b64urlDecode,
  b64urlEncode,
  SqlChallengeStore,
  createAuthenticationOptions,
  createRegistrationOptions,
  decoyCredentialIds,
  generateChallenge,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  WebAuthnError,
} from './webauthn.js';
import type {
  AuthenticationOptionsJSON,
  AuthenticationResponseJSON,
  ChallengeStorePort,
  RegistrationOptionsJSON,
  RegistrationResponseJSON,
  StoredWebAuthnCredential,
  WebAuthnConfig,
} from './webauthn.js';
import {
  syncNavigatorSessionClosed,
  syncNavigatorSessionOpen,
  syncNavigatorSessionsClosedForUser,
} from '../agents/navigator-session-projection-sync.js';
import { DEFAULT_REFRESH_REUSE_GRACE_SECONDS, REFRESH_RECOVERY_SECONDS_CEILING } from './refresh-cookie.js';
import { openRefreshToken, sealRefreshToken } from './refresh-grace.js';
import { credentialsFor, type PasskeyPurpose } from './passkey-purposes.js';
import type { RankService } from '../rank/rank-service.js';

/**
 * AUTH (§4.1, §9).
 *
 * Sovereignty means owning this. No third-party auth dependency, which also
 * means no third party to blame — every decision here is ours to get right.
 *
 * Schema: SQL is search_path-relative (not hard-coded `identity.*`). Production
 * connects with `search_path = identity,public` (see `src/index.ts`). Tests use
 * `createTestDb`, which allocates a unique schema per suite so parallel
 * worktrees cannot TRUNCATE each other into a poisoned KYC queue.
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'auth.invalid_credentials'
      | 'auth.account_frozen'
      | 'auth.handle_taken'
      | 'auth.email_taken'
      | 'auth.mfa_required'
      | 'auth.second_step_expired'
      | 'auth.privileged_enrolment_requires_invite'
      | 'auth.mfa_invalid'
      | 'auth.mfa_already_enrolled'
      | 'auth.session_invalid'
      | 'auth.session_reused'
      | 'auth.not_found'
      | 'auth.kyc_not_pending'
      | 'auth.kyc_self_review'
      | 'auth.kyc_agent_refused'
      | 'auth.mfa_not_enrolled'
      | 'identity.passkey_limit'
      | 'auth.webauthn_invalid'
      | 'auth.webauthn_not_enrolled'
      | 'auth.webauthn_unconfigured'
      | 'auth.domain_not_allowed'
      | 'auth.sub_account_required'
      | 'auth.sub_account_denied'
      | 'auth.sub_account_revoked'
      | 'auth.sub_account_same'
      | 'auth.sub_account_limit'
      | 'auth.sub_account_cap_unset'
      | 'identity.account_frozen_self'
      | 'auth.sub_account_nickname_invalid'
      | 'auth.sub_account_nickname_taken'
      | 'auth.sub_account_kind_unavailable'
      | 'auth.api_key_denied'
      | 'auth.api_key_revoked'
      | 'auth.session_denied'
      | 'auth.session_revoked'
      | 'auth.totp_key_missing'
      | 'auth.delegate_cannot_grant'
      | 'auth.sandbox_scope_not_pay'
      | 'auth.password_unchanged'
      | 'auth.password_policy'
      | 'auth.password_breached'
      | 'auth.reset_proof_invalid'
      | 'auth.reset_unwired'
      | 'auth.email_confirm_invalid'
      | 'auth.email_confirm_unwired'
      | 'auth.email_confirm_rate_limited'
      | 'auth.too_many_attempts'
      | 'auth.invite_invalid'
      | 'auth.invite_used'
      | 'auth.invite_expired'
      | 'auth.founder_enrolment_closed'
      | 'auth.request_unsigned'
      | 'auth.request_stale'
      | 'auth.request_future'
      | 'auth.request_tampered'
      | 'auth.request_replay'
      | 'auth.request_window_unset'
      | 'auth.api_key_expired'
      | 'auth.edge_unauthenticated'
      | 'auth.ip_allowlist_required'
      | 'auth.payee_email_unconfirmed'
      | 'auth.payee_phone_unverified'
      | 'auth.payee_phone_unset'
      | 'auth.step_up_required'
      | 'auth.step_up_expired'
      | 'pay.role_not_allowed',
    /**
     * Optional machine-readable extras. `retryAfterSeconds`: set by `auth.too_many_attempts` and `auth.email_confirm_rate_limited`.
     * `accountState`: set by sign-in's `auth.account_frozen`, only after the password (or a provider) verified who it is.
     */
    readonly details?: {
      readonly retryAfterSeconds?: number;
      readonly accountState?: 'frozen' | 'closed';
      /** Set by sign-in's `auth.mfa_required` (I-signin-sessions-10): the second steps that answer it. */
      readonly secondStep?: { readonly totp: boolean; readonly passkey: AuthenticationOptionsJSON | null };
    },
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Sign-in's `details` for a non-active account, once the person proved who they are. Only `closed` is final. */
const accountStateOf = (status: string) => ({ accountState: status === 'closed' ? ('closed' as const) : ('frozen' as const) });

/** Blank / non-integer / out of 1..200 KYC pending queue limit. Never invent 50. */
export const SELF_FREEZE_REASONS = ['compromise', 'temporary', 'personal'] as const;
export type SelfFreezeReason = (typeof SELF_FREEZE_REASONS)[number];
export const SUB_ACCOUNT_KINDS = ['standard', 'managed', 'derivatives', 'spot'] as const;
export type SubAccountKind = (typeof SUB_ACCOUNT_KINDS)[number];
/** 5 to 20 letters or digits. */
export const SUB_ACCOUNT_NICKNAME = /^[A-Za-z0-9]{5,20}$/;
export const IDENTITY_KYC_PENDING_LIMIT_UNSET = 'identity.kyc_pending_limit_unset' as const;
export const KYC_PENDING_LIMIT_MAX = 200;

export class KycPendingLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_KYC_PENDING_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'KycPendingLimitUnsetError';
  }
}

/** Owner-published KYC queue window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedKycPendingLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > KYC_PENDING_LIMIT_MAX) {
    throw new KycPendingLimitUnsetError('KYC pending limit is unset — refuse to invent 50', IDENTITY_KYC_PENDING_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..200 API-key list window. Never invent 50. */
export const IDENTITY_API_KEYS_LIST_LIMIT_UNSET = 'identity.api_keys_list_limit_unset' as const;
export const API_KEYS_LIST_LIMIT_MAX = 200;

export class ApiKeysListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_API_KEYS_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'ApiKeysListLimitUnsetError';
  }
}

/** Owner-published API-key list window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedApiKeysListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > API_KEYS_LIST_LIMIT_MAX) {
    throw new ApiKeysListLimitUnsetError('API keys list limit is unset — refuse to invent 50', IDENTITY_API_KEYS_LIST_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..200 sub-account list window. Never invent 50. */
export const IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET = 'identity.sub_accounts_list_limit_unset' as const;
export const SUB_ACCOUNTS_LIST_LIMIT_MAX = 200;

export class SubAccountsListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'SubAccountsListLimitUnsetError';
  }
}

/** Owner-published sub-account list window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedSubAccountsListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > SUB_ACCOUNTS_LIST_LIMIT_MAX) {
    throw new SubAccountsListLimitUnsetError(
      'Sub-accounts list limit is unset — refuse to invent 50',
      IDENTITY_SUB_ACCOUNTS_LIST_LIMIT_UNSET,
    );
  }
  return value;
}

/** Blank / non-integer / out of 1..200 KYC status-records window. Never invent 50. */
export const IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET = 'identity.kyc_records_list_limit_unset' as const;
export const KYC_RECORDS_LIST_LIMIT_MAX = 200;

export class KycRecordsListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'KycRecordsListLimitUnsetError';
  }
}

/** Owner-published KYC status-records window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedKycRecordsListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > KYC_RECORDS_LIST_LIMIT_MAX) {
    throw new KycRecordsListLimitUnsetError('KYC records list limit is unset — refuse to invent 50', IDENTITY_KYC_RECORDS_LIST_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..200 WebAuthn credential list window. Never invent 50. */
export const IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET = 'identity.webauthn_list_limit_unset' as const;
export const WEBAUTHN_LIST_LIMIT_MAX = 200;

export class WebauthnListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'WebauthnListLimitUnsetError';
  }
}

/** Owner-published WebAuthn list window. Missing / null / non-int / out of 1..max refuses. Never invent 50. */
export function publishedWebauthnListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > WEBAUTHN_LIST_LIMIT_MAX) {
    throw new WebauthnListLimitUnsetError('WebAuthn list limit is unset — refuse to invent 50', IDENTITY_WEBAUTHN_LIST_LIMIT_UNSET);
  }
  return value;
}

export type { WebAuthnConfig, StoredWebAuthnCredential };

export function assertOperatorKycReview(input: { service?: string | null; kid?: string | null }): void {
  if (input.service || input.kid) {
    throw new AuthError('KYC review is an operator action — an agent must never write reviewed_by', 'auth.kyc_agent_refused');
  }
}

/**
 * Nobody decides their own verification: not the operator who records the decision, not the second operator named on
 * the wire, and neither the proposer nor the approver of the four-eyes approval it consumes. Otherwise two people can
 * approve each other's KYC, or one of them their own, and the four-eyes check grants what it exists to withhold.
 */
export function assertNotOwnKyc(subjectId: string, reviewers: readonly (string | null | undefined)[]): void {
  // Ids arrive typed in as well as from rows: compare them the way a uuid compares, not byte for byte.
  const subject = subjectId.trim().toLowerCase();
  if (reviewers.some((id) => typeof id === 'string' && id.trim().toLowerCase() === subject)) {
    throw new AuthError('Nobody may review their own verification', 'auth.kyc_self_review');
  }
}

/** An API key is a delegate. Intersection-only: it cannot mint or bind a further grant. */
export function assertDelegateCannotGrant(kid?: string | null): void {
  if (kid) {
    throw new AuthError('A delegate cannot grant further', 'auth.delegate_cannot_grant');
  }
}

export type KycTier = 'none' | 'basic' | 'full' | 'institutional';
export type SubmittableKycTier = Exclude<KycTier, 'none'>;

export interface KycRecordView {
  id: string;
  userId: string;
  tier: KycTier;
  jurisdiction: string;
  providerRef: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

interface KycRow {
  id: string;
  user_id: string;
  tier: KycTier;
  jurisdiction: string;
  provider_ref: string | null;
  status: KycRecordView['status'];
  reviewed_by: string | null;
  reviewed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

function toKycRecord(row: KycRow): KycRecordView {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    jurisdiction: row.jurisdiction,
    providerRef: row.provider_ref,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

const TIER_ORDER: Readonly<Record<KycTier, number>> = { none: 0, basic: 1, full: 2, institutional: 3 };
const STEP_UP_TTL_SECONDS = 300;
/** The passkey challenge of a sign-in second step: 120 seconds after the password verified, single use (I-signin-sessions-10). */
const SECOND_STEP_CHALLENGE_TTL_MS = 120_000;
const STEP_UP_SCOPES: readonly Scope[] = ['trade:withdraw'];

/** What svc-pay says this person may do on one merchant. Both false refuses the mint. */
export type PayStepUpGrant = {
  readonly refundsCreate: boolean;
  readonly payoutSend: boolean;
};

/** What a guarded API-key action runs on: one open transaction, shared with its audit row. */
export type ApiKeyActionScope = {
  readonly tx: Sql;
  createApiKey: (input: Parameters<AuthService['createApiKey']>[0]) => ReturnType<AuthService['createApiKey']>;
  revokeApiKey: (userId: string, keyId: string, cause?: ApiKeyRevokedBy) => Promise<boolean>;
};

export type PayStepUpFactorProof =
  { readonly totpCode: string } | { readonly webauthn: AuthenticationResponseJSON } | { readonly proofId: string };

export interface RegisterInput {
  handle: string;
  email: string;
  password: string;
  region?: string;
  device?: string;
  ip?: string;
  /** The device key this browser already holds (`ifc_dk`), kept as the new account's first trusted device. */
  deviceKey?: string | null;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  sessionId: string;
  userId: string;
  mfaRequired: boolean;
  /** A device key just trusted for this browser (`ifc_dk`): set on sign-up and on a completed new-device approval. */
  deviceKey?: string;
  /** Set only when this sign-in's second step spent a recovery code: how many of the account's codes are left. */
  recoveryCodesLeft?: number;
}

const DEFAULT_WEBAUTHN: WebAuthnConfig = {
  rpID: 'localhost',
  rpName: 'INTAFACED',
  origin: 'http://localhost:3000',
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function uniqueConstraintName(err: unknown): string {
  const name = (err as { constraint_name?: unknown }).constraint_name;
  return typeof name === 'string' ? name : '';
}

/** A session as a sign-in answers it: plus a device key just trusted, and the recovery codes left when one was spent. */
function withSecondStep(session: SessionTokens, deviceKey: string | undefined, recoveryCodesLeft: number | undefined): SessionTokens {
  return {
    ...session,
    ...(deviceKey ? { deviceKey } : {}),
    ...(recoveryCodesLeft !== undefined ? { recoveryCodesLeft } : {}),
  };
}

/**
 * Milliseconds of the lost-reply window. Undefined, 0, a non-integer, or a
 * value above the ceiling is off. Never invents 120.
 */
function recoveryWindowMs(seconds: number | undefined): number {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds)) return 0;
  if (seconds <= 0 || seconds > REFRESH_RECOVERY_SECONDS_CEILING) return 0;
  return seconds * 1000;
}

/**
 * Drop the sealed copy of `sessionId` held by its predecessor.
 * The predecessor is the same user and already revoked, so the predicate
 * stays on `sessions_user_idx` (`user_id`, `revoked`) instead of scanning
 * every session row. `clearPredecessorSeal` and the plan test share this text.
 */
export function predecessorSealCleanup(userId: string, sessionId: string): { text: string; values: string[] } {
  return {
    text: 'UPDATE sessions SET successor_refresh = NULL WHERE user_id = $1 AND revoked = true AND successor_id = $2 AND successor_refresh IS NOT NULL',
    values: [userId, sessionId],
  };
}

export async function clearPredecessorSeal(tx: Sql, userId: string, sessionId: string): Promise<void> {
  const query = predecessorSealCleanup(userId, sessionId);
  await tx.unsafe(query.text, query.values);
}

/**
 * A password refusal at registration or founder enrolment answers the typed code, as change and reset do, before any
 * hashing: `auth.password_policy` for the shape or the account's own name, `auth.password_breached` for the owner's list.
 */
function policyRefusal(check: () => void): void {
  try {
    check();
  } catch (err) {
    if (err instanceof WeakPasswordError) throw new AuthError(err.message, err.code);
    throw err;
  }
}

export class AuthService {
  private readonly pendingTotp: PendingTotpEnrolmentStore;
  private readonly challenges: ChallengeStorePort;
  private readonly webauthn: WebAuthnConfig;
  private readonly totpSecretKey: Buffer | null;
  /** Owner-published live cap. Undefined = unpublished — create refuses, never invents 25. */
  private readonly maxSubAccounts: number | undefined;
  private readonly subAccountKinds: ReadonlySet<SubAccountKind>;
  /** How long a just-rotated refresh token may be presented again by a second tab. */
  private readonly reuseGraceMs: number;
  /**
   * Owner-published lost-reply window past the grace, in milliseconds.
   * 0 is off: a presentation outside the grace window is reuse, as before.
   */
  private readonly recoveryMs: number;
  /** Owner-published reset lifetime. Undefined = unpublished — reset refuses, never invents 900. */
  private passwordResetTtlSeconds: number | undefined;
  /** The owner's level-to-capability mapping (I-kyc-compliance-07). Empty until index.ts installs it: grants nothing. */
  private kycCapabilities: KycCapabilityMap = new Map();
  /** The owner's limit on rejected requests (I-kyc-compliance-10). Null until index.ts installs one: no limit. */
  private kycAttemptLimit: KycAttemptLimit | null = null;
  private passwordResetMail: PasswordResetMail | undefined;
  private passwordResetMaxAttempts: number | undefined;
  private passwordResetRequestMax: number | undefined;
  private passwordResetRequestWindowSeconds: number | undefined;
  private flowSubjectKey: string | undefined;
  private resetNotifyUnknown = false;
  /** Starts the mail relay after a recovery request commits. Off the response path; unset in tests that drain by hand. */
  private mailRelayTrigger: (() => void | Promise<void>) | undefined;
  private passwordResetNow: () => Date = () => new Date();
  /** Unset: confirmation does not call pay. Email invites stay pending. */
  private merchantEmailInviteClaimer: MerchantEmailInviteClaimer | undefined;
  /**
   * Optional lookup of the published owner pay grant. Unset means sessions
   * stay on SESSION_SCOPES. A throw omits pay scopes and still issues the
   * ordinary session.
   */
  private ownerPayScopeSource: ((userId: string) => Promise<readonly string[]>) | null = null;
  /**
   * svc-pay read: may this user refund or pay out for this merchant.
   * Unset refuses the mint. A throw refuses the mint.
   */
  private payStepUpRoleSource: ((input: { userId: string; merchantId: string }) => Promise<PayStepUpGrant>) | null = null;
  /** Same mail port as password reset. Unset refuses confirmation (`auth.email_confirm_unwired`). */
  private emailConfirmMail: PasswordResetMail | undefined;
  private emailConfirmTtlSeconds: number | undefined;
  private emailConfirmRateMax: number | undefined;
  private emailConfirmRateWindowSeconds: number | undefined;
  private emailConfirmNow: () => Date = () => new Date();
  /** Live founder directory. Unset means no founder desk scopes (fail closed). */
  private founderDirectory: { isFounder(userId: string, query?: Sql): Promise<boolean> } | undefined;
  /** Lead-published founder grant. Blank grants nothing. */
  private founderSessionScopes: readonly Scope[] = [];
  /** The config string whose sha256 is written on each founder issuance. */
  private founderSessionConfigValue = '';

  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus,
    private readonly rank: RankService,
    private readonly tokens: TokenConfig & { refreshTtlSeconds: number },
    webauthn: WebAuthnConfig = DEFAULT_WEBAUTHN,
    totpSecretKeyMaterial?: string,
    challenges?: ChallengeStorePort,
    pendingTotp?: PendingTotpEnrolmentStore,
    maxSubAccounts?: number,
    reuseGraceSeconds: number = DEFAULT_REFRESH_REUSE_GRACE_SECONDS,
    recoverySeconds?: number,
    offeredSubAccountKinds?: readonly string[],
  ) {
    this.webauthn = webauthn;
    this.subAccountKinds = new Set(
      (offeredSubAccountKinds ?? []).filter((k): k is SubAccountKind => (SUB_ACCOUNT_KINDS as readonly string[]).includes(k)),
    );
    this.totpSecretKey = parseTotpSecretKey(totpSecretKeyMaterial);
    this.challenges = challenges ?? new SqlChallengeStore(sql, webauthn.challengeTtlMs);
    this.pendingTotp = pendingTotp ?? new SqlPendingTotpEnrolmentStore(sql);
    this.maxSubAccounts =
      maxSubAccounts !== undefined && Number.isFinite(maxSubAccounts) && maxSubAccounts >= 1 ? Math.floor(maxSubAccounts) : undefined;
    const grace = Number.isFinite(reuseGraceSeconds) ? Math.floor(reuseGraceSeconds) : DEFAULT_REFRESH_REUSE_GRACE_SECONDS;
    this.reuseGraceMs = Math.min(120, Math.max(0, grace)) * 1000;
    this.recoveryMs = recoveryWindowMs(recoverySeconds);
  }

  /** Cookie Max-Age. Same number as the refresh-token row lifetime. */
  refreshLifetimeSeconds(): number {
    return this.tokens.refreshTtlSeconds;
  }

  /** Structured warn sink. Defaults to one JSON line on stderr; index.ts swaps in the Fastify logger. */
  private log: { warn(obj: Record<string, unknown>, msg: string): void } = {
    warn: (obj, msg) => process.stderr.write(`${JSON.stringify({ level: 'warn', ...obj, msg })}\n`),
  };

  useLogger(log: { warn(obj: Record<string, unknown>, msg: string): void }): void {
    this.log = log;
  }

  /** Install the owner's level-to-capability mapping. Empty means none is published: an approval grants no capability. */
  useKycCapabilities(map: KycCapabilityMap): void {
    this.kycCapabilities = map;
  }

  /** Install the owner's limit on rejected verification requests. Null means none is set, and the page says so. */
  useKycAttemptLimit(limit: KycAttemptLimit | null): void {
    this.kycAttemptLimit = limit;
  }

  /** Install the mail handoff. Unset refuses every reset request the same way. */
  usePasswordResetMail(mail: PasswordResetMail | undefined): void {
    this.passwordResetMail = mail;
  }

  /** Install the pay claim. Unset leaves email invites pending and does not call pay. */
  useMerchantEmailInviteClaimer(claimer: MerchantEmailInviteClaimer | undefined): void {
    this.merchantEmailInviteClaimer = claimer;
  }

  /** Owner-published lifetime in seconds. Unset, 0, or out of range stays unpublished. */
  usePasswordResetTtl(seconds: number | undefined): void {
    this.passwordResetTtlSeconds = publishedPasswordResetTtlSeconds(seconds);
  }

  /**
   * Install the svc-pay owner-grant lookup. Identity does not decide the law;
   * it only attaches `pay:read`, `pay:write`, and `pay:onboard` when pay returns them.
   */
  useOwnerPayScopeSource(source: ((userId: string) => Promise<readonly string[]>) | null): void {
    this.ownerPayScopeSource = source;
  }

  /** Install the svc-pay role read used by `stepUpPay`. Unset refuses every mint. */
  usePayStepUpRoleSource(source: ((input: { userId: string; merchantId: string }) => Promise<PayStepUpGrant>) | null): void {
    this.payStepUpRoleSource = source;
  }

  /**
   * Install the owner-published recovery numbers and the identifier key. Anything unset keeps reset and
   * username recovery refusing `auth.reset_unwired`; nothing here is a default.
   */
  usePasswordResetPolicy(policy: {
    readonly maxAttempts?: number | undefined;
    readonly requestMax?: number | undefined;
    readonly requestWindowSeconds?: number | undefined;
    readonly subjectKey?: string | undefined;
    readonly notifyUnknown?: boolean | undefined;
  }): void {
    this.passwordResetMaxAttempts = policy.maxAttempts;
    this.passwordResetRequestMax = policy.requestMax;
    this.passwordResetRequestWindowSeconds = policy.requestWindowSeconds;
    this.flowSubjectKey = policy.subjectKey;
    this.resetNotifyUnknown = policy.notifyUnknown === true;
  }

  /** Run the mail relay after a recovery request commits. A returned promise is awaited (tests); production returns nothing. Unset: rows wait for `drainMailOutbox`. */
  useMailRelayTrigger(trigger: (() => void | Promise<void>) | undefined): void {
    this.mailRelayTrigger = trigger;
  }

  /** A mail another service asked for (`POST /internal/mail`, service-mail.ts), on the recovery flows' clock and relay. */
  async queueServiceMail(input: ServiceMailRequest): Promise<ServiceMailAccepted> {
    return queueServiceMail(
      { sql: this.sql, now: this.passwordResetNow, mailWired: this.passwordResetMail !== undefined, afterCommit: this.mailRelayTrigger },
      input,
    );
  }

  /** Send the pending recovery mail, once each. Safe to call from a timer and from a trigger at the same time. */
  async drainMailOutbox(): Promise<{ sent: number; undeliverable: number; unknown: number }> {
    return relayMailOutbox(this.resetDeps());
  }

  /** Whether recovery mail can leave this process. A server-wide fact, not per address. */
  passwordResetChannel(): { emailDelivery: 'on' | 'off' } {
    return { emailDelivery: this.passwordResetMail ? 'on' : 'off' };
  }

  /** Test clock. Production uses the real clock. */
  usePasswordResetClock(now: () => Date): void {
    this.passwordResetNow = now;
  }

  /**
   * Install the shared mail port plus the owner-published confirmation lifetime
   * and rate budget. Any missing piece refuses every request the same way.
   */
  useEmailConfirmation(input: {
    mail: PasswordResetMail | undefined;
    ttlSeconds: number | undefined;
    rateMax: number | undefined;
    rateWindowSeconds: number | undefined;
  }): void {
    this.emailConfirmMail = input.mail;
    this.emailConfirmTtlSeconds = input.ttlSeconds;
    this.emailConfirmRateMax = input.rateMax;
    this.emailConfirmRateWindowSeconds = input.rateWindowSeconds;
  }

  /** Test clock for confirmation expiry. Production uses the real clock. */
  useEmailConfirmationClock(now: () => Date): void {
    this.emailConfirmNow = now;
  }

  /** Owner numbers for sign-up (sign-up.ts). The mail port, the flow key and the clock are the recovery flows' own. */
  useSignUpPolicy(policy: SignUpPolicy): void {
    this.signUpPolicy = policy;
  }

  private signUpPolicy: SignUpPolicy = {};

  private signUpDeps(): SignUpDeps {
    return {
      ...this.signUpPolicy,
      sql: this.sql,
      mail: this.passwordResetMail,
      subjectKey: this.flowSubjectKey,
      now: this.passwordResetNow,
      log: this.log,
      afterCommit: this.mailRelayTrigger,
    };
  }

  /** Sign-up step 1: eligibility, then a code by email. No account and no session yet. */
  async signUpStart(input: SignUpStart): Promise<SignUpAccepted> {
    return startSignUp(this.signUpDeps(), input);
  }

  /** Sign-up step 1b: a new code once the resend interval has passed. */
  async signUpResend(input: { flowId: string }): Promise<SignUpAccepted> {
    return resendSignUp(this.signUpDeps(), input);
  }

  /** Sign-up step 2: the right code makes the account (email proved) and opens its first session. */
  async signUpConfirm(input: {
    flowId: string;
    code: string;
    device?: string;
    ip?: string;
    deviceKey?: string | null;
  }): Promise<{ session: SessionTokens; accountType: AccountType; referrerId: string | null }> {
    const { userId, draft } = await confirmSignUp(this.signUpDeps(), input, (tx, d) =>
      this.insertNewUser(tx, { handle: d.handle, email: d.email, password: '', region: d.country }, d.passwordHash),
    );
    const session = await this.finishRegistration(userId, {
      handle: draft.handle,
      email: draft.email,
      password: '',
      region: draft.country,
      ...(input.device ? { device: input.device } : {}),
      ...(input.ip ? { ip: input.ip } : {}),
      deviceKey: input.deviceKey ?? null,
    });
    return { session, accountType: draft.accountType, referrerId: draft.referrerId };
  }

  /** Owner numbers for sign-in by a mailed code (login-code.ts). The mail port, the flow key and the clock are the recovery flows' own. */
  useLoginCodePolicy(policy: LoginCodePolicy): void {
    this.loginCodePolicy = policy;
  }

  private loginCodePolicy: LoginCodePolicy = {};

  /** The owner's wait for a locked-out second-factor reset (mfa-reset.ts). Unset refuses every reset. */
  useMfaResetWait(seconds: number | undefined): void {
    this.mfaResetWaitSeconds = seconds;
  }

  private mfaResetWaitSeconds: number | undefined;

  /** The reset's code uses the owner's numbers for mailed sign-in codes, the flow key and the recovery mail relay. */
  private mfaResetDeps(): MfaResetDeps {
    return {
      sql: this.sql,
      mail: this.passwordResetMail,
      waitSeconds: this.mfaResetWaitSeconds,
      codeTtlSeconds: this.loginCodePolicy.codeTtlSeconds,
      maxAttempts: this.loginCodePolicy.maxAttempts,
      subjectKey: this.flowSubjectKey,
      now: this.passwordResetNow,
      log: this.log,
      afterCommit: this.mailRelayTrigger,
    };
  }

  /** The owner's lifetime of a Support recovery link (support-recovery.ts). Unset refuses every send. */
  useSupportRecoveryLinkTtl(seconds: number | undefined): void {
    this.supportRecoveryLinkTtlSeconds = seconds;
  }

  private supportRecoveryLinkTtlSeconds: number | undefined;

  /** Support-assisted recovery (support-recovery.ts): the link uses the flow key and rides the recovery mail relay. */
  supportRecoveryDeps(): SupportRecoveryDeps {
    return {
      sql: this.sql,
      mail: this.passwordResetMail,
      linkTtlSeconds: this.supportRecoveryLinkTtlSeconds,
      subjectKey: this.flowSubjectKey,
      now: this.passwordResetNow,
      afterCommit: this.mailRelayTrigger,
    };
  }

  /**
   * Locked-out reset, step 1 (I-signin-sessions-12): the password again, checked and counted exactly as sign-in checks
   * it, then a code to the proved address. The wait is checked first, so a blank one refuses before any guess counts.
   */
  async mfaResetStart(input: { identifier: string; password: string }): Promise<MfaResetView> {
    const deps = this.mfaResetDeps();
    if (!mfaResetConfigured(deps)) throw new MfaResetError('identity.mfa_reset_unconfigured');
    const user = await this.passFirstFactor(input);
    return startMfaReset(deps, user.id);
  }

  /** Locked-out reset, step 2: the mailed code starts the wait and tells every contact. */
  async mfaResetConfirm(input: { resetId: string; code: string }): Promise<MfaResetView> {
    return confirmMfaReset(this.mfaResetDeps(), input);
  }

  /** The account's waiting reset, for its own sessions. */
  async mfaResetStatus(userId: string): Promise<{ resetId: string; waitingSince: string; completesAt: string } | null> {
    return mfaResetStatus(this.sql, userId);
  }

  /** Stop the account's open reset from one of its own sessions. */
  async mfaResetCancel(input: { userId: string; sessionId: string }): Promise<{ cancelled: boolean }> {
    return cancelMfaReset(this.mfaResetDeps(), input);
  }

  /** Owner settings for the new-device check (trusted-devices.ts). Unset: the check is off. */
  useNewDevicePolicy(policy: NewDevicePolicy): void {
    this.newDevicePolicy = policy;
  }

  private newDevicePolicy: NewDevicePolicy = { check: false };

  /** Whether the owner turned the new-device check on. */
  newDeviceCheckOn(): boolean {
    return this.newDevicePolicy.check;
  }

  /** What another service may rely on about one trusted device now (`GET /internal/trusted-devices/:userId/:deviceId`). */
  trustedDeviceState(userId: string, deviceId: string): Promise<TrustedDeviceState> {
    return trustedDeviceState(this.sql, this.newDevicePolicy, { userId, deviceId, now: this.passwordResetNow() });
  }

  private deviceDeps(): TrustedDeviceDeps {
    return {
      sql: this.sql,
      policy: this.newDevicePolicy,
      mail: this.passwordResetMail,
      subjectKey: this.flowSubjectKey,
      now: this.passwordResetNow,
      afterCommit: this.mailRelayTrigger,
    };
  }

  /** After every factor passed: the live trusted device, or (check on) a new-device authorisation refusal. */
  /**
   * The device gate after a sign-in's second step. When that step spent a recovery code and this browser still needs
   * approval, the refusal carries the count too: the code is already gone, so the person is told once the device is in.
   */
  private async gateDeviceAfterSecondStep(
    userId: string,
    step: { mfa: boolean; recoveryCodesLeft?: number },
    deviceKey: string | null | undefined,
  ): Promise<{ trustedDeviceId: string; deviceKey?: string }> {
    try {
      return await this.gateDevice(userId, step.mfa, deviceKey);
    } catch (err) {
      const waiting = err instanceof TrustedDeviceError ? err.details?.deviceAuthorisation : undefined;
      if (!(err instanceof TrustedDeviceError) || !waiting || step.recoveryCodesLeft === undefined) throw err;
      throw new TrustedDeviceError(err.message, err.code, {
        ...err.details,
        deviceAuthorisation: { ...waiting, recoveryCodesLeft: step.recoveryCodesLeft },
      });
    }
  }

  private gateDevice(
    userId: string,
    mfa: boolean,
    deviceKey: string | null | undefined,
  ): Promise<{ trustedDeviceId: string; deviceKey?: string }> {
    return gateDevice(this.deviceDeps(), { userId, mfa, deviceKey, label: deviceLabel(currentUserAgent()) });
  }

  /** New device, approved with the mailed code by the waiting browser, which then signs in at once. */
  async deviceApprove(input: {
    flowId: string;
    secret: string;
    code: string;
    ip?: string;
    deviceKey?: string | null;
  }): Promise<SessionTokens> {
    await approveWithCode(this.deviceDeps(), input);
    return this.deviceComplete(input);
  }

  /** The waiting browser finishes an approved new-device sign-in, once. */
  async deviceComplete(input: { flowId: string; secret: string; ip?: string; deviceKey?: string | null }): Promise<SessionTokens> {
    const done = await completeAuthorisation(this.deviceDeps(), {
      flowId: input.flowId,
      secret: input.secret,
      presentedKey: input.deviceKey,
    });
    const session = await this.issueSession(done.userId, { ip: input.ip, mfa: done.mfa, trustedDeviceId: done.trustedDeviceId });
    return { ...session, deviceKey: done.deviceKey };
  }

  /** A session on a trusted device approves a waiting sign-in of the same account (after its step-up). */
  async deviceApproveFromSession(input: { flowId: string; userId: string; sessionId: string }): Promise<void> {
    await approveFromSession(this.deviceDeps(), input);
  }

  async pendingDeviceAuthorisations(userId: string) {
    return pendingAuthorisations(this.deviceDeps(), userId);
  }

  async trustedDevices(userId: string, sessionId: string | null): Promise<TrustedDeviceRow[]> {
    return listDevices(this.deviceDeps(), { userId, sessionId });
  }

  async removeTrustedDevice(userId: string, deviceId: string): Promise<{ removed: boolean; sessionsEnded: number }> {
    return removeDevice(this.deviceDeps(), { userId, deviceId });
  }

  private loginCodeDeps(): LoginCodeDeps {
    return {
      ...this.loginCodePolicy,
      sql: this.sql,
      mail: this.passwordResetMail,
      subjectKey: this.flowSubjectKey,
      notifyUnknown: this.resetNotifyUnknown,
      now: this.passwordResetNow,
      log: this.log,
      afterCommit: this.mailRelayTrigger,
    };
  }

  /** Code sign-in step 1: the same answer for every name; an active account is mailed a code. */
  async loginCodeRequest(input: { identifier: string }): Promise<LoginCodeAccepted> {
    return requestLoginCode(this.loginCodeDeps(), input);
  }

  /** Code sign-in step 1b: a new code once the resend interval has passed; the old one stops working. */
  async loginCodeResend(input: { flowId: string }): Promise<LoginCodeAccepted> {
    return resendLoginCode(this.loginCodeDeps(), input);
  }

  /**
   * Code sign-in step 2. The right code proves the mailbox; an account with an authenticator still needs its code,
   * counted and checked as on password sign-in, and the mailed code stays unspent until that passes. The code is then
   * spent with a compare-and-swap, so it opens one session at most.
   */
  async loginWithCode(input: {
    flowId: string;
    code: string;
    totpCode?: string;
    device?: string;
    ip?: string;
    deviceKey?: string | null;
  }): Promise<SessionTokens> {
    const deps = this.loginCodeDeps();
    const { userId, codeHash } = await checkLoginCode(deps, input);
    const [user] = await this.sql<
      Array<{ id: string; status: string; totp_secret: string | null; passkey_second_step: boolean; webauthn_creds: unknown }>
    >`SELECT id, status, totp_secret, passkey_second_step, webauthn_creds FROM users WHERE id = ${userId}`;
    if (!user) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    // The code proved the mailbox, so the state is named as on password sign-in.
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen', accountStateOf(user.status));
    // A passkey asked for after the password is asked for after a mailed code too; the code then stays unspent until it expires.
    const { mfa, recoveryCodesLeft } = await this.passSecondStep(user, input.totpCode);
    await consumeLoginCode(deps, { flowId: input.flowId, codeHash });
    const device = await this.gateDeviceAfterSecondStep(user.id, { mfa, recoveryCodesLeft }, input.deviceKey);
    const session = await this.issueSession(user.id, { device: input.device, ip: input.ip, mfa, trustedDeviceId: device.trustedDeviceId });
    return withSecondStep(session, device.deviceKey, recoveryCodesLeft);
  }

  private emailConfirmDeps() {
    return {
      sql: this.sql,
      mail: this.emailConfirmMail,
      ttlSeconds: this.emailConfirmTtlSeconds,
      rateMax: this.emailConfirmRateMax,
      rateWindowSeconds: this.emailConfirmRateWindowSeconds,
      now: this.emailConfirmNow,
      log: this.log,
    };
  }

  private passkeyLimit: number | undefined;

  /** Owner setting PASSKEY_MAX_PER_ACCOUNT; unset states no limit and refuses nothing. */
  usePasskeyLimit(maxPerAccount: number | undefined): void {
    this.passkeyLimit = maxPerAccount;
  }

  /** Founder desk scopes are added only when this directory says the user is a live founder. */
  useFounderDirectory(directory: { isFounder(userId: string, query?: Sql): Promise<boolean> } | undefined): void {
    this.founderDirectory = directory;
  }

  /**
   * The lead's founder-session grant. Blank grants nothing. A scope outside
   * the allowlist is refused here as well as at env parse.
   */
  useFounderSessionScopes(input: { readonly scopes: readonly Scope[]; readonly configValue: string } | undefined): void {
    const scopes = input?.scopes ?? [];
    for (const scope of scopes) {
      if (!(FOUNDER_SESSION_SCOPE_ALLOWLIST as readonly string[]).includes(scope)) {
        throw new Error(`identity.founder_scope_invalid: ${scope}`);
      }
    }
    this.founderSessionScopes = [...scopes];
    this.founderSessionConfigValue = input?.configValue ?? '';
  }

  private founderConfigHash(): string {
    return createHash('sha256').update(this.founderSessionConfigValue).digest('hex');
  }

  private async founderScopesOn(
    base: readonly Scope[],
    userId: string,
    mfa: boolean,
    query: Sql | undefined,
    gates: { readonly apiKey?: boolean; readonly subAccount?: boolean },
  ): Promise<{ scopes: Scope[]; founder: boolean; granted: Scope[] }> {
    let founder = false;
    try {
      founder = (await this.founderDirectory?.isFounder(userId, query)) === true;
    } catch {
      founder = false;
    }
    const scopes = scopesForFounderSession(base, {
      founder,
      mfa,
      apiKey: gates.apiKey === true,
      subAccount: gates.subAccount === true,
      configured: this.founderSessionScopes,
    });
    const granted = scopes.filter(
      (scope) => (FOUNDER_SESSION_SCOPE_ALLOWLIST as readonly string[]).includes(scope) && !base.includes(scope),
    );
    return { scopes, founder, granted };
  }

  /** One audit row for a live founder issuance. A non-founder writes nothing. */
  private async recordFounderScopeGrant(
    query: Sql,
    userId: string,
    sessionId: string,
    founder: boolean,
    granted: readonly Scope[],
  ): Promise<void> {
    if (!founder) return;
    await query`
      INSERT INTO founder_session_scope_audit (audit_id, user_id, session_id, scopes, config_hash)
      VALUES (${randomUUID()}, ${userId}, ${sessionId}, ${[...granted]}, ${this.founderConfigHash()})
    `;
  }

  /**
   * Session scopes, the owner pay grant, then the configured founder grant.
   * The pay lookup is a network call. Do not call this inside a session transaction.
   * Step-up does not call this: a step-up token never receives founder scopes.
   */
  private async scopesFor(userId: string, mfa: boolean, sessionId: string, extra: readonly Scope[] = [], query?: Sql): Promise<Scope[]> {
    const pay = await this.scopesForNewAccessToken(userId);
    const decided = await this.founderScopesOn([...pay, ...extra], userId, mfa, query, {});
    await this.recordFounderScopeGrant(query ?? this.sql, userId, sessionId, decided.founder, decided.granted);
    return decided.scopes;
  }

  private resetDeps() {
    return {
      sql: this.sql,
      mail: this.passwordResetMail,
      ttlSeconds: this.passwordResetTtlSeconds,
      maxAttempts: this.passwordResetMaxAttempts,
      requestMax: this.passwordResetRequestMax,
      requestWindowSeconds: this.passwordResetRequestWindowSeconds,
      subjectKey: this.flowSubjectKey,
      notifyUnknown: this.resetNotifyUnknown,
      now: this.passwordResetNow,
      log: this.log,
      afterCommit: this.mailRelayTrigger,
    };
  }

  /** Count a sign-in attempt (see attempt-lockout.ts); log once when this attempt is the one that sets a lock. */
  private async reserve(userId: string, kind: AttemptKind): Promise<void> {
    const { lockedForSeconds } = await reserveAttempt(this.sql, userId, kind);
    if (lockedForSeconds !== null) this.log.warn({ userId, kind, lockedForSeconds }, 'identity.account_locked');
  }

  /**
   * The user's TOTP secret in the clear, or null when the stored value cannot be
   * opened (key lost / rotated, corrupt ciphertext). Null makes the caller fall
   * through to recovery codes, so a lost key does not make the account
   * unrecoverable. The caller still answers `auth.mfa_invalid` on failure, so
   * nothing about the stored value reaches the client. One warn line, id only.
   */
  private tryOpenTotpSecret(userId: string, stored: string): string | null {
    try {
      return materializeTotpSecret(this.totpSecretKey, stored);
    } catch {
      this.log.warn({ userId }, 'identity.totp_secret_undecryptable');
      return null;
    }
  }

  /**
   * Check a TOTP or recovery code for a user whose `mfa` attempt is already
   * reserved. Throws `auth.mfa_invalid` when neither matches. Answers null for
   * an authenticator code, and the count of codes left when a recovery code was
   * spent, so the person can be told (I-signin-sessions-12).
   */
  private async verifyMfaCode(userId: string, storedSecret: string, code: string): Promise<{ recoveryCodesLeft: number } | null> {
    const secret = this.tryOpenTotpSecret(userId, storedSecret);
    if (secret !== null && matchTotpStep(secret, code) !== null) {
      await this.consumeTotpCode(userId, secret, code);
      return null;
    }
    const left = await this.tryRedeemRecoveryCode(userId, code);
    if (left === null) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    return { recoveryCodesLeft: left };
  }

  async register(input: RegisterInput): Promise<SessionTokens> {
    policyRefusal(() => {
      assertPasswordShape(input.password);
      assertPasswordNotIdentity(input.password, input);
      assertPasswordNotBreached(input.password);
    });
    const passwordHash = await hashPassword(input.password);
    const userId = await transaction(this.sql, (tx) => this.insertNewUser(tx, input, passwordHash));
    return this.finishRegistration(userId, input);
  }

  /** The user, profile and rank rows of a new account, inside the caller's transaction. */
  private async insertNewUser(tx: Sql, input: RegisterInput, passwordHash: string): Promise<string> {
    // A handle someone gave up in a change is never handed out again (PP-send-request-03); the claim lock is shared with
    // a handle change, so the check below sees settled rows.
    await lockHandleClaim(tx, input.handle);
    if (await handleRetiredByOther(tx, input.handle, null)) throw new AuthError('That handle is taken', 'auth.handle_taken');
    const clash = await tx<
      Array<{ handle: string; email: string }>
    >`SELECT handle, email FROM users WHERE handle = ${input.handle} OR email = ${input.email}`;
    for (const row of clash) {
      if (row.handle.toLowerCase() === input.handle.toLowerCase()) {
        throw new AuthError('That handle is taken', 'auth.handle_taken');
      }
      throw new AuthError('An account with that email already exists', 'auth.email_taken');
    }
    const inserted = await tx<
      Array<{ id: string }>
    >`INSERT INTO users (handle, email, password_hash) VALUES (${input.handle}, ${input.email}, ${passwordHash}) RETURNING id`;
    const id = inserted[0]!.id;
    await tx`INSERT INTO profiles (user_id, display_name, region) VALUES (${id}, ${input.handle}, ${input.region ?? null})`;
    await tx`INSERT INTO rank_state (user_id) VALUES (${id})`;
    return id;
  }

  /** After the account is committed: announce it, award the first XP, open a (non-MFA) session. */
  private async finishRegistration(userId: string, input: RegisterInput): Promise<SessionTokens> {
    await this.bus.publish(
      'userCreated',
      { userId, handle: input.handle, ...(input.region ? { region: input.region } : {}) },
      { idempotencyKey: `user.created:${userId}` },
    );
    await this.rank.awardXp({
      userId,
      sourceModule: 'identity',
      action: 'identity.registered',
      xpDelta: 50,
      idempotencyKey: `identity.registered:${userId}`,
    });
    // Sign-up trusts the device it happened on, so the first sign-in is never asked to approve itself.
    const device = await trustDevice(this.sql, this.newDevicePolicy, {
      userId,
      label: deviceLabel(currentUserAgent()),
      now: this.passwordResetNow(),
      trustedBy: 'sign-up',
      presentedKey: input.deviceKey,
    });
    const session = await this.issueSession(userId, { device: input.device, ip: input.ip, mfa: false, trustedDeviceId: device.id });
    return { ...session, deviceKey: device.key };
  }

  /**
   * FOUNDER ENROLMENT (`auth.registerFounder`, src/auth/founder-enrolment.ts).
   *
   * Creates an ordinary account, exactly like `register`, but gated by a
   * single-use invite instead of REGISTRATION_OPEN. The new account is NOT
   * privileged until the founder pair is pinned to its id, so the session may
   * enrol its first factor the normal way (factor-gate.ts is untouched).
   *
   * Order matters. The cheap refusals come first, before the argon2 hash that an
   * attacker could otherwise make us pay for with a bad code:
   *   closed (not configured, or the pair is pinned) → invalid → expired → used.
   * The invite is then consumed in the SAME transaction as the user insert,
   * behind a per-invite advisory lock, with the primary key as the backstop: one
   * invite makes one account and a race has exactly one winner. The losing
   * transaction rolls back its user row.
   *
   * Logging: one audit line, `founder.enrolled {userId}`. The invite, its hash
   * and the password are never logged, and the hash is never put next to an
   * email. The durable record is the `founder_invites_used` row (hash → user,
   * time), which is immutable.
   */
  async registerFounder(
    input: RegisterInput & { invite: string },
    config: FounderEnrolmentConfig | undefined,
    now: Date = new Date(),
  ): Promise<SessionTokens> {
    const closed = () => new AuthError('Founder enrolment is closed', 'auth.founder_enrolment_closed');
    if (!config) throw closed();
    if (await this.founderPairPinned(this.sql)) throw closed();
    const hash = matchInvite(input.invite, config.hashes);
    if (hash === null) throw new AuthError('That invite code is not valid', 'auth.invite_invalid');
    if (now.getTime() >= config.expiresAt.getTime()) throw new AuthError('That invite code has expired', 'auth.invite_expired');
    const usedError = () => new AuthError('That invite code has already been used', 'auth.invite_used');
    if (await this.founderInviteSpent(this.sql, hash)) throw usedError();

    policyRefusal(() => {
      assertPasswordShape(input.password);
      assertPasswordNotIdentity(input.password, input);
      assertPasswordNotBreached(input.password);
    });
    const passwordHash = await hashPassword(input.password);
    let userId: string;
    try {
      userId = await transaction(
        this.sql,
        async (tx) => {
          // Serialise every attempt on this invite, so the loser of a race gets
          // `invite_used` (not a unique-violation 500) and never half-creates a user.
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`founder-invite:${hash}`}, 0))`;
          // Re-read under the lock: the pair may have been pinned, the invite spent, while we hashed.
          if (await this.founderPairPinned(tx)) throw closed();
          if (await this.founderInviteSpent(tx, hash)) throw usedError();
          const id = await this.insertNewUser(tx, input, passwordHash);
          const claimed = await tx<
            Array<{ hash: string }>
          >`INSERT INTO founder_invites_used (hash, user_id) VALUES (${hash}, ${id}) ON CONFLICT (hash) DO NOTHING RETURNING hash`;
          if (claimed.length !== 1) throw usedError();
          return id;
        },
        { isolation: 'read committed' },
      );
    } catch (err) {
      // Two founders racing different invites for the same handle/email: the unique index decides.
      if (isUniqueViolation(err)) {
        if (/founder_invites_used/.test(uniqueConstraintName(err))) throw usedError();
        throw new AuthError(
          /email/i.test(uniqueConstraintName(err)) ? 'An account with that email already exists' : 'That handle is taken',
          /email/i.test(uniqueConstraintName(err)) ? 'auth.email_taken' : 'auth.handle_taken',
        );
      }
      throw err;
    }
    this.log.warn({ audit: 'founder.enrolled', userId }, 'founder.enrolled');
    return this.finishRegistration(userId, input);
  }

  /**
   * Is founder enrolment open right now? True only while ALL hold: the invites
   * are configured (hashes and expiry), the founder pair is not pinned, the
   * expiry has not passed, and at least one invite is unspent. Reveals nothing else.
   */
  async founderEnrolmentOpen(config: FounderEnrolmentConfig | undefined, now: Date = new Date()): Promise<boolean> {
    if (!config) return false;
    if (now.getTime() >= config.expiresAt.getTime()) return false;
    if (await this.founderPairPinned(this.sql)) return false;
    const spent = await this.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM founder_invites_used WHERE hash IN ${this.sql(config.hashes as string[])}`;
    return (spent[0]?.n ?? 0) < config.hashes.length;
  }

  /** The founder pair is pinned permanently by the first verified boot (founder-controls.ts). */
  private async founderPairPinned(q: Sql): Promise<boolean> {
    const rows = await q<Array<{ pinned: boolean }>>`SELECT true AS pinned FROM founder_control_configuration LIMIT 1`;
    return rows.length > 0;
  }

  private async founderInviteSpent(q: Sql, hash: string): Promise<boolean> {
    const rows = await q<Array<{ hash: string }>>`SELECT hash FROM founder_invites_used WHERE hash = ${hash}`;
    return rows.length > 0;
  }

  async login(input: {
    identifier: string;
    password: string;
    totpCode?: string;
    device?: string;
    ip?: string;
    deviceKey?: string | null;
  }): Promise<SessionTokens> {
    const user = await this.passFirstFactor(input);
    // A locked-out reset whose wait has passed completes at a sign-in by password alone: the authenticator app goes, with
    // every session. A sign-in that brings a code is the person who still has the app or a recovery code.
    const reset = user.totp_secret !== null && !input.totpCode && (await completeDueMfaReset(this.mfaResetDeps(), user.id));
    if (reset) await syncNavigatorSessionsClosedForUser(this.sql, user.id);
    const { mfa, recoveryCodesLeft } = await this.passSecondStep(reset ? { ...user, totp_secret: null } : user, input.totpCode);
    const device = await this.gateDeviceAfterSecondStep(user.id, { mfa, recoveryCodesLeft }, input.deviceKey);
    const session = await this.issueSession(user.id, { device: input.device, ip: input.ip, mfa, trustedDeviceId: device.trustedDeviceId });
    return withSecondStep(session, device.deviceKey, recoveryCodesLeft);
  }

  /**
   * The password as the first factor, for sign-in and for the locked-out reset: counted on the password lockout before it
   * is checked, the same answer for an unknown name and a wrong password, the account state named only after it verified.
   */
  private async passFirstFactor(input: { identifier: string; password: string }): Promise<{
    id: string;
    password_hash: string;
    status: string;
    totp_secret: string | null;
    passkey_second_step: boolean;
    webauthn_creds: unknown;
  }> {
    const rows = await this.sql<
      Array<{
        id: string;
        password_hash: string;
        status: string;
        totp_secret: string | null;
        passkey_second_step: boolean;
        webauthn_creds: unknown;
      }>
    >`SELECT id, password_hash, status, totp_secret, passkey_second_step, webauthn_creds FROM users
      WHERE handle = ${input.identifier} OR email = ${input.identifier}`;
    const user = rows[0];
    // Reserve the password guess BEFORE verifying it (see attempt-lockout.ts). Unknown
    // identifiers have no row and keep answering `invalid_credentials`. A locked
    // account still pays the password-hash cost (against the dummy hash) so timing
    // does not separate locked from wrong from unknown.
    let locked: AuthError | undefined;
    if (user) {
      try {
        await this.reserve(user.id, 'password');
      } catch (err) {
        if (!(err instanceof AuthError) || err.code !== 'auth.too_many_attempts') throw err;
        locked = err;
      }
    }
    const storedHash = user && !locked ? user.password_hash : await dummyPasswordHash();
    const passwordOk = await verifyPassword(storedHash, input.password);
    if (locked) throw locked;
    if (!user || !passwordOk) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    // The password verified: it is no longer a guess. Clear its counter NOW, before the
    // two-step TOTP flow (password first, code second), so a correct password is never
    // left counting against the owner. The mfa counter is separate and stays.
    await recordSuccess(this.sql, user.id, 'password');
    // Named only to someone who just proved the password, so the state is never a probe. A closed
    // account cannot be restored (founder-controls.ts `restore.not_permitted`); a frozen one can.
    // After recordSuccess, so the owner of a frozen account is never locked out of reading why.
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen', accountStateOf(user.status));
    // The password verified, so its hash is upgraded now, whichever second step follows (a passkey one never comes back here).
    if (await needsRehash(user.password_hash)) {
      const upgraded = await hashPassword(input.password);
      await this.sql`UPDATE users SET password_hash = ${upgraded}, updated_at = now() WHERE id = ${user.id}`;
    }
    return user;
  }

  /**
   * The second step after a first factor (the password, a mailed code or a linked provider). An account with an
   * authenticator needs its code; a passkey that answers for sign-in is offered beside it, and is the second step on its
   * own when the account asked for a passkey after its password (I-signin-sessions-10). With no code sent, the refusal
   * names the steps that answer and carries a passkey challenge for `loginSecondStepPasskey`. Returns whether a second
   * factor passed here, and how many recovery codes are left when the code given was one of them.
   */
  private async passSecondStep(
    user: { id: string; totp_secret: string | null; passkey_second_step: boolean; webauthn_creds: unknown },
    totpCode: string | undefined,
  ): Promise<{ mfa: boolean; recoveryCodesLeft?: number }> {
    const signinPasskeys = credentialsFor(asCredentialList(user.webauthn_creds), 'signin');
    const passkeyStep = signinPasskeys.length > 0 && (user.totp_secret !== null || user.passkey_second_step);
    if (!totpCode && (user.totp_secret !== null || passkeyStep)) {
      throw new AuthError('Second step required', 'auth.mfa_required', {
        secondStep: {
          totp: user.totp_secret !== null,
          passkey: passkeyStep ? await this.secondStepChallenge(user.id, signinPasskeys) : null,
        },
      });
    }
    if (user.totp_secret) {
      // Counted before the code is looked at; a locked account is refused here without consuming a step or a recovery code.
      await this.reserve(user.id, 'mfa');
      const recovery = await this.verifyMfaCode(user.id, user.totp_secret, totpCode!);
      await recordSuccess(this.sql, user.id, 'mfa');
      // The app or a recovery code still works for this person: a locked-out reset of it stops, with its notice.
      await stopMfaResetByProof(this.mfaResetDeps(), user.id);
      return { mfa: true, ...recovery };
    }
    if (passkeyStep) {
      // A code sent to an account that asked for a passkey and has no authenticator is a wrong second step.
      await this.reserve(user.id, 'mfa');
      throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    }
    return { mfa: false };
  }

  /** A single-use passkey challenge for the second step, bound to the account whose password just verified. */
  private async secondStepChallenge(userId: string, credentials: readonly StoredWebAuthnCredential[]): Promise<AuthenticationOptionsJSON> {
    const challenge = generateChallenge();
    await this.challenges.put('second-step', challenge, userId, SECOND_STEP_CHALLENGE_TTL_MS);
    return createAuthenticationOptions(this.webauthn, credentials, challenge);
  }

  /**
   * The second step by passkey (I-signin-sessions-10), after `login` answered `auth.mfa_required` with a passkey
   * challenge. The challenge names the account; only a passkey of that account that answers for sign-in is accepted, so
   * another person's passkey, or this person's passkey bound to other actions, is refused. Each try counts on the same
   * MFA lockout as a code. The session it opens has passed two factors.
   */
  async loginSecondStepPasskey(input: {
    credential: AuthenticationResponseJSON;
    device?: string;
    ip?: string;
    deviceKey?: string | null;
  }): Promise<SessionTokens> {
    const refuse = (): never => {
      throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
    };
    const clientChallenge = readClientChallenge(input.credential.response.clientDataJSON);
    if (!clientChallenge) return refuse();
    const held = await this.challenges.take(clientChallenge, 'second-step');
    // An expired or spent challenge (or one this service never issued) asks for the password again.
    if (!held?.userId) throw new AuthError('This sign-in step timed out', 'auth.second_step_expired');
    const userId = held.userId;
    const [user] = await this.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId}`;
    if (!user) return refuse();
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen', accountStateOf(user.status));
    await this.reserve(userId, 'mfa');
    await this.verifyAssertionAndAdvanceCounter(userId, held.challenge, input.credential, refuse, 'signin');
    await recordSuccess(this.sql, userId, 'mfa');
    const device = await this.gateDevice(userId, true, input.deviceKey);
    const session = await this.issueSession(userId, {
      device: input.device,
      ip: input.ip,
      mfa: true,
      trustedDeviceId: device.trustedDeviceId,
    });
    return device.deviceKey ? { ...session, deviceKey: device.deviceKey } : session;
  }

  /**
   * Open a session for an account whose identity a trusted outside party has just confirmed (a linked
   * provider identity). The second factor is still required: an account with TOTP needs its code,
   * counted and checked the same way as `login`, and a session without one is not marked `mfa`.
   */
  async signInVerifiedIdentity(
    userId: string,
    input: { totpCode?: string; device?: string; ip?: string; deviceKey?: string | null },
  ): Promise<SessionTokens> {
    const [user] = await this.sql<
      Array<{ id: string; status: string; totp_secret: string | null; passkey_second_step: boolean; webauthn_creds: unknown }>
    >`SELECT id, status, totp_secret, passkey_second_step, webauthn_creds FROM users WHERE id = ${userId}`;
    if (!user) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    // The provider proved the identity, so the state is named as on password sign-in.
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen', accountStateOf(user.status));
    const { mfa, recoveryCodesLeft } = await this.passSecondStep(user, input.totpCode);
    const device = await this.gateDeviceAfterSecondStep(user.id, { mfa, recoveryCodesLeft }, input.deviceKey);
    const session = await this.issueSession(user.id, { device: input.device, ip: input.ip, mfa, trustedDeviceId: device.trustedDeviceId });
    return withSecondStep(session, device.deviceKey, recoveryCodesLeft);
  }

  /** Wallet messages are written for the same origins passkeys answer on (WEBAUTHN_ORIGIN). */
  walletConfig(): WalletConfig {
    return { origins: [this.webauthn.origin].flat() };
  }

  /**
   * Wallet sign-in, step 1 (I-account-lifecycle-07): the message the wallet signs. The same answer for a wallet that is
   * linked and one that is not, so it tells a caller nothing.
   */
  async walletSigninChallenge(input: { address: string; chainId: number; origin?: string }) {
    return startWalletChallenge(this.sql, this.walletConfig(), { purpose: 'signin', ...input });
  }

  /**
   * Wallet sign-in, step 2: a signature from a wallet the account linked proves the person, as a linked provider does,
   * and the second step still follows. An unlinked wallet is refused as a wrong password is.
   */
  async loginWithWallet(input: {
    flowId: string;
    message: string;
    signature: string;
    totpCode?: string;
    device?: string;
    ip?: string;
    deviceKey?: string | null;
  }): Promise<SessionTokens> {
    const userId = await walletSigninAccount(this.sql, this.walletConfig(), input);
    if (!userId) throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    return this.signInVerifiedIdentity(userId, {
      ...(input.totpCode === undefined ? {} : { totpCode: input.totpCode }),
      ...(input.device === undefined ? {} : { device: input.device }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      deviceKey: input.deviceKey ?? null,
    });
  }

  /**
   * The sign-in (`fam`) and trusted device (`dev`) of the user's own live session, for a token minted from it outside
   * sign-in and refresh (step-up). A session that is not the user's, was revoked or has expired mints nothing.
   */
  private async sessionClaimsOf(userId: string, sessionId: string): Promise<{ familyId: string; trustedDeviceId: string | null }> {
    const rows = await this.sql<Array<{ family_id: string; trusted_device_id: string | null }>>`
      SELECT family_id, trusted_device_id FROM sessions
      WHERE id = ${sessionId} AND user_id = ${userId} AND revoked = false AND expires_at > now()
    `;
    const row = rows[0];
    if (!row) throw new AuthError('Session not found', 'auth.session_invalid');
    return { familyId: row.family_id, trustedDeviceId: row.trusted_device_id };
  }

  private async issueSession(
    userId: string,
    options: { device?: string | undefined; ip?: string | undefined; mfa: boolean; trustedDeviceId?: string | null },
  ): Promise<SessionTokens> {
    const refreshToken = generateToken(48);
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000);
    const inserted = await transaction(
      this.sql,
      async (tx) => {
        const [user] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId} FOR UPDATE`;
        if (!user || user.status !== 'active') throw new AuthError('Account is unavailable', 'auth.account_frozen');
        return tx<
          Array<{ id: string; family_id: string }>
        >`INSERT INTO sessions (user_id, refresh_hash, device, ip, user_agent, mfa, expires_at, trusted_device_id) VALUES (${userId}, ${hashToken(refreshToken)}, ${options.device ?? null}, ${options.ip ?? currentRequestIp()}, ${currentUserAgent()}, ${options.mfa}, ${expiresAt}, ${options.trustedDeviceId ?? null}) RETURNING id, family_id`;
      },
      { isolation: 'read committed' },
    );
    const sessionId = inserted[0]!.id;
    const familyId = inserted[0]!.family_id;
    void syncNavigatorSessionOpen(this.sql, sessionId, userId);
    // Pay is not on the sign-in path. A slow or refused claim must not delay or fail the session.
    void this.claimConfirmedEmailInvites(userId).catch((err: unknown) => {
      this.log.warn({ userId, reason: err instanceof Error ? err.name : 'error' }, 'merchant email invite claim failed');
    });
    const tier = await this.kycTier(userId);
    const scopes = await this.scopesFor(userId, options.mfa, sessionId);
    const { token: accessToken, expiresAt: accessExpiresAt } = await issueAccessToken(
      { userId, sessionId, scopes, tier, mfa: options.mfa, familyId, trustedDeviceId: options.trustedDeviceId ?? null },
      this.tokens,
    );
    return { accessToken, refreshToken, expiresAt: accessExpiresAt, sessionId, userId, mfaRequired: false };
  }

  async refresh(refreshToken: string, options: { device?: string; ip?: string } = {}): Promise<SessionTokens> {
    const hash = hashToken(refreshToken);
    // Resolve the owner grant before the row lock. A pay round trip must not
    // sit inside the session transaction.
    const peek = this.ownerPayScopeSource
      ? await this.sql<Array<{ user_id: string }>>`SELECT user_id FROM sessions WHERE refresh_hash = ${hash} LIMIT 1`
      : [];
    const peekedUserId = peek[0]?.user_id;
    const peekedScopes = peekedUserId ? await this.scopesForNewAccessToken(peekedUserId) : null;
    type RefreshRow = {
      id: string;
      user_id: string;
      revoked: boolean;
      mfa: boolean;
      expires_at: Date;
      user_status: string;
      rotated_at: Date | null;
      successor_id: string | null;
      successor_refresh: string | null;
      device: string | null;
      family_id: string;
      ip: string | null;
      user_agent: string | null;
      trusted_device_id: string | null;
    };
    type RefreshOutcome =
      | { kind: 'reuse'; userId: string; sessionId: string }
      | { kind: 'frozen'; userId: string; sessionId: string; status: string }
      | { kind: 'expired'; sessionId: string }
      | { kind: 'grace'; tokens: SessionTokens }
      | {
          kind: 'recovered';
          tokens: SessionTokens;
          userId: string;
          predecessorId: string;
          successorId: string;
          ageSeconds: number;
        }
      | { kind: 'rotated'; previousSessionId: string; tokens: SessionTokens };
    const result = await transaction<RefreshOutcome>(this.sql, async (tx) => {
      const rows = await tx<
        RefreshRow[]
      >`SELECT s.id, s.user_id, s.revoked, s.mfa, s.expires_at, u.status AS user_status, s.rotated_at, s.successor_id, s.successor_refresh, s.device, s.family_id, s.ip, s.user_agent, s.trusted_device_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash = ${hash} FOR UPDATE OF s, u`;
      const session = rows[0];
      if (!session) throw new AuthError('Session not found', 'auth.session_invalid');
      if (session.revoked) {
        // disable-user freezes the account and leaves sessions live, so the
        // successor of a rotation inside the grace window is still usable.
        // Refuse before any token is minted, and revoke that successor here.
        if (session.user_status !== 'active') {
          if (session.successor_id) {
            await tx`UPDATE sessions SET revoked = true WHERE id = ${session.successor_id}`;
          }
          return { kind: 'frozen', userId: session.user_id, sessionId: session.id, status: session.user_status };
        }
        const grace = await this.graceTokens(tx, session, session.user_id === peekedUserId ? peekedScopes : null);
        if (grace) return { kind: 'grace', tokens: grace };
        const recovered = await this.recoverTokens(tx, session, session.user_id === peekedUserId ? peekedScopes : null, options.device);
        if (recovered) {
          return {
            kind: 'recovered',
            tokens: recovered.tokens,
            userId: session.user_id,
            predecessorId: session.id,
            successorId: recovered.tokens.sessionId,
            ageSeconds: recovered.ageSeconds,
          };
        }
        // A rotation stamps the predecessor. Presenting that token again,
        // outside the grace window and outside a published recovery window,
        // is reuse and burns every live session. Logout and other explicit
        // revokes leave no stamp: the token is dead, and saying so must not
        // sign the person out elsewhere.
        if (!session.rotated_at && !session.successor_id) {
          throw new AuthError('Session not found', 'auth.session_invalid');
        }
        return { kind: 'reuse', userId: session.user_id, sessionId: session.id };
      }
      if (session.expires_at.getTime() < Date.now()) {
        await tx`UPDATE sessions SET revoked = true WHERE id = ${session.id}`;
        return { kind: 'expired', sessionId: session.id };
      }
      if (session.user_status !== 'active') {
        await tx`UPDATE sessions SET revoked = true WHERE id = ${session.id}`;
        return { kind: 'frozen', userId: session.user_id, sessionId: session.id, status: session.user_status };
      }
      const rotatedAt = new Date();
      await tx`UPDATE sessions SET revoked = true, last_used_at = now(), rotated_at = ${rotatedAt} WHERE id = ${session.id}`;
      // The row that still holds a sealed copy of THIS session's refresh token
      // is no longer pointing at the tip. Drop that copy in the same transaction,
      // scoped to the user so it uses sessions_user_idx.
      await clearPredecessorSeal(tx, session.user_id, session.id);
      const nextToken = generateToken(48);
      // Absolute lifetime of the family (I-signin-sessions-06, ENGINE X-8): a rotation never extends the expiry the
      // family's first login was given, so refreshing cannot keep a family alive forever. The owner's own absolute
      // lifetime setting is not published, so the refresh TTL measured from the first login is the bound.
      const expiresAt = new Date(Math.min(Date.now() + this.tokens.refreshTtlSeconds * 1000, session.expires_at.getTime()));
      // The successor stays on the predecessor's trusted device (I-signin-sessions-07).
      const nextSession = await tx<
        Array<{ id: string }>
      >`INSERT INTO sessions (user_id, family_id, refresh_hash, device, ip, user_agent, mfa, expires_at, trusted_device_id) VALUES (${session.user_id}, ${session.family_id}, ${hashToken(nextToken)}, ${options.device ?? session.device}, ${options.ip ?? currentRequestIp() ?? session.ip}, ${currentUserAgent() ?? session.user_agent}, ${session.mfa}, ${expiresAt}, ${session.trusted_device_id}) RETURNING id`;
      const sessionId = nextSession[0]!.id;
      await tx`UPDATE sessions SET successor_id = ${sessionId}, successor_refresh = ${sealRefreshToken(this.tokens.secret, nextToken)} WHERE id = ${session.id}`;
      const tier = await this.kycTier(session.user_id, tx);
      // Pay was resolved before the row lock. Do not call svc-pay again inside this transaction.
      const payScopes = session.user_id === peekedUserId && peekedScopes ? peekedScopes : this.defaultScopes();
      const decided = await this.founderScopesOn(payScopes, session.user_id, session.mfa, tx, {});
      await this.recordFounderScopeGrant(tx, session.user_id, sessionId, decided.founder, decided.granted);
      const scopes = decided.scopes;
      const { token: accessToken, expiresAt: accessExpiresAt } = await issueAccessToken(
        {
          userId: session.user_id,
          sessionId,
          scopes,
          tier,
          mfa: session.mfa,
          familyId: session.family_id,
          trustedDeviceId: session.trusted_device_id,
        },
        this.tokens,
      );
      return {
        kind: 'rotated',
        previousSessionId: session.id,
        tokens: {
          accessToken,
          refreshToken: nextToken,
          expiresAt: accessExpiresAt,
          sessionId,
          userId: session.user_id,
          mfaRequired: false,
        },
      };
    });
    if (result.kind === 'grace') return result.tokens;
    if (result.kind === 'recovered') {
      this.log.warn(
        {
          userId: result.userId,
          predecessorId: result.predecessorId,
          successorId: result.successorId,
          ageSeconds: result.ageSeconds,
        },
        'auth.refresh_recovered',
      );
      return result.tokens;
    }
    if (result.kind === 'reuse') {
      await this.sql`UPDATE sessions SET revoked = true, reuse_detected_at = now() WHERE user_id = ${result.userId} AND revoked = false`;
      await this.sql`UPDATE sessions SET reuse_detected_at = now() WHERE id = ${result.sessionId}`;
      await syncNavigatorSessionsClosedForUser(this.sql, result.userId);
      throw new AuthError('Refresh token reuse detected — all sessions revoked', 'auth.session_reused');
    }
    if (result.kind === 'frozen') {
      await this.sql`UPDATE sessions SET revoked = true WHERE id = ${result.sessionId}`;
      await syncNavigatorSessionClosed(this.sql, result.sessionId);
      throw new AuthError(`Account is ${result.status}`, 'auth.account_frozen');
    }
    if (result.kind === 'expired') {
      await syncNavigatorSessionClosed(this.sql, result.sessionId);
      throw new AuthError('Session expired', 'auth.session_invalid');
    }
    await syncNavigatorSessionClosed(this.sql, result.previousSessionId);
    void syncNavigatorSessionOpen(this.sql, result.tokens.sessionId, result.tokens.userId);
    return result.tokens;
  }

  /**
   * Second tab, same cookie, inside the grace window. The row lock on the
   * predecessor serialises two refreshes: the loser sees the successor the
   * winner committed and returns that refresh token plus a new access token
   * for the same successor session. Outside the window the caller either
   * recovers a lost reply or burns the family.
   */
  private async graceTokens(
    tx: Sql,
    session: {
      rotated_at: Date | null;
      successor_id: string | null;
      successor_refresh: string | null;
      user_id: string;
    },
    peekedScopes: readonly Scope[] | null,
  ): Promise<SessionTokens | null> {
    if (this.reuseGraceMs <= 0 || !session.rotated_at || !session.successor_id || !session.successor_refresh) return null;
    if (Date.now() - session.rotated_at.getTime() > this.reuseGraceMs) return null;
    const nextToken = this.openSealedSuccessor(session.rotated_at, session.successor_refresh);
    if (!nextToken) return null;
    const rows = await tx<
      Array<{
        id: string;
        user_id: string;
        revoked: boolean;
        mfa: boolean;
        expires_at: Date;
        family_id: string;
        trusted_device_id: string | null;
      }>
    >`
      SELECT id, user_id, revoked, mfa, expires_at, family_id, trusted_device_id FROM sessions WHERE id = ${session.successor_id} FOR UPDATE
    `;
    const successor = rows[0];
    if (!successor || successor.revoked || successor.expires_at.getTime() < Date.now()) return null;
    const tier = await this.kycTier(successor.user_id, tx);
    const scopes = successor.user_id === session.user_id && peekedScopes ? peekedScopes : this.defaultScopes();
    const { token: accessToken, expiresAt: accessExpiresAt } = await issueAccessToken(
      {
        userId: successor.user_id,
        sessionId: successor.id,
        scopes,
        tier,
        mfa: successor.mfa,
        familyId: successor.family_id,
        trustedDeviceId: successor.trusted_device_id,
      },
      this.tokens,
    );
    return {
      accessToken,
      refreshToken: nextToken,
      expiresAt: accessExpiresAt,
      sessionId: successor.id,
      userId: successor.user_id,
      mfaRequired: false,
    };
  }

  /**
   * Lost reply, past the grace window, inside the owner-published recovery
   * window. Same row locks as `refresh`: the predecessor is already locked,
   * and the successor is locked here, so a concurrent rotation of that
   * successor cannot commit beside this read. Any doubt returns null and the
   * caller burns the family. Does not rotate, revoke, or insert.
   */
  private async recoverTokens(
    tx: Sql,
    session: {
      id: string;
      user_id: string;
      user_status: string;
      rotated_at: Date | null;
      successor_id: string | null;
      successor_refresh: string | null;
      device: string | null;
    },
    peekedScopes: readonly Scope[] | null,
    requestDevice: string | undefined,
  ): Promise<{ tokens: SessionTokens; ageSeconds: number } | null> {
    if (this.recoveryMs <= 0) return null;
    if (session.user_status !== 'active') return null;
    if (!session.rotated_at || !session.successor_id || !session.successor_refresh) return null;
    if (!this.deviceAllowsRecovery(session.device, requestDevice)) return null;
    const age = Date.now() - session.rotated_at.getTime();
    if (!Number.isFinite(age) || age <= this.reuseGraceMs || age > this.recoveryMs) return null;
    const nextToken = this.openSealedSuccessor(session.rotated_at, session.successor_refresh);
    if (!nextToken) return null;
    const rows = await tx<
      Array<{
        id: string;
        user_id: string;
        revoked: boolean;
        mfa: boolean;
        expires_at: Date;
        rotated_at: Date | null;
        successor_id: string | null;
        family_id: string;
        trusted_device_id: string | null;
      }>
    >`
      SELECT id, user_id, revoked, mfa, expires_at, rotated_at, successor_id, family_id, trusted_device_id
      FROM sessions WHERE id = ${session.successor_id} FOR UPDATE
    `;
    const successor = rows[0];
    if (!successor || successor.user_id !== session.user_id) return null;
    if (successor.revoked !== false) return null;
    if (successor.rotated_at !== null) return null;
    if (successor.successor_id !== null) return null;
    if (successor.expires_at.getTime() <= Date.now()) return null;
    const tier = await this.kycTier(successor.user_id, tx);
    const scopes = successor.user_id === session.user_id && peekedScopes ? peekedScopes : this.defaultScopes();
    const { token: accessToken, expiresAt: accessExpiresAt } = await issueAccessToken(
      {
        userId: successor.user_id,
        sessionId: successor.id,
        scopes,
        tier,
        mfa: successor.mfa,
        familyId: successor.family_id,
        trustedDeviceId: successor.trusted_device_id,
      },
      this.tokens,
    );
    return {
      tokens: {
        accessToken,
        refreshToken: nextToken,
        expiresAt: accessExpiresAt,
        sessionId: successor.id,
        userId: successor.user_id,
        mfaRequired: false,
      },
      ageSeconds: Math.floor(age / 1000),
    };
  }

  /**
   * Open a sealed successor token only while it is still inside the longer of
   * the grace and recovery windows. Older ciphertext is ignored even if the
   * column still holds it. A bad seal returns null (fail closed).
   */
  private openSealedSuccessor(rotatedAt: Date, sealed: string): string | null {
    const age = Date.now() - rotatedAt.getTime();
    if (!Number.isFinite(age)) return null;
    if (age > Math.max(this.reuseGraceMs, this.recoveryMs)) return null;
    if (typeof sealed !== 'string' || sealed.length === 0) return null;
    return openRefreshToken(this.tokens.secret, sealed);
  }

  /**
   * The device check applies only when the predecessor stored a label and the
   * request carries one. A mismatch, or a request device that is not a string,
   * refuses recovery.
   */
  private deviceAllowsRecovery(stored: string | null, presented: string | undefined): boolean {
    if (presented !== undefined && typeof presented !== 'string') return false;
    const storedLabel = typeof stored === 'string' && stored.length > 0 ? stored : null;
    const presentedLabel = typeof presented === 'string' && presented.length > 0 ? presented : null;
    if (storedLabel !== null && presentedLabel !== null && storedLabel !== presentedLabel) return false;
    return true;
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = hashToken(refreshToken);
    const rows = await this.sql<Array<{ id: string; successor_id: string | null }>>`
      SELECT id, successor_id FROM sessions WHERE refresh_hash = ${hash} LIMIT 1
    `;
    const root = rows[0];
    if (!root) return;
    await this.sql`
      WITH RECURSIVE chain AS (
        SELECT id, successor_id FROM sessions WHERE id = ${root.id}
        UNION ALL
        SELECT s.id, s.successor_id FROM sessions s
        INNER JOIN chain c ON s.id = c.successor_id
        WHERE c.successor_id IS NOT NULL
      )
      UPDATE sessions SET revoked = true WHERE id IN (SELECT id FROM chain)
    `;
    await syncNavigatorSessionClosed(this.sql, root.id);
    if (root.successor_id) await syncNavigatorSessionClosed(this.sql, root.successor_id);
  }

  async logoutAll(userId: string): Promise<number> {
    const result = await this.sql`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
    if (result.count > 0) await syncNavigatorSessionsClosedForUser(this.sql, userId);
    return result.count;
  }

  /**
   * CHANGE PASSWORD (signed-in user).
   *
   * Failures this prevents:
   *  - a stolen session (or a leaked API key) taking the account over by setting a
   *    new password: it needs the CURRENT password, and an API key / sub-account
   *    principal is refused outright (it is not a person at a keyboard);
   *  - a stolen password plus a non-MFA session doing the same on an account that
   *    has a second factor: any TOTP / passkey on the account requires the `mfa`
   *    claim (TOTP or passkey login, or a fresh `auth.stepUp` token). An account
   *    with NO second factor may change the password with the current one alone;
   *  - the current password being brute-forced through this door: the guess is
   *    reserved on the same per-account `password` counter as login BEFORE it is
   *    verified, so the two doors share one budget;
   *  - the old password living on in other devices: every OTHER session is revoked
   *    in the same transaction as the hash update. The calling session stays.
   *
   * Order: gate (delegated / MFA) → reserve → verify current → policy → not-the-same
   * → one transaction (re-check the hash we verified, write, revoke others, clear
   * the counter). A wrong current password answers `auth.invalid_credentials`,
   * identical to login. Entitlements (`operatorStatus`) are not touched: this writes
   * only `users.password_hash` and `sessions`.
   *
   * AUDIT: no durable auth-audit table or password-changed bus event exists yet, so
   * the record is the service's structured log line `auth.password_changed`
   * (same sink as `identity.account_locked`). User id and counts only, never a secret.
   */
  async changePassword(input: {
    userId: string;
    sessionId: string;
    actor: FactorActor;
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    const { userId, sessionId, actor } = input;
    // Delegated principals first: refused before any lookup, so it cannot probe ids.
    if (actor.delegated) {
      throw new AuthError('Sign in yourself to change your password; an API key or sub-account cannot', 'auth.mfa_required');
    }
    const rows = await this.sql<
      Array<{ password_hash: string; status: string; totp_secret: string | null; webauthn_creds: unknown; handle: string; email: string }>
    >`SELECT password_hash, status, totp_secret, webauthn_creds, handle, email FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    // Second factor on the account, or a privileged identity (founder pair / `admin:*`
    // scope, which never gets the no-factor exception): the session must have passed it. Checked before the
    // reservation so a missing step-up never spends the password budget.
    if ((accountHasSecondFactor(user) || actor.privileged) && !actor.mfa) {
      throw new AuthError('Verify with your second factor before changing your password', 'auth.mfa_required');
    }
    // The owner's security lock (W-withdraw-09) stops password changes. Checked before the reservation so a locked
    // account spends no guess; re-checked under the row lock below, which is the authority.
    await assertNotSecurityLocked(this.sql, userId);
    // Count the guess BEFORE verifying it (see attempt-lockout.ts); a locked account is refused here.
    await this.reserve(userId, 'password');
    if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    }
    // The current password verified, so it is no longer a guess: a policy or same-password
    // refusal below must not count toward the lock.
    await recordSuccess(this.sql, userId, 'password');
    try {
      assertPasswordShape(input.newPassword);
      assertPasswordNotIdentity(input.newPassword, user);
      assertPasswordNotBreached(input.newPassword);
    } catch (err) {
      if (err instanceof WeakPasswordError) throw new AuthError(err.message, err.code);
      throw err;
    }
    if (input.newPassword === input.currentPassword) {
      throw new AuthError('The new password must differ from the current one', 'auth.password_unchanged');
    }
    const nextHash = await hashPassword(input.newPassword);
    const { revokedIds, noticed } = await transaction(this.sql, async (tx) => {
      const locked = await tx<
        Array<{ password_hash: string; status: string }>
      >`SELECT password_hash, status FROM users WHERE id = ${userId} FOR UPDATE`;
      // A parallel change already moved the hash: the password we verified is no longer the current one.
      if (!locked[0] || locked[0].password_hash !== user.password_hash) {
        throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
      }
      if (locked[0].status !== 'active') throw new AuthError(`Account is ${locked[0].status}`, 'auth.account_frozen');
      await assertNotSecurityLocked(tx, userId);
      const live = await tx<
        Array<{ id: string }>
      >`SELECT id FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND revoked = false AND expires_at > now()`;
      if (!live[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');
      await tx`UPDATE users SET password_hash = ${nextHash}, updated_at = now() WHERE id = ${userId}`;
      const revoked = await tx<
        Array<{ id: string }>
      >`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false AND id <> ${sessionId} RETURNING id`;
      await recordSuccess(tx, userId, 'password');
      const noticed = await queuePasswordChangedNotice(tx, { userId, now: this.passwordResetNow() });
      return { revokedIds: revoked.map((r) => r.id), noticed };
    });
    // The change has committed: a relay that fails to start now must not make it look refused. The timer relay sends it.
    if (noticed) await Promise.resolve(this.mailRelayTrigger?.()).catch(() => undefined);
    for (const id of revokedIds) await syncNavigatorSessionClosed(this.sql, id);
    this.log.warn({ userId, sessionId, otherSessionsRevoked: revokedIds.length }, 'auth.password_changed');
  }

  /**
   * Signed-out reset, step 1. Same answer for every address. No session, no hash change.
   * The one-time code goes to the mail port only.
   */
  async requestPasswordReset(input: { email: string }): Promise<{ accepted: true }> {
    return requestPasswordReset(this.resetDeps(), input);
  }

  /** Same shape as `requestPasswordReset`: the username goes to a known address, a notice (if on) to any other. */
  async requestHandleRecovery(input: { email: string }): Promise<{ accepted: true }> {
    return requestHandleRecovery(this.resetDeps(), input);
  }

  /** Signed-in. Mails a one-time link to this account's own address. Never returns the token. */
  async requestEmailConfirmation(input: { userId: string }): Promise<{ accepted: true }> {
    return requestEmailConfirmation(this.emailConfirmDeps(), input);
  }

  /** Public link. Sets `email_verified_at` once for the account the token was issued to. */
  async confirmEmail(input: { token: string }): Promise<{ userId: string }> {
    const confirmed = await confirmEmail(this.emailConfirmDeps(), input);
    await this.claimConfirmedEmailInvites(confirmed.userId);
    return confirmed;
  }

  /**
   * Signed-out reset, step 2. A correct proof replaces the hash and ends every
   * session. This call does not sign the person in.
   */
  async completePasswordReset(input: { email: string; code: string; newPassword: string }): Promise<void> {
    const result = await completePasswordReset(this.resetDeps(), input);
    if (result.sessionsRevoked > 0) await syncNavigatorSessionsClosedForUser(this.sql, result.userId);
    this.log.warn({ userId: result.userId, sessionsRevoked: result.sessionsRevoked }, 'auth.password_reset');
  }

  /**
   * Owner's own freeze. Needs the current password (counted like any password guess) and a signed-in person,
   * never an API key or sub-account. Revokes every session and API key and records one open freeze in one
   * transaction. A repeat while one is open changes nothing. A staff-frozen account may still self-freeze; this
   * adds a state and never lifts the staff one. Moves no money and does not touch the ledger.
   */
  async selfFreeze(input: {
    userId: string;
    actor: FactorActor;
    reason: SelfFreezeReason;
    password: string;
  }): Promise<{ frozen: true; reason: SelfFreezeReason; since: Date; changed: boolean }> {
    if (input.actor.delegated) {
      throw new AuthError('Sign in yourself to freeze your account; an API key or sub-account cannot', 'auth.mfa_required');
    }
    const rows = await this.sql<Array<{ password_hash: string; status: string }>>`
      SELECT password_hash, status FROM users WHERE id = ${input.userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status === 'closed') throw new AuthError('Account is closed', 'auth.account_frozen');
    await this.reserve(input.userId, 'password');
    if (!(await verifyPassword(user.password_hash, input.password))) {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    }
    await recordSuccess(this.sql, input.userId, 'password');
    const result = await transaction(this.sql, async (tx) => {
      await tx`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
      const open = await tx<Array<{ reason: SelfFreezeReason; since: Date }>>`
        SELECT reason, since FROM account_self_freezes WHERE user_id = ${input.userId} AND state = 'frozen'`;
      if (open[0]) return { reason: open[0].reason, since: open[0].since, changed: false };
      const made = await tx<Array<{ since: Date }>>`
        INSERT INTO account_self_freezes (user_id, reason) VALUES (${input.userId}, ${input.reason}) RETURNING since`;
      await tx`UPDATE sessions SET revoked = true WHERE user_id = ${input.userId} AND revoked = false`;
      await tx`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze' WHERE user_id = ${input.userId} AND revoked = false`;
      return { reason: input.reason, since: made[0]!.since, changed: true };
    });
    if (result.changed) await syncNavigatorSessionsClosedForUser(this.sql, input.userId);
    this.log.warn({ userId: input.userId, reason: result.reason, changed: result.changed }, 'auth.self_frozen');
    return { frozen: true, ...result };
  }

  async selfFreezeStatus(userId: string): Promise<{ frozen: boolean; reason: SelfFreezeReason | null; since: Date | null }> {
    const rows = await this.sql<Array<{ reason: SelfFreezeReason; since: Date }>>`
      SELECT reason, since FROM account_self_freezes WHERE user_id = ${userId} AND state = 'frozen'`;
    return rows[0] ? { frozen: true, reason: rows[0].reason, since: rows[0].since } : { frozen: false, reason: null, since: null };
  }

  async getSessionOwnership(sessionId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<
      Array<{ id: string; user_id: string; revoked: boolean }>
    >`SELECT id, user_id, revoked FROM sessions WHERE id = ${sessionId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  async assertSessionLive(sessionId: string): Promise<{ id: string; userId: string }> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) {
      throw new AuthError('Session not found', 'auth.session_denied');
    }
    const rows = await this.sql<
      Array<{ id: string; user_id: string; revoked: boolean; expires_at: Date }>
    >`SELECT id, user_id, revoked, expires_at FROM sessions WHERE id = ${id} LIMIT 1`;
    const row = rows[0];
    if (!row) {
      throw new AuthError('Session not found', 'auth.session_denied');
    }
    if (row.revoked || row.expires_at.getTime() < Date.now()) {
      throw new AuthError('Session is revoked', 'auth.session_revoked');
    }
    return { id: row.id, userId: row.user_id };
  }

  /** Spend one recovery code under the row lock. Answers how many are left after it, or null when the code is not one. */
  private async tryRedeemRecoveryCode(userId: string, code: string): Promise<number | null> {
    const hash = hashToken(code.trim());
    return transaction(this.sql, async (tx) => {
      const rows = await tx<
        Array<{ recovery_code_hashes: unknown }>
      >`SELECT recovery_code_hashes FROM users WHERE id = ${userId} FOR UPDATE`;
      const hashes = asStringList(rows[0]?.recovery_code_hashes);
      const idx = hashes.indexOf(hash);
      if (idx < 0) return null;
      const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
      await tx`UPDATE users SET recovery_code_hashes = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
      return next.length;
    });
  }

  private async consumeTotpCode(userId: string, secret: string, code: string, at?: Date): Promise<void> {
    const matched = matchTotpStep(secret, code, at ? { at } : {});
    if (matched === null) {
      throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    }
    await transaction(this.sql, async (tx) => {
      const rows = await tx<
        Array<{ totp_last_step: string | number | bigint | null }>
      >`SELECT totp_last_step FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
      const lastRaw = rows[0].totp_last_step;
      const lastStep = lastRaw === null || lastRaw === undefined ? null : BigInt(lastRaw);
      if (lastStep !== null && matched <= lastStep) {
        throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      }
      await tx`UPDATE users SET totp_last_step = ${matched.toString()}, updated_at = now() WHERE id = ${userId}`;
    });
  }

  async startTotpEnrolment(userId: string, actor: FactorActor): Promise<{ secret: string; uri: string; recoveryCodes: string[] }> {
    if (!this.totpSecretKey) {
      throw new AuthError(
        'IDENTITY_TOTP_SECRET_KEY is not set to a 32-byte key (base64 or hex) — cannot enrol TOTP',
        'auth.totp_key_missing',
      );
    }
    const rows = await this.sql<
      Array<{ email: string; totp_secret: string | null; webauthn_creds: unknown }>
    >`SELECT email, totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    // Gate first (a refused caller learns nothing about TOTP state), then the
    // already-enrolled conflict. Unlocked: nothing is written here.
    checkMayAddFactor(user, actor);
    if (user.totp_secret) throw new AuthError('Two-factor is already enrolled', 'auth.mfa_already_enrolled');
    const secret = generateSecret();
    const recoveryCodes = generateRecoveryCodes();
    await this.pendingTotp.put(
      userId,
      hashToken(secret),
      recoveryCodes.map((c) => hashToken(c)),
    );
    return { secret, uri: totpUri(secret, user.email), recoveryCodes };
  }

  async confirmTotpEnrolment(userId: string, actor: FactorActor, secret: string, code: string): Promise<void> {
    const matched = matchTotpStep(secret, code);
    if (matched === null) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    if (!this.totpSecretKey) {
      throw new AuthError(
        'IDENTITY_TOTP_SECRET_KEY is not set to a 32-byte key (base64 or hex) — cannot enrol TOTP',
        'auth.totp_key_missing',
      );
    }
    // Same transaction, same row lock as the write: "has no factor" cannot change
    // between the check and the UPDATE (a parallel first-factor enrolment waits).
    const sealed = encryptTotpSecret(this.totpSecretKey, secret);
    await transaction(this.sql, async (tx) => {
      await assertMayAddFactor(tx, userId, actor, true);
      const pending = await this.pendingTotp.takeIfSecretHash(userId, hashToken(secret));
      if (!pending) {
        throw new AuthError('TOTP enrolment session expired or secret mismatch — start enrolment again', 'auth.mfa_invalid');
      }
      const turnedOn =
        await tx`UPDATE users SET totp_secret = ${sealed}, totp_enrolled_at = now(), totp_last_step = ${matched.toString()}, recovery_code_hashes = ${tx.json(pending.recoveryHashes as never)}, updated_at = now() WHERE id = ${userId} AND totp_secret IS NULL RETURNING id`;
      if (turnedOn.length > 0) await queueFactorChangedNotice(tx, { userId, change: 'totp_added', now: this.passwordResetNow() });
      // Sessions opened before the second factor existed carry `mfa: false` and
      // refresh copies that onto every rotation, so one stolen before enrolment
      // would outlive it. The enrolling door names its own session; every other
      // open session of the account is revoked. A caller with no session context
      // (internal tooling, fixtures) names none and revokes nothing.
      if (actor.sessionId) {
        await tx`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false AND id <> ${actor.sessionId}`;
      }
    });
    await this.rank.awardXp({
      userId,
      sourceModule: 'identity',
      action: 'identity.totp.enrolled',
      xpDelta: 100,
      idempotencyKey: `identity.totp.enrolled:${userId}`,
    });
  }

  async startWebauthnRegistration(userId: string, actor: FactorActor): Promise<RegistrationOptionsJSON> {
    const rows = await this.sql<
      Array<{ email: string; handle: string; totp_secret: string | null; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT email, handle, totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    checkMayAddFactor(user, actor);
    const existing = asCredentialList(user.webauthn_creds);
    const challenge = generateChallenge();
    await this.challenges.put('registration', challenge, userId);
    return createRegistrationOptions(this.webauthn, { id: userId, name: user.email, displayName: user.handle }, existing, challenge);
  }

  async confirmWebauthnRegistration(
    userId: string,
    actor: FactorActor,
    response: RegistrationResponseJSON,
  ): Promise<{ credentialId: string }> {
    const rows = await this.sql<
      Array<{ webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    const clientChallenge = readClientChallenge(response.response.clientDataJSON);
    if (!clientChallenge) throw new AuthError('Invalid WebAuthn response', 'auth.webauthn_invalid');
    const held = await this.challenges.take(clientChallenge, 'registration');
    if (!held || held.userId !== userId) {
      throw new AuthError('WebAuthn challenge expired or already used', 'auth.webauthn_invalid');
    }
    let stored: StoredWebAuthnCredential;
    try {
      stored = verifyRegistrationResponse(this.webauthn, held.challenge, response);
    } catch (err) {
      throw mapWebAuthnError(err);
    }
    // Re-read under a row lock so this enrolment and a login's counter write in
    // this service cannot overwrite each other's credential list. The writers in
    // enroll-passkey.ts, verify-passkey.ts and unenroll-passkey.ts take the same
    // lock, so the guarantee holds between all of them.
    const existingCount = await transaction(this.sql, async (tx) => {
      // Locks the user row and applies the factor rule in the same transaction as the write.
      await assertMayAddFactor(tx, userId, actor, true);
      const locked = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
      if (!locked[0]) throw new AuthError('User not found', 'auth.not_found');
      const existing = asCredentialList(locked[0].webauthn_creds);
      if (existing.some((c) => c.credentialId === stored.credentialId)) {
        throw new AuthError('That authenticator is already registered', 'auth.webauthn_invalid');
      }
      if (this.passkeyLimit !== undefined && existing.length >= this.passkeyLimit) {
        throw new AuthError('Passkey limit reached', 'identity.passkey_limit');
      }
      const next = [...existing, stored];
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
      await queueFactorChangedNotice(tx, { userId, change: 'passkey_added', now: this.passwordResetNow() });
      return existing.length;
    });
    if (existingCount === 0) {
      await this.rank.awardXp({
        userId,
        sourceModule: 'identity',
        action: 'identity.webauthn.enrolled',
        xpDelta: 100,
        idempotencyKey: `identity.webauthn.enrolled:${userId}`,
      });
    }
    return { credentialId: stored.credentialId };
  }

  async startWebauthnAuthentication(identifier: string): Promise<AuthenticationOptionsJSON> {
    // The decoy ids come from the server secret; without it the answer would be an empty list that gives accounts away.
    if (!this.tokens.secret) throw new AuthError('The sign-in secret is not set', 'auth.webauthn_unconfigured');
    const rows = await this.sql<
      Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT id, status, webauthn_creds FROM users WHERE handle = ${identifier} OR email = ${identifier}`;
    const user = rows[0];
    const challenge = generateChallenge();
    // Passkeys bound to sign-in are the only ones offered when any is (passkey-purposes.ts).
    const creds = user && user.status === 'active' ? credentialsFor(asCredentialList(user.webauthn_creds), 'signin') : [];
    // Only an active account with a passkey can sign in; every other identifier gets decoys and a challenge with no user.
    const real = user !== undefined && creds.length > 0;
    await this.challenges.put('authentication', challenge, real ? user.id : null);
    // Transport hints are left out of every answer so a real list and a decoy list have the same shape.
    const listed = real
      ? creds.map((c) => ({ credentialId: c.credentialId }) as StoredWebAuthnCredential)
      : decoyCredentialIds(this.tokens.secret, identifier).map((credentialId) => ({ credentialId }) as StoredWebAuthnCredential);
    return createAuthenticationOptions(this.webauthn, listed, challenge);
  }

  async confirmWebauthnAuthentication(
    identifier: string,
    response: AuthenticationResponseJSON,
    options: { device?: string; ip?: string } = {},
  ): Promise<SessionTokens> {
    const rows = await this.sql<
      Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT id, status, webauthn_creds FROM users WHERE handle = ${identifier} OR email = ${identifier}`;
    const user = rows[0];
    const refuse = (): never => {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
    };
    // Unknown, frozen and passkey-less accounts were offered decoy ids, so they fail exactly like a wrong signature.
    if (!user || user.status !== 'active' || asCredentialList(user.webauthn_creds).length === 0) return refuse();
    const clientChallenge = readClientChallenge(response.response.clientDataJSON);
    if (!clientChallenge) return refuse();
    const held = await this.challenges.take(clientChallenge, 'authentication');
    if (!held || held.userId !== user.id) return refuse();
    await this.verifyAssertionAndAdvanceCounter(user.id, held.challenge, response, refuse, 'signin');
    return this.issueSession(user.id, { device: options.device, ip: options.ip, mfa: true });
  }

  /**
   * Verify a passkey assertion and advance that credential's signature counter.
   *
   * Runs in one transaction under `SELECT … FOR UPDATE` on the user row, so two
   * concurrent assertions (or a locked enrolment racing a login) cannot read the
   * same counter and both succeed, and cannot overwrite each other's credential
   * list. The writers in enroll-passkey.ts, verify-passkey.ts and
   * unenroll-passkey.ts take the same lock. `refuse` throws the caller's own AuthError for any refusal. With a
   * `purpose`, only the passkeys that answer for it (bound to it, or all when none is) are accepted, read under the
   * same lock as the counter.
   */
  private async verifyAssertionAndAdvanceCounter(
    userId: string,
    challenge: string,
    response: AuthenticationResponseJSON,
    refuse: () => never,
    purpose?: PasskeyPurpose,
  ): Promise<void> {
    await transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0]) return refuse();
      const creds = asCredentialList(rows[0].webauthn_creds);
      const responseId = normalizeCredId(response.id);
      const allowed = purpose ? credentialsFor(creds, purpose) : creds;
      const credential = allowed.find((c) => c.credentialId === responseId);
      if (!credential) return refuse();
      let newCounter: number;
      try {
        ({ newCounter } = await verifyAuthenticationResponse(this.webauthn, challenge, credential, response));
      } catch (err) {
        if (err instanceof WebAuthnError) return refuse();
        throw err;
      }
      // A passkey that just passed an assertion is a verified passkey (`requireVerifiedPasskey` reads this stamp).
      const lastVerifiedAt = new Date().toISOString();
      const next = creds.map((c) => (c.credentialId === credential.credentialId ? { ...c, counter: newCounter, lastVerifiedAt } : c));
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
    });
  }

  async listWebauthnCredentials(
    userId: string,
    limit: number,
  ): Promise<Array<{ credentialId: string; createdAt: string; transports?: string[] }>> {
    const published = publishedWebauthnListLimit(limit);
    const rows = await this.sql<
      Array<{ webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
    if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
    return asCredentialList(rows[0].webauthn_creds)
      .map((c) => ({
        credentialId: c.credentialId,
        createdAt: c.createdAt,
        ...(c.transports ? { transports: c.transports } : {}),
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, published);
  }

  async removeWebauthnCredential(userId: string, actor: FactorActor, credentialId: string): Promise<boolean> {
    assertMayRemoveFactor(actor);
    const target = normalizeCredId(credentialId);
    return transaction(this.sql, async (tx) => {
      const rows = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!rows[0]) throw new AuthError('User not found', 'auth.not_found');
      const creds = asCredentialList(rows[0].webauthn_creds);
      const next = creds.filter((c) => c.credentialId !== target);
      if (next.length === creds.length) return false;
      // The last way in stays (I-account-lifecycle-07): a passkey is removed only while another method remains.
      assertLeavesAWayIn(await lockedSigninMethods(tx, userId));
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
      await queueFactorChangedNotice(tx, { userId, change: 'passkey_removed', now: this.passwordResetNow() });
      return true;
    });
  }

  async startWebauthnStepUp(userId: string) {
    const rows = await this.sql<
      Array<{ id: string; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT id, status, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const creds = asCredentialList(user.webauthn_creds);
    if (creds.length === 0) {
      throw new AuthError('No security key enrolled', 'auth.webauthn_not_enrolled');
    }
    const challenge = generateChallenge();
    await this.challenges.put('step-up', challenge, userId);
    // This door confirms money out (withdrawals, pay refunds and payouts, and API keys, which can carry them).
    return createAuthenticationOptions(this.webauthn, credentialsFor(creds, 'money_out'), challenge);
  }

  async createApiKey(input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
    /** True only when this create asked for pay:refund / pay:payout under a step-up token. */
    payStepUp?: boolean;
    /** Run on this open transaction instead of starting one (used by `withApiKeyAction`). */
    executor?: Sql;
  }): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; scopes: string[] }> {
    assertDelegateCannotGrant(input.grantorKid);
    assertDelegatableScopes(input.scopes, input.grantorScopes, { payStepUp: input.payStepUp === true });
    const mode = input.mode === 'sandbox' ? 'sandbox' : 'live';
    // Only svc-pay honours sandbox mode; every other door treats a sandbox key as an ordinary key,
    // so a sandbox key may hold pay scopes and nothing else.
    if (mode === 'sandbox' && input.scopes.some((scope) => !scope.startsWith('pay:'))) {
      throw new AuthError('A sandbox key can only hold pay scopes', 'auth.sandbox_scope_not_pay');
    }
    const { key, hash, prefix } = generateApiKey(mode);
    const insert = async (tx: Sql) => {
      const [user] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${input.userId} FOR UPDATE`;
      if (!user || user.status !== 'active') throw new AuthError('Account is unavailable', 'auth.account_frozen');
      const own = await tx<Array<{ id: string }>>`SELECT id FROM account_self_freezes WHERE user_id = ${input.userId} AND state = 'frozen'`;
      if (own[0]) throw new AuthError('You froze this account', 'identity.account_frozen_self');
      return tx<
        Array<{ id: string }>
      >`INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, domain_whitelist, expires_at, mode) VALUES (${input.userId}, ${input.name}, ${hash}, ${prefix}, ${input.scopes}, ${input.domainWhitelist ?? []}, ${input.expiresAt ?? null}, ${mode}) RETURNING id`;
    };
    const rows = input.executor ? await insert(input.executor) : await transaction(this.sql, insert, { isolation: 'read committed' });
    return { id: rows[0]!.id, key, prefix, mode, scopes: [...input.scopes] };
  }

  async verifyApiKey(
    key: string,
  ): Promise<{ userId: string; scopes: string[]; keyId: string; mode: 'live' | 'sandbox'; domainWhitelist: string[] } | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        scopes: string[];
        expires_at: Date | null;
        mode: string | null;
        domain_whitelist: string[] | null;
      }>
    >`SELECT id, user_id, scopes, expires_at, mode, domain_whitelist FROM api_keys WHERE key_hash = ${hashToken(key)} AND revoked = false`;
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;
    await this.sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`;
    const mode: 'live' | 'sandbox' = row.mode === 'sandbox' ? 'sandbox' : 'live';
    return { userId: row.user_id, scopes: row.scopes, keyId: row.id, mode, domainWhitelist: row.domain_whitelist ?? [] };
  }

  /**
   * Why a presented key that opens nothing is refused (DV-errors-02, J-developer-04 #5 and #6). Only a caller holding
   * the key's full secret reaches a named answer, and the key is dead either way, so naming it tells a guesser
   * nothing: a key matching no row stays `auth.invalid_credentials`. A frozen account comes first, because a freeze
   * also revokes the account's keys and the holder needs to know the account, not the key, is the cause.
   */
  private async deadApiKeyRefusal(key: string): Promise<AuthError> {
    const rows = await this.sql<Array<{ revoked: boolean; expires_at: Date | null; status: string | null }>>`
      SELECT k.revoked, k.expires_at, u.status
      FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ${hashToken(key)}
    `;
    const row = rows[0];
    if (!row) return new AuthError('Invalid credentials', 'auth.invalid_credentials');
    if (row.status !== null && row.status !== 'active') return new AuthError(`Account is ${row.status}`, 'auth.account_frozen');
    if (row.revoked) return new AuthError('API key is revoked', 'auth.api_key_revoked');
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return new AuthError('API key has expired', 'auth.api_key_expired');
    return new AuthError('Invalid credentials', 'auth.invalid_credentials');
  }

  async exchangeApiKey(
    key: string,
    requestOrigin?: string | null,
  ): Promise<{
    accessToken: string;
    expiresAt: Date;
    userId: string;
    keyId: string;
    scopes: string[];
    mode: 'live' | 'sandbox';
    requireSignature?: boolean;
    requireNonEmptyIpAllowlist?: boolean;
    ipAllowlist?: string[];
  }> {
    const verified = await this.verifyApiKey(key);
    if (!verified) throw await this.deadApiKeyRefusal(key);
    if (!apiKeyOriginAllowed(verified.domainWhitelist, requestOrigin)) {
      throw new AuthError('API key is not allowed from this origin', 'auth.domain_not_allowed');
    }
    const users = await this.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${verified.userId}`;
    const user = users[0];
    if (!user) throw new AuthError('Account not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const tier = await this.kycTier(verified.userId);
    const { token: accessToken, expiresAt } = await issueAccessToken(
      {
        userId: verified.userId,
        sessionId: verified.keyId,
        scopes: verified.scopes,
        tier,
        mfa: false,
        apiKeyId: verified.keyId,
        keyEnv: verified.mode,
      },
      this.tokens,
    );
    return { accessToken, expiresAt, userId: verified.userId, keyId: verified.keyId, scopes: verified.scopes, mode: verified.mode };
  }

  /**
   * Revoke one key, recording why: `owner` (the person, also a rotation's old key) unless the caller says otherwise,
   * `system` when a create or rotation undoes a key it made but never handed over.
   */
  async revokeApiKey(userId: string, keyId: string, cause: ApiKeyRevokedBy = 'owner', executor?: Sql): Promise<boolean> {
    const result = await (executor ??
      this
        .sql)`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = ${cause} WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false`;
    return result.count > 0;
  }

  async getApiKeyOwnership(keyId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<
      Array<{ id: string; user_id: string; revoked: boolean }>
    >`SELECT id, user_id, revoked FROM api_keys WHERE id = ${keyId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  async assertApiKeyLive(keyId: string): Promise<{ id: string; userId: string }> {
    const id = typeof keyId === 'string' ? keyId.trim() : '';
    if (!id) {
      throw new AuthError('API key not found', 'auth.api_key_denied');
    }
    const row = await this.getApiKeyOwnership(id);
    if (!row) {
      throw new AuthError('API key not found', 'auth.api_key_denied');
    }
    if (row.revoked) {
      throw new AuthError('API key is revoked', 'auth.api_key_revoked');
    }
    return { id: row.id, userId: row.userId };
  }

  async listApiKeys(userId: string, limit: number) {
    const published = publishedApiKeysListLimit(limit);
    return this.sql<
      Array<{
        id: string;
        name: string;
        key_prefix: string;
        scopes: string[];
        last_used_at: Date | null;
        revoked: boolean;
        mode: string;
        require_signature: boolean;
        require_non_empty_ip_allowlist: boolean;
        ip_allowlist: string[] | null;
      }>
    >`SELECT id, name, key_prefix, scopes, last_used_at, revoked, mode, require_signature, require_non_empty_ip_allowlist, ip_allowlist FROM api_keys WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${published}`;
  }

  /**
   * Bind pending merchant email invites to this account.
   *
   * Sign-in alone does not qualify. The stored mailbox must already be
   * confirmed (`email_verified_at` is a real instant). The address sent to
   * pay is that stored mailbox, not the identifier the person typed.
   * A pay failure is logged and does not undo the session or the confirmation.
   * Sign-in does not wait for the pay call. Confirmation and an email change still do.
   */
  async claimConfirmedEmailInvites(userId: string): Promise<void> {
    const claimer = this.merchantEmailInviteClaimer;
    if (!claimer) return;
    try {
      const rows = await this.sql<Array<{ email: string; email_verified_at: Date | string | null }>>`
        SELECT email::text AS email, email_verified_at FROM users WHERE id = ${userId} LIMIT 1
      `;
      const row = rows[0];
      if (!row?.email || !isEmailConfirmed(row)) return;
      await claimer.claim({ userId, email: row.email });
    } catch (err) {
      this.log.warn({ userId, reason: err instanceof Error ? err.name : 'error' }, 'merchant email invite claim failed');
    }
  }

  async kycTier(userId: string, sql: Sql = this.sql): Promise<'none' | 'basic' | 'full' | 'institutional'> {
    const rows = await sql<
      Array<{ tier: 'basic' | 'full' | 'institutional' }>
    >`SELECT tier FROM kyc_records WHERE user_id = ${userId} AND status = 'approved' AND (expires_at IS NULL OR expires_at > now())`;
    const order = { basic: 1, full: 2, institutional: 3 } as const;
    let best: 'none' | 'basic' | 'full' | 'institutional' = 'none';
    for (const row of rows) {
      if (best === 'none' || order[row.tier] > order[best as 'basic' | 'full' | 'institutional']) best = row.tier;
    }
    return best;
  }

  async accountState(userId: string): Promise<AccountState | null> {
    const rows = await this.sql<
      Array<{ id: string; status: 'active' | 'frozen' | 'closed' }>
    >`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1`;
    const user = rows[0];
    if (!user) return null;
    return { userId: user.id, status: user.status, kycTier: await this.kycTier(user.id) };
  }

  /**
   * Who the account is for a campaign's participation rules (CM-eligibility-rules-01): account type, region, status and
   * KYC tier. Null for an unknown or malformed user, which the caller must refuse on, never read as eligible.
   */
  async campaignParticipant(userId: string): Promise<CampaignParticipant | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
    const rows = await this.sql<
      Array<{ id: string; status: 'active' | 'frozen' | 'closed'; account_type: string | null; region: string | null }>
    >`
      SELECT u.id, u.status, p.account_type, p.region
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ${userId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const region = row.region?.trim().toUpperCase() ?? '';
    return {
      userId: row.id,
      // Accounts made before the sign-up choice existed are personal (migration 0066).
      accountType: row.account_type === 'business' ? 'business' : 'individual',
      region: /^[A-Z]{2}$/.test(region) ? region : null,
      status: row.status,
      kycTier: await this.kycTier(row.id),
    };
  }

  /**
   * Whether the account's current email is proved (RC-identity-01), for svc-trade's order gate. Null for an unknown
   * user, which the caller must refuse on, never read as proved.
   */
  async emailProof(userId: string): Promise<EmailProof | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
    const rows = await this.sql<Array<{ id: string; email_verified_at: Date | string | null }>>`
      SELECT id, email_verified_at FROM users WHERE id = ${userId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { userId: row.id, emailProof: isEmailConfirmed(row) ? 'accepted' : 'missing' };
  }

  /**
   * The caller's own handle, for `identity.me`. Null only when the account row
   * is gone, which a live session should not be able to reach.
   */
  async handleOf(userId: string): Promise<string | null> {
    const view = await this.selfView(userId);
    return view?.handle ?? null;
  }

  /**
   * The caller's own handle and whether the current email is confirmed, for
   * `identity.me`. Null only when the account row is gone.
   */
  async selfView(userId: string): Promise<{ handle: string; emailVerified: boolean } | null> {
    const rows = await this.sql<Array<{ handle: string; email_verified_at: Date | string | null }>>`
      SELECT handle, email_verified_at FROM users WHERE id = ${userId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { handle: row.handle, emailVerified: isEmailConfirmed(row) };
  }

  /**
   * The caller's own email, and whether it is confirmed (the drop room's waitlist read, `waitlist.mine`). Self-only: the
   * user id comes from the session. Null when the account is gone.
   */
  async selfEmail(userId: string): Promise<{ email: string; emailVerified: boolean } | null> {
    const rows = await this.sql<Array<{ email: string | null; email_verified_at: Date | string | null }>>`
      SELECT email, email_verified_at FROM users WHERE id = ${userId} LIMIT 1
    `;
    const row = rows[0];
    if (!row?.email) return null;
    return { email: row.email, emailVerified: isEmailConfirmed(row) };
  }

  /**
   * Exact handle match for pay-by-@handle. `handle` is citext, so `=` is
   * case-insensitive and there is no LIKE, prefix or list path here.
   *
   * Only `active` accounts come back. Frozen, closed and missing rows are the
   * same null: the caller must not learn which handles belong to restricted
   * accounts. Returns the stored handle and whether its owner lets people find
   * them by it (PP-send-request-03); the caller hides an undiscoverable one
   * from everyone but its owner.
   */
  async findActiveByHandle(handle: string): Promise<{ userId: string; handle: string; discoverable: boolean } | null> {
    const rows = await this.sql<Array<{ id: string; handle: string; handle_discoverable: boolean }>>`
      SELECT id, handle, handle_discoverable FROM users WHERE handle = ${handle} AND status = 'active' LIMIT 1`;
    const row = rows[0];
    return row ? { userId: row.id, handle: row.handle, discoverable: row.handle_discoverable } : null;
  }

  /**
   * Exact email or phone, and only when that person opted in and the address
   * is verified. Frozen, closed, unknown, unverified and "did not consent"
   * are the same null. The row's email and phone are not returned.
   */
  async searchPayee(query: { email: string } | { phone: string }): Promise<{ userId: string; handle: string } | null> {
    const rows =
      'email' in query
        ? await this.sql<Array<{ id: string; handle: string }>>`
            SELECT id, handle FROM users
             WHERE email = ${query.email}
               AND status = 'active'
               AND payee_email_consent = true
               AND email_verified_at IS NOT NULL
             LIMIT 1`
        : await this.sql<Array<{ id: string; handle: string }>>`
            SELECT id, handle FROM users
             WHERE phone = ${query.phone}
               AND status = 'active'
               AND payee_phone_consent = true
               AND phone_verified_at IS NOT NULL
             LIMIT 1`;
    const row = rows[0];
    return row ? { userId: row.id, handle: row.handle } : null;
  }

  /**
   * The signed-in user turns email or phone discovery on or off, and may set
   * their own phone. The phone number is stored and never written to the audit.
   */
  async setPayeeSearchConsent(
    userId: string,
    input: { emailConsent?: boolean; phoneConsent?: boolean; phone?: string | null },
  ): Promise<{ emailConsent: boolean; phoneConsent: boolean; phoneOnFile: boolean }> {
    return transaction(this.sql, async (tx) => {
      const rows = await tx<
        Array<{
          phone: string | null;
          payee_email_consent: boolean;
          payee_phone_consent: boolean;
          status: string;
          email_verified_at: Date | string | null;
          phone_verified_at: Date | string | null;
        }>
      >`
        SELECT phone, payee_email_consent, payee_phone_consent, status, email_verified_at, phone_verified_at
          FROM users WHERE id = ${userId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row || row.status !== 'active') throw new AuthError('Account is unavailable', 'auth.account_frozen');
      let phone = row.phone;
      let emailConsent = row.payee_email_consent;
      let phoneConsent = row.payee_phone_consent;
      let phoneVerifiedAt = row.phone_verified_at;
      let phoneEvent: 'phone_set' | 'phone_cleared' | null = null;
      if (input.phone === null) {
        if (phone !== null) phoneEvent = 'phone_cleared';
        phone = null;
        phoneConsent = false;
        phoneVerifiedAt = null;
      } else if (typeof input.phone === 'string') {
        phone = input.phone;
        phoneEvent = 'phone_set';
        phoneConsent = false;
        phoneVerifiedAt = null;
      }
      if (input.emailConsent !== undefined) emailConsent = input.emailConsent;
      if (input.phoneConsent !== undefined) phoneConsent = input.phoneConsent;
      if (emailConsent && row.email_verified_at == null) {
        throw new AuthError('Confirm your email before people can find you by it', 'auth.payee_email_unconfirmed');
      }
      if (phoneConsent && phoneVerifiedAt == null) {
        throw new AuthError('Verify your phone before people can find you by it', 'auth.payee_phone_unverified');
      }
      if (phoneConsent && phone === null) {
        throw new AuthError('Add a phone number before people can find you by it', 'auth.payee_phone_unset');
      }
      await tx`
        UPDATE users
           SET phone = ${phone},
               phone_verified_at = ${phoneVerifiedAt},
               payee_email_consent = ${emailConsent},
               payee_phone_consent = ${phoneConsent},
               updated_at = now()
         WHERE id = ${userId}
      `;
      await tx`
        INSERT INTO payee_search_audit (user_id, event, email_consent, phone_consent)
        VALUES (${userId}, 'consent', ${emailConsent}, ${phoneConsent})
      `;
      if (phoneEvent) {
        await tx`
          INSERT INTO payee_search_audit (user_id, event, email_consent, phone_consent)
          VALUES (${userId}, ${phoneEvent}, ${emailConsent}, ${phoneConsent})
        `;
      }
      return { emailConsent, phoneConsent, phoneOnFile: phone !== null };
    });
  }

  async submitKyc(input: { userId: string; tier: SubmittableKycTier; jurisdiction: string; providerRef?: string }): Promise<KycRecordView> {
    return transaction(this.sql, async (tx) => {
      const users = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
      if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
      const existing = await tx<
        KycRow[]
      >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE user_id = ${input.userId} AND ((status = 'approved' AND (expires_at IS NULL OR expires_at > now())) OR (status = 'pending' AND tier = ${input.tier})) ORDER BY created_at DESC`;
      const approved = existing.find((r) => r.status === 'approved' && TIER_ORDER[r.tier] >= TIER_ORDER[input.tier]);
      if (approved) return toKycRecord(approved);
      const pending = existing.find((r) => r.status === 'pending');
      if (pending) return toKycRecord(pending);
      // Inactive is a compliance decision: a request whose level would grant it again is refused (I-kyc-compliance-07).
      await assertRequestable(tx, this.kycCapabilities, input.userId, input.tier);
      // Too many rejected requests in the owner's window: refused with the seconds left (I-kyc-compliance-10).
      await assertAttemptsLeft(tx, this.kycAttemptLimit, input.userId);
      const inserted = await tx<
        KycRow[]
      >`INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status) VALUES (${input.userId}, ${input.tier}, ${input.jurisdiction}, ${input.providerRef ?? null}, 'pending') RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at`;
      const record = toKycRecord(inserted[0]!);
      // The case opens with the record, in this transaction (I-kyc-compliance-01).
      const caseId = await openKycCase(tx, record);
      const heldTier = existing
        .filter((r) => r.status === 'approved')
        .reduce<KycTier>((best, r) => (TIER_ORDER[r.tier] > TIER_ORDER[best] ? r.tier : best), 'none');
      await markRequested(tx, this.kycCapabilities, { userId: record.userId, tier: record.tier, heldTier, caseId, at: record.createdAt });
      return record;
    });
  }

  async listKycRecords(userId: string, limit: number): Promise<KycRecordView[]> {
    const published = publishedKycRecordsListLimit(limit);
    const rows = await this.sql<
      KycRow[]
    >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${published}`;
    return rows.map(toKycRecord);
  }

  /** A person's KYC cases, newest first, with their history and the owner's reason text (I-kyc-compliance-01). */
  async listKycCases(userId: string, limit: number, reasons: KycRejectReasons): Promise<KycCase[]> {
    const published = publishedKycRecordsListLimit(limit);
    const users = await this.sql<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId}`;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    return listKycCases(this.sql, userId, published, reasons);
  }

  /** Where the person stands against the owner's limit on rejected requests (I-kyc-compliance-10). */
  async kycAttempts(userId: string): Promise<KycAttempts> {
    const { now: _now, ...standing } = await readKycAttempts(this.sql, this.kycAttemptLimit, userId);
    return standing;
  }

  /** A person's capabilities, every one with its state (I-kyc-compliance-07). An unknown person is `auth.not_found`. */
  async listKycCapabilities(userId: string, reasons: KycRejectReasons): Promise<KycCapabilitiesOutput> {
    const users = await this.sql<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId}`;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    return listCapabilities(this.sql, this.kycCapabilities, userId, await this.kycTier(userId), reasons);
  }

  /** Refuses (`kyc.capability_state`) what the decision would refuse, before the four-eyes approval is spent. */
  async assertKycCapabilityDeactivatable(userId: string, capability: KycCapability, reasonCode: string): Promise<void> {
    await assertDeactivatable(this.sql, userId, capability, reasonCode);
  }

  /**
   * Compliance switches one capability off for good (terminal `inactive`), with a listed reason code. Nobody decides
   * their own; the router has spent the four-eyes approval and checked the code is listed.
   */
  async deactivateKycCapability(input: {
    userId: string;
    capability: KycCapability;
    reasonCode: string;
    reviewerId: string;
    approvalParties: readonly string[];
    reasons: KycRejectReasons;
  }): Promise<KycCapabilitiesOutput> {
    await transaction(this.sql, async (tx) => {
      const users = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
      if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
      assertNotOwnKyc(input.userId, [input.reviewerId, ...input.approvalParties]);
      await deactivateCapability(tx, { ...input, by: input.reviewerId, at: new Date() });
    });
    return this.listKycCapabilities(input.userId, input.reasons);
  }

  /**
   * Refuses (`kyc.case_state`) a reject the decision would refuse anyway (a record no longer pending, unless it is the
   * same reject again), so the router checks it before the four-eyes approval is spent.
   */
  async assertKycRejectable(recordId: string, decision: KycRejectDecision): Promise<void> {
    await assertRejectable(this.sql, recordId, decision);
  }

  async listPendingKyc(limit: number): Promise<KycRecordView[]> {
    const published = publishedKycPendingLimit(limit);
    const rows = await this.sql<
      KycRow[]
    >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE status = 'pending' ORDER BY created_at ASC LIMIT ${published}`;
    return rows.map(toKycRecord);
  }

  async getKycRecord(recordId: string): Promise<KycRecordView | null> {
    const rows = await this.sql<
      KycRow[]
    >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${recordId}`;
    return rows[0] ? toKycRecord(rows[0]) : null;
  }

  async approveKycRecord(input: {
    recordId: string;
    reviewerId: string;
    expiresAt?: Date | null;
    service?: string | null;
    kid?: string | null;
    /** Threaded from the wire mill field so boot dual-control wrap can see the second actor. */
    confirmActorId?: string | null;
    approvalId?: string | null;
    operationId?: string | null;
    /** The proposer and the approver of the consumed four-eyes approval for this decision. Required: [] says none. */
    approvalParties: readonly string[];
  }): Promise<KycRecordView> {
    assertOperatorKycReview({ service: input.service, kid: input.kid });
    const outcome = await transaction(this.sql, async (tx) => {
      const rows = await tx<
        KycRow[]
      >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${input.recordId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AuthError('KYC record not found', 'auth.not_found');
      assertNotOwnKyc(row.user_id, [input.reviewerId, input.confirmActorId, ...input.approvalParties]);
      if (row.status === 'approved') return { record: toKycRecord(row), granted: false };
      if (row.status !== 'pending') {
        throw new AuthError(`KYC record is ${row.status}; only a pending record can be approved`, 'auth.kyc_not_pending');
      }
      const updated = await tx<
        KycRow[]
      >`UPDATE kyc_records SET status = 'approved', reviewed_at = now(), reviewed_by = ${input.reviewerId}, expires_at = ${input.expiresAt ?? null} WHERE id = ${row.id} RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at`;
      const record = toKycRecord(updated[0]!);
      const at = record.reviewedAt ?? new Date();
      const caseId = await approveKycCase(tx, toKycRecord(row), { by: input.reviewerId, at });
      // The capabilities the owner maps to this level become active with the approval, never after it.
      await grantOnApproval(tx, this.kycCapabilities, { userId: record.userId, tier: record.tier, caseId, by: input.reviewerId, at });
      return { record, granted: true };
    });
    if (outcome.granted) await this.announceKycApproval(outcome.record);
    return outcome.record;
  }

  async rejectKycRecord(input: {
    recordId: string;
    reviewerId: string;
    /** A code from the owner's reject reason list; the router checks it is listed before anything is spent. */
    reasonCode: string;
    /** The reviewer's note to the customer, shown only when `noteVisible`. */
    customerNote?: string | null;
    noteVisible?: boolean;
    service?: string | null;
    kid?: string | null;
    /** Threaded from the wire mill field so boot dual-control wrap can see the second actor. */
    confirmActorId?: string | null;
    approvalId?: string | null;
    operationId?: string | null;
    /** The proposer and the approver of the consumed four-eyes approval for this decision. Required: [] says none. */
    approvalParties: readonly string[];
  }): Promise<KycRecordView> {
    assertOperatorKycReview({ service: input.service, kid: input.kid });
    return transaction(this.sql, async (tx) => {
      const rows = await tx<
        KycRow[]
      >`SELECT id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at FROM kyc_records WHERE id = ${input.recordId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AuthError('KYC record not found', 'auth.not_found');
      assertNotOwnKyc(row.user_id, [input.reviewerId, input.confirmActorId, ...input.approvalParties]);
      const decision = {
        by: input.reviewerId,
        reasonCode: input.reasonCode,
        customerNote: input.customerNote?.trim() || null,
        noteVisible: input.noteVisible ?? false,
      };
      if (row.status === 'rejected') {
        // The same reject is the same decision; anything else is refused, so what the customer read stays.
        const record = toKycRecord(row);
        await rejectKycCase(tx, record, { ...decision, at: record.reviewedAt ?? record.createdAt });
        return record;
      }
      if (row.status !== 'pending') {
        throw new AuthError(`KYC record is ${row.status}; only a pending record can be rejected`, 'auth.kyc_not_pending');
      }
      const updated = await tx<
        KycRow[]
      >`UPDATE kyc_records SET status = 'rejected', reviewed_at = now(), reviewed_by = ${input.reviewerId} WHERE id = ${row.id} RETURNING id, user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at, created_at`;
      const record = toKycRecord(updated[0]!);
      const at = record.reviewedAt ?? new Date();
      const caseId = await rejectKycCase(tx, toKycRecord(row), { ...decision, at });
      await releaseOnReject(tx, this.kycCapabilities, { userId: record.userId, tier: record.tier, caseId, by: input.reviewerId, at });
      return record;
    });
  }

  private async announceKycApproval(record: { userId: string; tier: KycTier; jurisdiction: string }): Promise<void> {
    if (record.tier === 'none') return;
    await this.bus.publish(
      'kycApproved',
      { userId: record.userId, tier: record.tier, jurisdiction: record.jurisdiction },
      { idempotencyKey: `kyc.approved:${record.userId}:${record.tier}` },
    );
    await this.rank.awardXp({
      userId: record.userId,
      sourceModule: 'identity',
      action: 'identity.kyc.approved',
      xpDelta: 200,
      idempotencyKey: `identity.kyc.approved:${record.userId}:${record.tier}`,
    });
  }

  /**
   * What the customer step-up sheet can ask for. A passkey challenge issued here
   * is not stored as kind `step-up`, so it cannot be spent on `auth.stepUp`
   * (that door mints a trade:withdraw bearer). Neither factor enrolled refuses.
   */
  async customerStepUpMaterial(
    userId: string,
    purpose: PasskeyPurpose,
  ): Promise<{ totp: boolean; credentials: StoredWebAuthnCredential[] }> {
    const rows = await this.sql<
      Array<{ status: string; totp_secret: string | null; webauthn_creds: unknown }>
    >`SELECT status, totp_secret, webauthn_creds FROM users WHERE id = ${userId}`;
    const user = rows[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const credentials = asCredentialList(user.webauthn_creds);
    const totpEnrolled = typeof user.totp_secret === 'string' && user.totp_secret.length > 0;
    if (!totpEnrolled && credentials.length === 0) {
      throw new AuthError('Enrol two-factor authentication before confirming this payment', 'auth.mfa_not_enrolled');
    }
    return { totp: totpEnrolled, credentials: credentialsFor(credentials, purpose) };
  }

  passkeyOptions(credentials: readonly StoredWebAuthnCredential[], challenge: string): AuthenticationOptionsJSON {
    return createAuthenticationOptions(this.webauthn, credentials, challenge);
  }

  /**
   * Prove a fresh factor for a customer step-up. Does not mint a token.
   * A recovery code is spent when given; only customer-step-up.ts decides the
   * scopes it may confirm (replacing or turning off the authenticator app), and
   * every other caller passes none. The passkey challenge must be the one
   * `stepUp.begin` stored; a login or bearer step-up challenge is not accepted.
   */
  async proveFreshFactor(input: {
    userId: string;
    sessionId: string;
    totpCode?: string;
    /** A recovery code, spent once. The caller decides where one may stand in for the app (customer-step-up.ts). */
    recoveryCode?: string;
    webauthn?: AuthenticationResponseJSON;
    webauthnChallenge?: string;
    /** The action the passkey confirms; only the passkeys that answer for it are accepted. */
    purpose: PasskeyPurpose;
  }): Promise<void> {
    const hasTotp = typeof input.totpCode === 'string' && input.totpCode.length > 0;
    const hasRecovery = typeof input.recoveryCode === 'string' && input.recoveryCode.trim().length > 0;
    const hasWebauthn = input.webauthn !== undefined && input.webauthn !== null;
    if (Number(hasTotp) + Number(hasRecovery) + Number(hasWebauthn) !== 1) {
      throw new AuthError('Provide exactly one of a TOTP code, a recovery code or a WebAuthn assertion', 'auth.mfa_invalid');
    }
    const users = await this.sql<
      Array<{ totp_secret: string | null; status: string; webauthn_creds: unknown }>
    >`SELECT totp_secret, status, webauthn_creds FROM users WHERE id = ${input.userId}`;
    const user = users[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const sessions = await this.sql<
      Array<{ id: string }>
    >`SELECT id FROM sessions WHERE id = ${input.sessionId} AND user_id = ${input.userId} AND revoked = false AND expires_at > now()`;
    if (!sessions[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');
    if (hasRecovery) {
      // Recovery codes belong to the authenticator app: none without it. Counted before the code is looked at.
      if (!user.totp_secret) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      await this.reserve(input.userId, 'mfa');
      if ((await this.tryRedeemRecoveryCode(input.userId, input.recoveryCode!)) === null) {
        throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      }
      await recordSuccess(this.sql, input.userId, 'mfa');
      return;
    }
    if (hasTotp) {
      if (!/^\d{6}$/.test(input.totpCode!)) {
        throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      }
      if (!user.totp_secret) {
        throw new AuthError('Enrol two-factor authentication before confirming this payment', 'auth.mfa_not_enrolled');
      }
      await this.reserve(input.userId, 'mfa');
      const secret = this.tryOpenTotpSecret(input.userId, user.totp_secret);
      if (secret === null) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
      await this.consumeTotpCode(input.userId, secret, input.totpCode!);
      await recordSuccess(this.sql, input.userId, 'mfa');
      return;
    }
    const expected = input.webauthnChallenge;
    if (!expected) throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
    if (asCredentialList(user.webauthn_creds).length === 0) {
      throw new AuthError('Enrol a security key before confirming with a passkey', 'auth.webauthn_not_enrolled');
    }
    const clientChallenge = readClientChallenge(input.webauthn!.response.clientDataJSON);
    if (!clientChallenge || clientChallenge !== expected) {
      throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
    }
    await this.verifyAssertionAndAdvanceCounter(
      input.userId,
      expected,
      input.webauthn!,
      () => {
        throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      },
      input.purpose,
    );
  }

  async stepUp(input: {
    userId: string;
    sessionId: string;
    totpCode?: string;
    webauthn?: AuthenticationResponseJSON;
  }): Promise<{ accessToken: string; expiresAt: Date; scopes: Scope[] }> {
    const hasTotp = typeof input.totpCode === 'string' && input.totpCode.length > 0;
    const hasWebauthn = input.webauthn !== undefined && input.webauthn !== null;
    if (hasTotp === hasWebauthn) {
      throw new AuthError('Provide either a TOTP code or a WebAuthn assertion', 'auth.mfa_invalid');
    }
    const users = await this.sql<
      Array<{ totp_secret: string | null; status: string; webauthn_creds: StoredWebAuthnCredential[] }>
    >`SELECT totp_secret, status, webauthn_creds FROM users WHERE id = ${input.userId}`;
    const user = users[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    const sessions = await this.sql<
      Array<{ id: string }>
    >`SELECT id FROM sessions WHERE id = ${input.sessionId} AND user_id = ${input.userId} AND revoked = false AND expires_at > now()`;
    if (!sessions[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');
    if (hasTotp) {
      if (!user.totp_secret) {
        throw new AuthError('Enrol two-factor authentication before withdrawing', 'auth.mfa_not_enrolled');
      }
      // Same reserve-then-verify as login; the counter is shared with login's MFA step.
      await this.reserve(input.userId, 'mfa');
      await this.verifyMfaCode(input.userId, user.totp_secret, input.totpCode!);
      await recordSuccess(this.sql, input.userId, 'mfa');
    } else {
      if (asCredentialList(user.webauthn_creds).length === 0) {
        throw new AuthError('Enrol a security key before withdrawing with passkey step-up', 'auth.webauthn_not_enrolled');
      }
      const response = input.webauthn!;
      const clientChallenge = readClientChallenge(response.response.clientDataJSON);
      if (!clientChallenge) throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      const held = await this.challenges.take(clientChallenge, 'step-up');
      if (!held || held.userId !== input.userId) {
        throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
      }
      await this.verifyAssertionAndAdvanceCounter(
        input.userId,
        held.challenge,
        response,
        () => {
          throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
        },
        'money_out',
      );
    }
    // A step-up token carries the withdraw scope only. Founder desk scopes stay
    // on the interactive session and are re-read at the next refresh.
    const pay = await this.scopesForNewAccessToken(input.userId);
    const scopes = [...pay];
    for (const scope of STEP_UP_SCOPES) if (!scopes.includes(scope)) scopes.push(scope);
    const tier = await this.kycTier(input.userId);
    const claims = await this.sessionClaimsOf(input.userId, input.sessionId);
    const { token, expiresAt } = await issueAccessToken(
      { userId: input.userId, sessionId: input.sessionId, scopes, tier, mfa: true, ...claims },
      { ...this.tokens, accessTtlSeconds: Math.min(this.tokens.accessTtlSeconds, STEP_UP_TTL_SECONDS) },
    );
    return { accessToken: token, expiresAt, scopes };
  }

  /**
   * Mint a short-lived access token that carries the requested pay:refund
   * and/or pay:payout scopes plus the caller's ordinary session scopes.
   * No refresh token is issued. A later refresh rebuilds scopes without these.
   */
  async stepUpPay(input: {
    userId: string;
    sessionId: string;
    merchantId: string;
    scopes: readonly string[];
    factorProof: PayStepUpFactorProof;
  }): Promise<{ accessToken: string; expiresAt: Date; scopes: Scope[]; refreshable: false }> {
    const requested = payStepUpScopes(input.scopes);
    if (requested.length === 0) {
      throw new AuthError('A fresh confirmation is required. Confirm again.', 'auth.step_up_required');
    }
    const factor = await this.acceptPayStepUpFactor(input.userId, input.sessionId, input.factorProof);
    await this.assertPayStepUpRole(input.userId, input.merchantId, requested);
    const base = await this.scopesForNewAccessToken(input.userId);
    const scopes = [...base];
    for (const scope of requested) if (!scopes.includes(scope)) scopes.push(scope);
    // Read before the audit row, so a session that cannot mint leaves no record of a mint.
    const claims = await this.sessionClaimsOf(input.userId, input.sessionId);
    await this.sql`
      INSERT INTO pay_step_up_mints (audit_id, user_id, session_id, merchant_id, scopes, factor)
      VALUES (${randomUUID()}, ${input.userId}, ${input.sessionId}, ${input.merchantId}, ${[...requested]}, ${factor})
    `;
    const tier = await this.kycTier(input.userId);
    const { token, expiresAt } = await issueAccessToken(
      {
        userId: input.userId,
        sessionId: input.sessionId,
        scopes,
        tier,
        mfa: true,
        ...claims,
        stepUpScopes: requested,
      },
      { ...this.tokens, accessTtlSeconds: Math.min(this.tokens.accessTtlSeconds, PAY_STEP_UP_ACCESS_TTL_SECONDS) },
    );
    return { accessToken: token, expiresAt, scopes, refreshable: false };
  }

  private async acceptPayStepUpFactor(
    userId: string,
    sessionId: string,
    proof: PayStepUpFactorProof,
  ): Promise<'totp' | 'passkey' | 'proof'> {
    if ('proofId' in proof) {
      const rows = await this.sql<Array<{ user_id: string; session_id: string; expires_at: Date; bound_action: string | null }>>`
        SELECT user_id, session_id, expires_at, bound_action FROM pay_step_up_proofs WHERE proof_id = ${proof.proofId}
      `;
      const row = rows[0];
      // A proof issued for an API-key action is never a pay proof.
      if (!row || row.bound_action !== null || row.user_id !== userId || row.session_id !== sessionId) {
        throw new AuthError('A fresh confirmation is required. Confirm again.', 'auth.step_up_required');
      }
      const expires = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
      if (expires.getTime() <= Date.now()) {
        throw new AuthError('This confirmation timed out. Confirm again.', 'auth.step_up_expired');
      }
      const sessions = await this.sql<Array<{ id: string }>>`
        SELECT id FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND revoked = false AND expires_at > now()
      `;
      if (!sessions[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');
      return 'proof';
    }
    const method = await this.verifyFreshFactorOnly(userId, sessionId, proof);
    await this.recordPayStepUpProof(userId, sessionId, method);
    return method;
  }

  /** Verify a TOTP code or passkey assertion now. Records nothing: the factor is spent by this one call. */
  private async verifyFreshFactorOnly(
    userId: string,
    sessionId: string,
    proof: { readonly totpCode: string } | { readonly webauthn: AuthenticationResponseJSON },
  ): Promise<'totp' | 'passkey'> {
    if ('totpCode' in proof) {
      await this.proveFreshFactor({ userId, sessionId, totpCode: proof.totpCode, purpose: 'money_out' });
      return 'totp';
    }
    // The challenge is the one `startWebauthnStepUp` (`auth.stepUpOptions`) stored.
    // A body-supplied challenge is not accepted: a captured assertion would mint again.
    const clientChallenge = readClientChallenge(proof.webauthn.response.clientDataJSON);
    if (!clientChallenge) throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
    const held = await this.challenges.take(clientChallenge, 'step-up');
    if (!held || held.userId !== userId) {
      throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
    }
    await this.proveFreshFactor({
      userId,
      sessionId,
      webauthn: proof.webauthn,
      webauthnChallenge: held.challenge,
      purpose: 'money_out',
    });
    return 'passkey';
  }

  /**
   * Run one API-key action behind a fresh second factor, atomically.
   *
   * - A TOTP code or passkey assertion is verified for THIS action only (the code or challenge is
   *   spent; no reusable proof row is left behind).
   * - A `proofId` must be a proof issued for this exact action (and key, when it names one), unexpired
   *   and unused. It is consumed here, in the same transaction as the action.
   * - The action (`run`) and the audit row share one transaction: a failed action leaves no audit row and
   *   does not consume the proof; one factor yields exactly one audit row.
   * Missing proof refuses `auth.step_up_required`; a stale proof `auth.step_up_expired`.
   */
  async withApiKeyAction<T>(
    input: {
      userId: string;
      sessionId: string;
      proof?: PayStepUpFactorProof | undefined;
      action: string;
      keyId?: string | undefined;
      scopes?: readonly string[] | undefined;
    },
    run: (scope: ApiKeyActionScope) => Promise<T>,
  ): Promise<T> {
    if (!input.proof) {
      throw new AuthError('A fresh confirmation is required. Confirm again.', 'auth.step_up_required');
    }
    const proof = input.proof;
    let factor: 'totp' | 'passkey' | 'proof';
    if ('proofId' in proof) {
      factor = 'proof';
    } else {
      factor = await this.verifyFreshFactorOnly(input.userId, input.sessionId, proof);
    }
    return transaction(
      this.sql,
      async (tx) => {
        let proofId: string | null = null;
        if ('proofId' in proof) {
          const consumed = await tx<Array<{ proof_id: string }>>`
            UPDATE pay_step_up_proofs
            SET consumed_at = clock_timestamp()
            WHERE proof_id = ${proof.proofId}
              AND user_id = ${input.userId}
              AND session_id = ${input.sessionId}
              AND bound_action = ${input.action}
              AND bound_key_id IS NOT DISTINCT FROM ${input.keyId ?? null}
              AND consumed_at IS NULL
              AND expires_at > clock_timestamp()
            RETURNING proof_id
          `;
          if (!consumed[0]) {
            const stale = await tx<Array<{ expires_at: Date }>>`
              SELECT expires_at FROM pay_step_up_proofs
              WHERE proof_id = ${proof.proofId} AND user_id = ${input.userId} AND session_id = ${input.sessionId}
                AND bound_action = ${input.action} AND consumed_at IS NULL AND expires_at <= clock_timestamp()
            `;
            throw new AuthError(
              stale[0] ? 'This confirmation timed out. Confirm again.' : 'A fresh confirmation is required. Confirm again.',
              stale[0] ? 'auth.step_up_expired' : 'auth.step_up_required',
            );
          }
          proofId = consumed[0].proof_id;
          const sessions = await tx<Array<{ id: string }>>`
            SELECT id FROM sessions WHERE id = ${input.sessionId} AND user_id = ${input.userId} AND revoked = false AND expires_at > now()
          `;
          if (!sessions[0]) throw new AuthError('Session is no longer valid', 'auth.session_invalid');
        }
        const scope: ApiKeyActionScope = {
          tx: tx as unknown as Sql,
          createApiKey: (create) => this.createApiKey({ ...create, executor: tx as unknown as Sql }),
          revokeApiKey: (userId, keyId, cause) => this.revokeApiKey(userId, keyId, cause, tx as unknown as Sql),
        };
        const result = await run(scope);
        await tx`
          INSERT INTO api_key_action_audit (audit_id, user_id, session_id, action, key_id, scopes, factor, proof_id)
          VALUES (${randomUUID()}, ${input.userId}, ${input.sessionId}, ${input.action}, ${input.keyId ?? null}, ${[...(input.scopes ?? [])]}, ${factor}, ${proofId})
        `;
        return result;
      },
      { isolation: 'read committed' },
    );
  }

  private async recordPayStepUpProof(userId: string, sessionId: string, method: 'totp' | 'passkey'): Promise<void> {
    const verifiedAt = new Date();
    const expiresAt = new Date(verifiedAt.getTime() + PAY_STEP_UP_FACTOR_TTL_SECONDS * 1000);
    await this.sql`
      INSERT INTO pay_step_up_proofs (proof_id, user_id, session_id, method, verified_at, expires_at)
      VALUES (${randomUUID()}, ${userId}, ${sessionId}, ${method}, ${verifiedAt}, ${expiresAt})
    `;
  }

  private async assertPayStepUpRole(userId: string, merchantId: string, scopes: readonly PayStepUpScope[]): Promise<void> {
    if (!this.payStepUpRoleSource) {
      throw new AuthError('Your role on this merchant does not allow this', 'pay.role_not_allowed');
    }
    let grant: PayStepUpGrant;
    try {
      grant = await this.payStepUpRoleSource({ userId, merchantId });
    } catch {
      throw new AuthError('Your role on this merchant does not allow this', 'pay.role_not_allowed');
    }
    for (const scope of scopes) {
      const allowed = scope === 'pay:refund' ? grant.refundsCreate === true : grant.payoutSend === true;
      if (!allowed) {
        const permission = scope === 'pay:refund' ? 'refunds.create' : 'payout.send';
        throw new AuthError(`Your role on this merchant does not allow ${permission}`, 'pay.role_not_allowed');
      }
    }
  }

  async freezeIdentity(userId: string): Promise<{ userId: string; status: 'frozen'; subAccountsRevoked: number; apiKeysRevoked: number }> {
    const result = await transaction(this.sql, async (tx) => {
      const users = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`;
      if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
      // A closed account stays closed: freezing it would let a later unfreeze reopen it.
      if (users[0].status === 'closed') throw new AuthError('Closed accounts cannot be frozen', 'auth.account_frozen');
      await tx`UPDATE users SET status = 'frozen', updated_at = now() WHERE id = ${userId}`;
      await tx`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
      const revokedRows = await tx<
        Array<{ id: string }>
      >`UPDATE sub_accounts SET revoked = true WHERE parent_user_id = ${userId} AND revoked = false RETURNING id`;
      const revokedKeys = await tx<
        Array<{ id: string }>
      >`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze' WHERE user_id = ${userId} AND revoked = false RETURNING id`;
      return { userId, status: 'frozen' as const, subAccountsRevoked: revokedRows.length, apiKeysRevoked: revokedKeys.length };
    });
    await syncNavigatorSessionsClosedForUser(this.sql, userId);
    return result;
  }

  async unfreezeIdentity(userId: string): Promise<{ userId: string; status: 'active' }> {
    const users = await this.sql<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1`;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    if (users[0].status === 'closed') {
      throw new AuthError('Closed accounts cannot be unfrozen', 'auth.account_frozen');
    }
    await this.sql`UPDATE users SET status = 'active', updated_at = now() WHERE id = ${userId}`;
    return { userId, status: 'active' };
  }

  async createSubAccount(
    userId: string,
    label: string,
    purpose?: string,
    options: { kind?: SubAccountKind; nickname?: string } = {},
  ): Promise<{ id: string }> {
    const kind = options.kind ?? 'standard';
    const nickname = options.nickname;
    if (nickname !== undefined && !SUB_ACCOUNT_NICKNAME.test(nickname)) {
      throw new AuthError('Nickname must be 5 to 20 letters or digits', 'auth.sub_account_nickname_invalid');
    }
    // Standard is always offered. Another kind is offered only when the owner lists it; derivatives also needs
    // the main account's derivatives eligibility, which has no source yet, so it stays refused.
    if (kind !== 'standard' && (kind === 'derivatives' || !this.subAccountKinds.has(kind))) {
      throw new AuthError(`Sub-account kind ${kind} is not offered`, 'auth.sub_account_kind_unavailable');
    }
    const users = await this.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId} LIMIT 1`;
    if (!users[0]) throw new AuthError('User not found', 'auth.not_found');
    if (users[0].status !== 'active') {
      throw new AuthError(`Account is ${users[0].status}`, 'auth.account_frozen');
    }
    const cap = this.maxSubAccounts;
    if (cap === undefined) {
      throw new AuthError('IDENTITY_MAX_SUB_ACCOUNTS is unset — owner must publish a live-partition cap', 'auth.sub_account_cap_unset');
    }
    return transaction(this.sql, async (tx) => {
      const locked = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`;
      if (!locked[0]) throw new AuthError('User not found', 'auth.not_found');
      if (locked[0].status !== 'active') throw new AuthError('Account is unavailable', 'auth.account_frozen');
      const live = await tx<
        Array<{ n: string }>
      >`SELECT count(*)::text AS n FROM sub_accounts WHERE parent_user_id = ${userId} AND revoked = false`;
      const count = Number(live[0]?.n ?? '0');
      if (count >= cap) {
        throw new AuthError(
          `Sub-account limit reached (${cap}). Retire a live partition or raise IDENTITY_MAX_SUB_ACCOUNTS.`,
          'auth.sub_account_limit',
        );
      }
      if (nickname !== undefined) {
        const taken = await tx<
          Array<{ id: string }>
        >`SELECT id FROM sub_accounts WHERE parent_user_id = ${userId} AND lower(nickname) = ${nickname.toLowerCase()} LIMIT 1`;
        if (taken[0]) throw new AuthError('Nickname already used on this account', 'auth.sub_account_nickname_taken');
      }
      const rows = await tx<
        Array<{ id: string }>
      >`INSERT INTO sub_accounts (parent_user_id, label, purpose, kind, nickname) VALUES (${userId}, ${label}, ${purpose ?? null}, ${kind}, ${nickname ?? null}) RETURNING id`;
      return rows[0]!;
    });
  }

  async listSubAccounts(
    userId: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      label: string;
      purpose: string | null;
      revoked: boolean;
      frozen: boolean;
      kind: SubAccountKind;
      nickname: string | null;
      createdAt: Date;
    }>
  > {
    const published = publishedSubAccountsListLimit(limit);
    const rows = await this.sql<
      Array<{
        id: string;
        label: string;
        purpose: string | null;
        revoked: boolean;
        frozen: number;
        kind: SubAccountKind;
        nickname: string | null;
        created_at: Date;
      }>
    >`SELECT id, label, purpose, revoked, frozen, kind, nickname, created_at FROM sub_accounts WHERE parent_user_id = ${userId} ORDER BY created_at DESC LIMIT ${published}`;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      purpose: r.purpose,
      revoked: r.revoked,
      frozen: r.frozen === 1,
      kind: r.kind,
      nickname: r.nickname,
      createdAt: r.created_at,
    }));
  }

  async revokeSubAccount(userId: string, subAccountId: string): Promise<boolean> {
    const result = await this
      .sql`UPDATE sub_accounts SET revoked = true WHERE id = ${subAccountId} AND parent_user_id = ${userId} AND revoked = false`;
    return result.count > 0;
  }

  async getSubAccountOwnership(subAccountId: string): Promise<{ id: string; parentUserId: string; revoked: boolean } | null> {
    const rows = await this.sql<
      Array<{ id: string; parent_user_id: string; revoked: boolean }>
    >`SELECT id, parent_user_id, revoked FROM sub_accounts WHERE id = ${subAccountId} LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, parentUserId: row.parent_user_id, revoked: row.revoked };
  }

  async assertSubAccountOwned(userId: string, subAccountId: string | null | undefined): Promise<{ id: string; parentUserId: string }> {
    const id = typeof subAccountId === 'string' ? subAccountId.trim() : '';
    if (!id) {
      throw new AuthError(
        'Sub-account id is required — a missing id is a refusal, never a default to primary',
        'auth.sub_account_required',
      );
    }
    const row = await this.getSubAccountOwnership(id);
    if (!row || row.parentUserId !== userId) {
      throw new AuthError('Sub-account not found or not owned by caller', 'auth.sub_account_denied');
    }
    if (row.revoked) {
      throw new AuthError('Sub-account is revoked', 'auth.sub_account_revoked');
    }
    return { id: row.id, parentUserId: row.parentUserId };
  }

  async assertSubAccountTransferDoor(
    userId: string,
    fromSubAccountId: string | null | undefined,
    toSubAccountId: string | null | undefined,
  ): Promise<{ fromId: string; toId: string }> {
    const fromId = typeof fromSubAccountId === 'string' ? fromSubAccountId.trim() : '';
    const toId = typeof toSubAccountId === 'string' ? toSubAccountId.trim() : '';
    if (!fromId || !toId) {
      throw new AuthError(
        'Both from and to sub-account ids are required — a missing id is a refusal, never a default to primary',
        'auth.sub_account_required',
      );
    }
    if (fromId === toId) {
      throw new AuthError('A transfer needs two different sub-accounts', 'auth.sub_account_same');
    }
    const from = await this.assertSubAccountOwned(userId, fromId);
    const to = await this.assertSubAccountOwned(userId, toId);
    return { fromId: from.id, toId: to.id };
  }

  private defaultScopes(): Scope[] {
    return [...SESSION_SCOPES];
  }

  /**
   * Scopes for a newly issued access token. Ordinary session scopes, plus
   * `pay:read`, `pay:write`, and `pay:onboard` when the published grant says so.
   * Refund, payout, and anything else pay might return are dropped.
   * A lookup failure leaves the ordinary session in place.
   */
  async scopesForNewAccessToken(userId: string): Promise<Scope[]> {
    const base = this.defaultScopes();
    if (!this.ownerPayScopeSource) return base;
    let granted: readonly string[];
    try {
      granted = await this.ownerPayScopeSource(userId);
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : 'grant lookup failed' },
        'owner pay scope grant lookup failed; session keeps ordinary scopes',
      );
      return base;
    }
    const extra: Scope[] = [];
    if (granted.includes('pay:read')) extra.push('pay:read');
    if (granted.includes('pay:write')) extra.push('pay:write');
    if (granted.includes('pay:onboard')) extra.push('pay:onboard');
    return [...base, ...extra];
  }
}

function asCredentialList(raw: unknown): StoredWebAuthnCredential[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is StoredWebAuthnCredential =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as StoredWebAuthnCredential).credentialId === 'string' &&
      typeof (c as StoredWebAuthnCredential).publicKey === 'string' &&
      typeof (c as StoredWebAuthnCredential).counter === 'number',
  );
}

function asStringList(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string');
}

function normalizeCredId(id: string): string {
  try {
    return b64urlEncode(b64urlDecode(id));
  } catch {
    return id;
  }
}

function readClientChallenge(clientDataJSONB64: string): string | null {
  try {
    const parsed = JSON.parse(b64urlDecode(clientDataJSONB64).toString('utf8')) as { challenge?: string };
    return typeof parsed.challenge === 'string' ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function payStepUpScopes(scopes: readonly string[]): PayStepUpScope[] {
  if (scopes.length === 0) return [];
  const out: PayStepUpScope[] = [];
  for (const scope of scopes) {
    if (!isPayStepUpScope(scope)) return [];
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

function mapWebAuthnError(err: unknown): AuthError {
  if (err instanceof WebAuthnError) {
    return new AuthError(err.message, 'auth.webauthn_invalid');
  }
  return new AuthError('Invalid WebAuthn response', 'auth.webauthn_invalid');
}
