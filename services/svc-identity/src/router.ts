import { SecurityLockError } from './auth/security-lock.js';
import { createKycLevelsRouter } from './kyc/levels-router.js';
import { EMPTY_KYC_LADDER_SETTINGS, type KycLadderSettings } from './kyc/levels.js';
import { KycCaseError, kycRejectApprovalFields, requireRejectReason, type KycRejectReasons } from './kyc/cases.js';
import { kycHistoryOutputSchema, kycReasonCodeSchema } from '@intafaced/contracts/identity-kyc-cases';
import { kycCapabilitiesOutputSchema, kycCapabilitySchema } from '@intafaced/contracts/identity-kyc-capabilities';
import { KycCapabilityError } from './kyc/capabilities.js';
import { KycAttemptsError } from './kyc/attempts.js';
import { KycProfileError, type KycProfileDesk } from './kyc/profile.js';
import { KycPoaError, type KycPoaDesk } from './kyc/proof-of-address.js';
import { KycSelfieError, type KycSelfieDesk } from './kyc/selfie.js';
import {
  kycSelfieDecideInputSchema,
  kycSelfieForComplianceSchema,
  kycSelfieHandoffCheckInputSchema,
  kycSelfieHandoffCheckSchema,
  kycSelfieHandoffSchema,
  kycSelfieReadSchema,
  kycSelfieSchema,
  kycSelfieSubmitInputSchema,
} from '@intafaced/contracts/identity-kyc-selfie';
import {
  kycPoaReadInputSchema,
  kycPoaReadSchema,
  kycPoaSubmissionSchema,
  kycPoaSubmitInputSchema,
} from '@intafaced/contracts/identity-kyc-poa';
import {
  kycDocumentTypesInputSchema,
  kycDocumentTypesSchema,
  kycProfileDraftSchema,
  kycProfileSaveStepInputSchema,
  kycProfileSchema,
  kycProfileStartInputSchema,
  kycProfileSubmitInputSchema,
  kycProfileUploadInputSchema,
} from '@intafaced/contracts/identity-kyc-profile';
import { kycAttemptsSchema } from '@intafaced/contracts/identity-kyc-attempts';
import { z } from 'zod';
import { router, publicProcedure, protectedProcedure, scopedProcedure, serviceProcedure, TRPCError } from '@intafaced/contracts';
import { rankPerksSchema, rankStateSchema, accountControlResultSchema } from '@intafaced/contracts';
import {
  callFounderControl,
  identityFreezeInputSchema,
  identityRestoreInputSchema,
  type FounderControlsPort,
} from './controls/founder-controls-router.js';
import { AuthError as GuardError, requireMfa } from '@intafaced/auth';
import { requestIpAls } from './auth/auth-service-ip.js';
import { ACCOUNT_TYPES, SignUpError } from './auth/sign-up.js';
import { LoginCodeError } from './auth/login-code.js';
import { TrustedDeviceError } from './auth/trusted-devices.js';
import { trustedDeviceTrpcError } from './trusted-devices-router.js';
import type { RefreshCookieBag } from './auth/refresh-cookie.js';

declare module '@intafaced/contracts' {
  interface Context {
    /** Set by svc-identity's request hook. Absent in callers that do not install it. */
    refreshCookie?: RefreshCookieBag | null;
  }
}
import { assertEdgeSignedRequest, requestSignAls, requestSignWireSchema } from './auth/api-key-request-sign.js';
import { factorActor, factorGateTrpcError } from './auth/factor-gate.js';
import {
  AuthError,
  assertDelegateCannotGrant,
  assertNotOwnKyc,
  assertOperatorKycReview,
  ApiKeysListLimitUnsetError,
  KycPendingLimitUnsetError,
  KycRecordsListLimitUnsetError,
  SELF_FREEZE_REASONS,
  SUB_ACCOUNT_KINDS,
  SubAccountsListLimitUnsetError,
  WebauthnListLimitUnsetError,
  type AuthService,
  type KycRecordView,
} from './auth/auth-service.js';
import type { RankService } from './rank/rank-service.js';
import { HANDLE_LOOKUP_RATE_LIMITED, HandleLookupLimiter, normaliseHandleQuery, type HandleLookupLimiterPort } from './handle-lookup.js';
import { normalisePayeeEmail, normalisePayeePhone } from './payee-search.js';
import type { LedgerClient } from '@intafaced/ledger-client';
import {
  AFFILIATE_PAYOUT_RESIDUAL,
  AffiliatePayoutRefuseError,
  affiliateFreezeHonestyLine,
  affiliateMemberListStatusLine,
  affiliateTreeStatusLine,
} from './affiliates/admin-tree-read.js';
import {
  affiliatePayoutPlanStatusLine,
  assertPayoutRateProvenance,
  planAffiliatePayout,
  postAffiliatePayout,
} from './affiliates/payout-engine.js';
import { describeAffiliatesPolicy } from './affiliates/affiliates-policy.js';
import { ReferralError } from './affiliates/referral-tree.js';
import { AffiliateMembersLimitUnsetError, type ReferralService } from './affiliates/referral-service.js';
import { ShareError } from './affiliates/share-service.js';
import type { ShareService } from './affiliates/share-service.js';
import type { ReferralCodeService } from './affiliates/referral-code.js';
import type { RebindRequest, ReferralRebindService } from './affiliates/referral-rebind.js';
import type { ReferralLapse, ReferralLapseService } from './affiliates/referral-lapse.js';
import { attachWindowStatus } from './affiliates/attach-window.js';
import { FreezeError } from './affiliates/freeze-store.js';
import { AffiliateFreezesLimitUnsetError, type FreezeService } from './affiliates/freeze-service.js';
import { CommissionError } from './affiliates/commission.js';
import {
  AccrualRateRefuseError,
  accrualTierLawIsPublished,
  type AccrualTierLaw,
  UNPUBLISHED_ACCRUAL_TIER_LAW,
} from './affiliates/commission-rate-law.js';
import { accrueTreeUnderRateAuthority, accrualTreeAuthorityStatusLine } from './affiliates/accrual-tree-authority.js';
import { AccrualsLimitUnsetError, type AccrualStore } from './affiliates/accrual-store.js';
import { KYC_VAULT_UNWIRED } from './kyc/boot-vault.js';
import { KycDocumentError, KycDocumentsListLimitUnsetError, type KycDocumentVault, type StoredDocumentMeta } from './kyc/document-store.js';
import {
  ProviderRefBindError,
  type BindProviderRefInput,
  type BindProviderRefResult,
  type DocumentReview,
} from './kyc/provider-ref-bind.js';
import { FlagDisabledError } from '@intafaced/config';
import { WaitlistError, type WaitlistPosition, type WaitlistService } from './waitlist/waitlist-service.js';
import type { WaitlistWave } from './waitlist/waitlist-store.js';
import { ACTION_APPROVAL_MISSING, PrivilegedDualControlError, requirePrivilegedDualControl } from './auth/privileged-dual-control.js';
import { ActionApprovalError } from './auth/action-approval-service.js';
import { optionalFactorProof, guardedApiKeyAction } from './auth/api-key-fresh-factor.js';
import { SocialError, SocialSignin } from './social/social-signin.js';
import { signinMethodTrpc, walletAnswerFields, walletChallengeInput, walletChallengeOutput } from './signin-methods-router.js';
import { userCopy } from './user-copy.js';
import { TradeIdentityAuthError } from './auth/trade-identity-auth.js';
import type { FounderEnrolmentConfig } from './auth/founder-enrolment.js';
import type { ProfileService } from './profile/profile-service.js';
import { createProfileRouter } from './profile/profile-router.js';
import type { AccountChange } from './account/account-router.js';
import { createAccountRouter } from './account/account-router.js';
import { createAccountClosureRouter } from './closure/closure-router.js';
import type { AccountClosureService } from './closure/closure-service.js';
import { createSubAccountFeatureProcedures } from './sub-accounts/sub-account-features-router.js';
import type { SubAccountFeatureService } from './sub-accounts/sub-account-features.js';
import { createSubAccountDeleteProcedures, subAccountDeleteToTrpc } from './sub-accounts/sub-account-delete-router.js';
import { SubAccountDeleteError, type SubAccountDeleteService } from './sub-accounts/sub-account-delete.js';
import { type SubAccountEditService } from './sub-accounts/sub-account-edit.js';
import { createSubAccountEditProcedures } from './sub-accounts/sub-account-edit-router.js';
import { revokeCauseOf } from './auth/revoke-all-api-keys.js';

/**
 * svc-identity's API (§4.1).
 *
 * The contract shape lives in `packages/contracts` — this implements it. A
 * breaking change there is a compile error here, caught in the contracts PR
 * before any consumer is touched (§15.2).
 */

/** Only the canonical encoding of non-empty bytes, as `kyc.storeDocument` takes it; anything else refuses BAD_REQUEST. */
function canonicalBase64(raw: string): Buffer {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== raw)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'bytesBase64 is not valid base64' });
  return bytes;
}

export function toTrpcError(err: unknown): TRPCError {
  // Already shaped for the wire — do not re-wrap.
  if (err instanceof TRPCError) return err;

  // New-device check (I-signin-sessions-07): every sign-in door can answer it once all factors passed.
  if (err instanceof TrustedDeviceError) return trustedDeviceTrpcError(err);

  // A removal that would leave no way in, or a refused wallet answer (I-account-lifecycle-07).
  const signinMethod = signinMethodTrpc(err);
  if (signinMethod) return signinMethod;

  // A guard rejection (`requireMfa`) is not a server fault. It arrives as the
  // shared package's AuthError, which is a different class from this service's.
  if (err instanceof GuardError) {
    return new TRPCError({ code: err.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: err.message, cause: err });
  }

  // The owner's security lock refused a password change or reset (W-withdraw-09). 412, never 401: it is not a sign-out.
  if (err instanceof SecurityLockError) {
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: userCopy(err.code),
      cause: err.unlocksAt ? { code: err.code, unlocksAt: err.unlocksAt.toISOString() } : { code: err.code },
    });
  }

  if (err instanceof PrivilegedDualControlError || err instanceof ActionApprovalError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof KycDocumentError) {
    switch (err.code) {
      case 'kyc_doc.not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'kyc_doc.key_missing':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'kyc_doc.forbidden':
      case 'kyc_doc.reader_missing':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'kyc_doc.too_large':
      case 'kyc_doc.bad_content_type':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      case 'kyc_doc.decrypt_failed':
        return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
    }
  }

  if (err instanceof KycSelfieError) {
    switch (err.code) {
      case 'kyc.handoff_unset':
      case 'kyc.selfie_unconfigured':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'kyc.handoff_unknown':
      case 'kyc.selfie_unknown':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'kyc.handoff_used':
      case 'kyc.handoff_expired':
      case 'kyc.selfie_decided':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof KycPoaError) {
    switch (err.code) {
      case 'kyc.poa_not_requested':
      case 'kyc.poa_rule_unset':
      case 'kyc.poa_types_unset':
      case 'kyc.poa_unconfigured':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'kyc.poa_pending':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof KycProfileError) {
    switch (err.code) {
      case 'kyc.profile_unconfigured':
      case 'kyc.profile_none':
      case 'kyc.document_types_unset':
      case 'kyc.upload_caps_unset':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'kyc.profile_version':
      case 'kyc.profile_sent':
      case 'kyc.profile_request_open':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'kyc.upload_too_large':
        return new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: err.message, cause: err });
      case 'kyc.profile_unreadable':
        return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof KycAttemptsError) {
    return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: userCopy(err.code), cause: err });
  }

  if (err instanceof KycCapabilityError) {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }

  if (err instanceof KycCaseError) {
    switch (err.code) {
      case 'kyc.reason_codes_unset':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'kyc.reason_code_unknown':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      case 'kyc.case_state':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
  }

  if (err instanceof ProviderRefBindError) {
    switch (err.code) {
      case 'kyc_bind.record_not_found':
      case 'kyc_bind.doc_mismatch':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'kyc_bind.record_not_pending':
      case 'kyc_bind.already_set':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'kyc_bind.invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof ReferralError) {
    switch (err.code) {
      case 'referral.unknown_referrer':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'referral.already_set':
      case 'referral.cycle':
      case 'referral.depth':
      case 'referral.self':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'referral.invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      case 'referral.attach_window_closed':
      case 'referral.rebind_interested':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'referral.attach_window_unset':
      case 'referral.code_length_unset':
      case 'referral.lapse_period_unset':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'referral.code_exhausted':
      case 'referral.rebind_open':
      case 'referral.rebind_not_needed':
      case 'referral.rebind_not_open':
      case 'referral.rebind_stale':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'referral.rebind_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
  }

  if (err instanceof ShareError) {
    switch (err.code) {
      case 'share.unknown':
      case 'share.not_found':
      case 'share.profile_gone':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'share.revoked':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'share.invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof FreezeError) {
    switch (err.code) {
      case 'freeze.not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'freeze.already':
      case 'freeze.not_frozen':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'freeze.invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof CommissionError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }

  if (err instanceof AccrualRateRefuseError) {
    // PRECONDITION_FAILED: operator asked to accrue before owner rates exist.
    // Same residual class as payout refuse — invent hole was accrual, not only payout.
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${err.message} [${err.residual}]`,
      cause: err,
    });
  }

  if (err instanceof AffiliatePayoutRefuseError) {
    // PRECONDITION_FAILED: operator asked for pay before owner rates + ledger recipe exist.
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${err.message} [${err.residual}]`,
      cause: err,
    });
  }

  if (err instanceof FlagDisabledError) {
    // Drop clock / override / env pin — named code on the message so the
    // client can tell disabled from drop_pending without a second field.
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof KycPendingLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof ApiKeysListLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof SubAccountsListLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof KycRecordsListLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof WebauthnListLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof KycDocumentsListLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof AccrualsLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof AffiliateMembersLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof AffiliateFreezesLimitUnsetError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
  }

  if (err instanceof WaitlistError) {
    switch (err.code) {
      case 'waitlist.unbuilt':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
      case 'waitlist.not_found':
      case 'waitlist.unknown_referrer':
        return new TRPCError({ code: 'NOT_FOUND', message: `${err.message} [${err.code}]`, cause: err });
      case 'waitlist.self_referral':
      case 'waitlist.referral_locked':
      case 'waitlist.wave_unknown':
        return new TRPCError({ code: 'CONFLICT', message: `${err.message} [${err.code}]`, cause: err });
      case 'waitlist.email_unverified':
        return new TRPCError({ code: 'FORBIDDEN', message: `${err.message} [${err.code}]`, cause: err });
      case 'waitlist.invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
      case 'drop.wave_unset':
      case 'waitlist.wave_empty':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
    }
  }

  if (!(err instanceof AuthError)) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userCopy('error.generic'), cause: err });
  }

  const message = userCopy(err.code);

  switch (err.code) {
    case 'auth.invalid_credentials':
    case 'auth.mfa_invalid':
    case 'auth.domain_not_allowed':
    case 'auth.request_unsigned':
    case 'auth.request_stale':
    case 'auth.request_future':
    case 'auth.request_tampered':
    case 'auth.request_replay':
    case 'auth.ip_allowlist_required':
      // Deliberately the same shape as a wrong password: never confirm which
      // half of the credential was right (including "key ok, origin wrong").
      return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    case 'auth.mfa_required':
    case 'auth.second_step_expired':
      return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    case 'auth.too_many_attempts':
      // Per-account lockout (attempt-lockout.ts): retrying now cannot help, retrying later can.
      return new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: err });
    case 'auth.privileged_enrolment_requires_invite':
      // Retrying cannot help: this identity's first factor needs an invite.
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    case 'auth.mfa_not_enrolled':
    case 'auth.webauthn_not_enrolled':
      // FORBIDDEN, not UNAUTHORIZED: retrying with a code cannot help. The
      // client has to send the user through enrolment first, and the two
      // need different UI.
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    case 'auth.webauthn_invalid':
      return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    case 'identity.passkey_limit':
      // The owner's per-account limit: removing a passkey is what helps.
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
    case 'auth.kyc_not_pending':
      return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    case 'auth.kyc_self_review':
      // Operator refuse: the subject is one of the reviewers. Known, not allowed.
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    case 'auth.kyc_agent_refused':
      // Operator/agent refuse — keep the reviewed_by sentence. Not user catalog copy.
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    case 'auth.delegate_cannot_grant':
    case 'auth.sandbox_scope_not_pay':
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    case 'auth.session_invalid':
    case 'auth.session_reused':
      return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    case 'auth.handle_taken':
    case 'auth.email_taken':
    case 'auth.mfa_already_enrolled':
      return new TRPCError({ code: 'CONFLICT', message, cause: err });
    case 'auth.account_frozen':
    case 'identity.account_frozen_self':
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    case 'auth.invite_invalid':
    case 'auth.invite_expired':
    case 'auth.founder_enrolment_closed':
      // Founder enrolment (auth.registerFounder). Retrying the same call cannot help; the client
      // branches on `intafacedCode` for the copy of each.
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    case 'auth.invite_used':
      return new TRPCError({ code: 'CONFLICT', message, cause: err });
    case 'auth.not_found':
      return new TRPCError({ code: 'NOT_FOUND', message, cause: err });
    case 'auth.sub_account_required':
    case 'auth.sub_account_same':
    case 'auth.password_unchanged':
    case 'auth.password_policy':
    case 'auth.password_breached':
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
    case 'auth.sub_account_nickname_invalid':
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
    case 'auth.sub_account_nickname_taken':
      return new TRPCError({ code: 'CONFLICT', message, cause: err });
    case 'auth.sub_account_kind_unavailable':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    case 'auth.sub_account_denied':
    case 'auth.sub_account_revoked':
    case 'auth.sub_account_limit':
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    case 'auth.sub_account_cap_unset':
      // Owner number unpublished — not a 401 (no identity) or 403 (known, not allowed).
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    case 'auth.webauthn_unconfigured':
    case 'auth.totp_key_missing':
      // Server misconfiguration — enrol cannot write plaintext. Ops must set IDENTITY_TOTP_SECRET_KEY.
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    case 'auth.edge_unauthenticated':
      // Not a verdict on the developer's key: the service forwarding request material is not the edge.
      return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
    case 'auth.api_key_expired':
      return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    case 'auth.api_key_denied':
    case 'auth.api_key_revoked':
    case 'auth.session_denied':
    case 'auth.session_revoked':
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    case 'auth.reset_proof_invalid':
      // Same sentence for a wrong, expired, spent, or unknown-email proof.
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
    case 'auth.reset_unwired':
      // No mail port or no owner-published lifetime. Same answer for every address.
      return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    case 'auth.email_confirm_invalid':
      // Same sentence for a wrong, expired, spent, or rebound link.
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
    case 'auth.email_confirm_unwired':
      // No mail port, no published lifetime, or no published rate budget.
      return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    case 'auth.email_confirm_rate_limited':
      return new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: err });
    case 'auth.payee_email_unconfirmed':
    case 'auth.payee_phone_unverified':
    case 'auth.payee_phone_unset':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    case 'auth.request_window_unset':
      // The owner has not set the signing window: no signed request can be judged fresh, for any key.
      return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    case 'auth.step_up_required':
    case 'auth.step_up_expired':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${userCopy(err.code)} [${err.code}]`, cause: err });
    case 'pay.role_not_allowed':
      return new TRPCError({ code: 'FORBIDDEN', message: `${err.message} [${err.code}]`, cause: err });
  }
}

const signUpAccepted = z.object({
  accepted: z.literal(true),
  next: z.literal('confirm_email'),
  flowId: z.string().guid(),
  resendAfterSeconds: z.number().int().positive(),
});

/** A sign-up refusal for the wire. Its code goes in `cause`, so the page can name it. */
function signUpTrpcError(err: unknown): TRPCError {
  if (!(err instanceof SignUpError)) return toTrpcError(err);
  switch (err.code) {
    case 'auth.too_many_attempts':
      return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
    case 'identity.resend_too_soon':
      return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
    case 'identity.signup_unwired':
    case 'identity.age_rule_unset':
    case 'identity.screening_unset':
    case 'vendor.email':
    case 'vendor.sms':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    case 'identity.underage':
    case 'identity.region_blocked':
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    case 'auth.handle_taken':
    case 'auth.email_taken':
    case 'identity.signup_code_used':
      return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    default:
      return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
}

const loginCodeAccepted = z.object({
  accepted: z.literal(true),
  flowId: z.string().guid(),
  resendAfterSeconds: z.number().int().positive(),
});

/** Code sign-in refusals: a lockout or an early resend is 429 with its seconds, a blank setting or switched-off mail 412. */
function loginCodeTrpcError(err: unknown): TRPCError {
  if (!(err instanceof LoginCodeError)) return toTrpcError(err);
  switch (err.code) {
    case 'auth.too_many_attempts':
    case 'identity.resend_too_soon':
      return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
    case 'auth.codes_unwired':
    case 'vendor.email':
    case 'vendor.sms':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    case 'auth.code_invalid':
    case 'auth.code_expired':
      return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
}

const sessionOutput = z.object({
  accessToken: z.string(),
  /**
   * Present for a native or API client (no Origin). Omitted when the
   * request is a browser session: the refresh token is only in the
   * httpOnly `ifc_rt` cookie. Optional so both shapes parse.
   */
  refreshToken: z.string().optional(),
  expiresAt: z.string(),
  userId: z.string().guid(),
  /** A device key just trusted, for a native or API client only (a browser gets the `ifc_dk` cookie instead). */
  deviceKey: z.string().optional(),
  /** Present only when this sign-in's second step spent a recovery code: how many codes the account has left. */
  recoveryCodesLeft: z.number().int().min(0).optional(),
});

/** The tiers a user can ask for. `none` is the absence of a record, not a request. */
const submittableTier = z.enum(['basic', 'full', 'institutional']);

const kycRecordOutput = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  tier: z.enum(['none', 'basic', 'full', 'institutional']),
  jurisdiction: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  reviewedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

/** A KYC decision is an operator's: any service caller or agent key is refused, whatever its name. */
function refuseAgentKycReview(ctx: { service?: string | null; principal: { kid?: string | null } }): void {
  assertOperatorKycReview({ service: ctx.service, kid: ctx.principal.kid });
}

/**
 * What a KYC record looks like on the wire.
 *
 * `providerRef` and `reviewedBy` are deliberately absent. §10 PII isolation:
 * the provider pointer is an internal reference to a document store, and naming
 * the reviewing operator to the user under review is how a compliance officer
 * acquires a personal adversary. Both stay server-side.
 */
function presentKyc(record: KycRecordView) {
  return {
    id: record.id,
    userId: record.userId,
    tier: record.tier,
    jurisdiction: record.jurisdiction,
    status: record.status,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Meta only on the wire — never bytes, never ciphertext. */
function presentDocMeta(meta: StoredDocumentMeta) {
  return {
    id: meta.id,
    userId: meta.userId,
    contentType: meta.contentType,
    byteLength: meta.byteLength,
    storedBy: meta.storedBy,
    createdAt: meta.createdAt.toISOString(),
  };
}

const kycDocMetaOutput = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  contentType: z.string(),
  byteLength: z.number().int().positive(),
  storedBy: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * One row of a subject's document list: the meta, and the review of the KYC record attached to it. Identity keeps no
 * decision per document yet (OPS-cases-07), so the status is the record's: `not_attached` when no record points at it.
 */
/** The vault is wired but the lookup of each document's review is not: a boot mis-wire, refused rather than listed as unattached. */
const KYC_DOC_REVIEWS_UNWIRED = 'kyc_doc.reviews_unwired';
/** A document read run by anyone but the operator who asked for it. */
const KYC_DOC_READER_NOT_REQUESTER = 'kyc_doc.reader_not_requester';

const kycDocListOutput = kycDocMetaOutput.extend({
  reviewStatus: z.enum(['not_attached', 'pending', 'approved', 'rejected', 'expired']),
  reviewRecordId: z.string().guid().nullable(),
  reviewTier: z.enum(['none', 'basic', 'full', 'institutional']).nullable(),
});

const socialProviderName = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** No registry configured is the same as no provider registered. */
function socialOrNone(social: SocialSignin | undefined): SocialSignin {
  return social ?? new SocialSignin(null as never, { providers: new Map(), flowTtlSeconds: undefined });
}

function toSocialTrpcError(err: unknown): TRPCError {
  if (err instanceof SocialError) {
    const message = `${err.message} [${err.code}]`;
    switch (err.code) {
      case 'identity.social_flow_invalid':
      case 'identity.social_exchange_failed':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
      case 'identity.social_not_linked':
        return new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
      case 'identity.provider_taken':
        return new TRPCError({ code: 'CONFLICT', message, cause: err });
      case 'auth.not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.code, cause: err });
      default:
        // idp.social and the settings refusals: the build or the owner has not provided it.
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    }
  }
  return toTrpcError(err);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const waitlistPlaceOutput = z.object({
  position: z.number().int().positive(),
  referralCode: z.string(),
  referredCount: z.number().int().min(0),
  queueLength: z.number().int().min(0),
  /** Place among those still waiting (more referrals first, ties by join order); null once released. */
  rank: z.number().int().positive().nullable(),
  waiting: z.number().int().min(0),
  release: z.object({ waveNumber: z.number().int().positive(), releasedAt: z.string() }).nullable(),
});

function waitlistPlaceView(out: WaitlistPosition): z.infer<typeof waitlistPlaceOutput> {
  return {
    ...out,
    release: out.release ? { waveNumber: out.release.waveNumber, releasedAt: out.release.releasedAt.toISOString() } : null,
  };
}

const waveOutput = z.object({
  waveNumber: z.number().int().positive(),
  size: z.number().int().positive(),
  releasedCount: z.number().int().positive(),
  flagKey: z.string(),
  releasedBy: z.string().guid(),
  approvedBy: z.string().guid(),
  releasedAt: z.string(),
});

function waveView(w: WaitlistWave): z.infer<typeof waveOutput> {
  return {
    waveNumber: w.waveNumber,
    size: w.size,
    releasedCount: w.releasedCount,
    flagKey: w.flagKey,
    releasedBy: w.releasedBy,
    approvedBy: w.approvedBy,
    releasedAt: w.releasedAt.toISOString(),
  };
}

const rebindStateSchema = z.enum(['submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'expired']);
/** What the person sees of their own referrer change request. The deciding operator is not named. */
const rebindForCustomer = z.object({
  requestId: z.string().uuid(),
  state: rebindStateSchema,
  fromReferrerId: z.string().uuid().nullable(),
  toReferrerId: z.string().uuid(),
  reason: z.string(),
  decisionReason: z.string().nullable(),
  createdAt: z.string(),
  reviewEndsAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  appliedAt: z.string().nullable(),
});
const rebindForOperator = rebindForCustomer.extend({ userId: z.string().uuid(), decidedBy: z.string().uuid().nullable() });
/** An ended referral relationship (CM-referral-01 RF-4): who it was with, from when, the last activity and the end. */
const lapseOutput = z.object({
  userId: z.string().uuid(),
  referrerId: z.string().uuid(),
  attributedAt: z.string(),
  lastActivityAt: z.string(),
  periodSeconds: z.number().int(),
  lapsedAt: z.string(),
});
const lapseView = (l: ReferralLapse): z.infer<typeof lapseOutput> => ({
  userId: l.userId,
  referrerId: l.referrerId,
  attributedAt: l.attributedAt.toISOString(),
  lastActivityAt: l.lastActivityAt.toISOString(),
  periodSeconds: l.periodSeconds,
  lapsedAt: l.lapsedAt.toISOString(),
});
function customerRebind(r: RebindRequest): z.infer<typeof rebindForCustomer> {
  return {
    requestId: r.id,
    state: r.state,
    fromReferrerId: r.fromReferrerId,
    toReferrerId: r.toReferrerId,
    reason: r.reason,
    decisionReason: r.decisionReason,
    createdAt: r.createdAt.toISOString(),
    reviewEndsAt: iso(r.approvalExpiresAt),
    decidedAt: iso(r.decidedAt),
    appliedAt: iso(r.appliedAt),
  };
}
function operatorRebind(r: RebindRequest): z.infer<typeof rebindForOperator> {
  return { ...customerRebind(r), userId: r.userId, decidedBy: r.decidedBy };
}

export function createIdentityRouter(
  auth: AuthService,
  rank: RankService,
  options: {
    founderControls?: Pick<FounderControlsPort, 'change'>;
    /**
     * Owner-published registration gate. Unset → register refuses
     * `identity.registration_open_unset`. Explicit false → closed. Never invent true.
     */
    registrationOpen?: boolean;
    /**
     * The code-less `auth.register` door, kept for the dev and test stacks' own tools (TEST market accounts,
     * fixtures). True only when APP_ENV is exactly dev or test (index.ts). Off, every call refuses
     * `identity.register_replaced`: people sign up through `auth.signUpStart` and the mailed code.
     */
    directRegister?: boolean;
    /**
     * Founder enrolment (`auth.registerFounder`, `auth.founderEnrolmentStatus`).
     * `invites` is the parsed IDENTITY_FOUNDER_INVITE_HASHES + _EXPIRES_AT; absent
     * means enrolment is closed. Independent of `registrationOpen`. `now` is a test clock.
     */
    founderEnrolment?: { invites?: FounderEnrolmentConfig | undefined; now?: () => Date };
    webauthnEnabled?: boolean;
    /** The owner's published verification requirements and review times (I-kyc-compliance-05). Absent = none published. */
    kycLadder?: KycLadderSettings;
    /** The owner's reject reasons (IDENTITY_KYC_REJECT_REASONS, I-kyc-compliance-01). Absent or empty: every reject refuses. */
    kycRejectReasons?: KycRejectReasons;
    /** The owner's reasons for switching a capability off (I-kyc-compliance-07). Absent: every switch-off refuses. */
    kycCapabilityReasons?: KycRejectReasons;
    /** Guided verification (I-kyc-compliance-08). Absent: every `kyc.profile.*` door refuses `kyc.profile_unconfigured`. */
    kycProfile?: KycProfileDesk;
    /** Proof of address (I-kyc-compliance-11). Absent: every `kyc.proofOfAddress.*` door refuses `kyc.poa_unconfigured`. */
    kycPoa?: KycPoaDesk;
    /** Selfie (I-kyc-compliance-09). Absent: every `kyc.selfie.*` door refuses `kyc.selfie_unconfigured`. */
    kycSelfie?: KycSelfieDesk;
    /** Social sign-in. Absent means no provider is registered: every start answers `idp.social`. */
    social?: SocialSignin;
    /**
     * Founder pair (user ids). These identities may not self-enrol a FIRST
     * second factor on a password-only session (`auth.privileged_enrolment_requires_invite`).
     * Unset → only `admin:*`-scoped principals count as privileged.
     */
    privilegedUserIds?: readonly string[];
    referral?: ReferralService;
    /** Share tokens (ops.social-promotion). Token → referrer; hits; revoke. */
    share?: ShareService;
    /** Short referral codes beside the share link (CM-referral-01). */
    referralCodes?: ReferralCodeService;
    /** Reviewed referrer change (CM-referral-01 RF-3). Absent → the rebind doors refuse closed. */
    referralRebind?: ReferralRebindService;
    /** Referral lapse after the owner's inactivity period (CM-referral-01 RF-4). Absent → the lapse doors refuse closed. */
    referralLapse?: ReferralLapseService;
    /**
     * Owner setting `IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS`: how long after sign-up a person may attach a referrer
     * through a link. Undefined (blank) refuses every link attach with `referral.attach_window_unset`.
     */
    referralAttachWindowSeconds?: number;
    freeze?: FreezeService;
    /** Slice B durable accrual rows (no ledger). Optional for light tests. */
    accruals?: AccrualStore;
    /**
     * Owner-published commission tier law (DIRECTION §8).
     * Blank / unpublished → accrue refuses when the request omits tiers.
     * Default unpublished — never invent 10/5/2%.
     */
    accrualTierLaw?: AccrualTierLaw;
    /**
     * Slice C payout rail. Narrow on purpose — `post` is the only capability an
     * affiliate payout needs, and a wider handle here would let this service
     * read or reconcile balances it has no business touching (§0.6).
     *
     * Absent → payout plans but refuses to post (`affiliate.payout.ledger_unwired`).
     */
    ledger?: Pick<LedgerClient, 'post'>;
    /**
     * §10 encrypted KYC document vault. Optional so light tests and boot without
     * IDENTITY_KYC_DOC_KEY still serve auth. When absent, document procedures
     * refuse closed (PRECONDITION_FAILED) — never invent a key.
     */
    kycDocs?: KycDocumentVault;
    /**
     * Operator bind of vault document id → kyc_records.provider_ref.
     * Injected so this router never holds a free SQL handle for records.
     */
    bindKycProviderRef?: (input: BindProviderRefInput) => Promise<BindProviderRefResult>;
    /**
     * The KYC record each listed document is attached to (`kyc_records.provider_ref`). Booted with the vault; a vault
     * without it lists nothing, since a document list without its review status would read as "not attached".
     */
    kycDocumentReviews?: (userId: string, documentIds: readonly string[]) => Promise<Map<string, DocumentReview>>;
    /**
     * Action-bound approval issuer. Privileged mutates consume it.
     * Absent → those doors refuse (typed-in second name is not enough).
     */
    actionApprovals?: Pick<import('./auth/action-approval-service.js').ActionApprovalService, 'consume'> &
      Partial<Pick<import('./auth/action-approval-service.js').ActionApprovalService, 'partiesOf'>>;
    /**
     * Drop 0 waitlist + referral queue. Absent → named `waitlist.unbuilt`
     * (no silent enroll). Wired in index.ts against SqlWaitlistStore.
     */
    waitlist?: WaitlistService;
    /**
     * Per-caller budget for `users.resolveHandle`. Defaults to 30 per minute,
     * process-local. Injected so tests can pin the clock and a shared store can
     * replace it later.
     */
    handleLookupLimiter?: HandleLookupLimiterPort;
    /**
     * Live staff session required before unfreeze. Absent in light router
     * tests; index.ts wires the session row check. A revoked row refuses.
     */
    assertStaffSessionLive?: (sessionId: string, userId: string) => Promise<void>;
    /** Customer profile edit. Absent → `profile.get` / `profile.update` refuse closed. */
    profile?: ProfileService;
    /** Email and phone change. Absent → those doors refuse closed. */
    account?: AccountChange;
    /** Account closure. Absent → the door refuses `identity.close_disabled`. */
    closure?: AccountClosureService;
    /** Sub-account delete. Absent → `subAccounts.delete` refuses `identity.sub_account_check_unavailable`. */
    subAccountDelete?: SubAccountDeleteService;
    /** Sub-account trading features. Absent → `subAccounts.setFeatures` refuses `identity.sub_account_features_unset`. */
    subAccountFeatures?: SubAccountFeatureService;
    subAccountEdit?: SubAccountEditService;
    /** Anti-phishing code (`profile.antiPhishing.*`). Absent: both doors refuse `identity.anti_phishing_unavailable`. */
    antiPhishing?: import('./profile/anti-phishing.js').AntiPhishingService;
  },
) {
  const webauthnEnabled = options.webauthnEnabled !== false;

  const sessionWire = (
    ctx: { refreshCookie?: RefreshCookieBag | null },
    session: { accessToken: string; refreshToken: string; expiresAt: Date; userId: string; deviceKey?: string; recoveryCodesLeft?: number },
  ) => {
    const bag = ctx.refreshCookie;
    bag?.issue(session.refreshToken, auth.refreshLifetimeSeconds());
    if (session.deviceKey) bag?.issueDevice(session.deviceKey);
    const wire = {
      accessToken: session.accessToken,
      expiresAt: session.expiresAt.toISOString(),
      userId: session.userId,
      ...(session.recoveryCodesLeft !== undefined ? { recoveryCodesLeft: session.recoveryCodesLeft } : {}),
    };
    if (bag?.browser) return wire;
    // A native or API client keeps its device key itself and presents it as `deviceKey` on sign-in.
    return { ...wire, refreshToken: session.refreshToken, ...(session.deviceKey ? { deviceKey: session.deviceKey } : {}) };
  };

  /** The trusted-device key this sign-in presents: the body's (native and API clients), else the browser's cookie. */
  const presentedDeviceKey = (ctx: { refreshCookie?: RefreshCookieBag | null }, body: string | undefined): string | null =>
    body ?? ctx.refreshCookie?.presentedDevice ?? null;

  const presentedRefreshToken = (ctx: { refreshCookie?: RefreshCookieBag | null }, body: string | undefined): string => {
    const token = body ?? ctx.refreshCookie?.presented ?? '';
    if (!token) throw new AuthError('Session not found', 'auth.session_invalid');
    return token;
  };
  const founderInvites = options.founderEnrolment?.invites;
  const founderNow = options.founderEnrolment?.now ?? (() => new Date());
  const privilegedUserIds = options.privilegedUserIds ?? [];
  const toFactorError = (err: unknown): TRPCError => factorGateTrpcError(err) ?? toTrpcError(err);
  const referral = options.referral;
  const share = options.share;
  const freeze = options.freeze;
  const accruals = options.accruals;
  const accrualTierLaw = options.accrualTierLaw ?? UNPUBLISHED_ACCRUAL_TIER_LAW;
  const ledger = options.ledger;
  const kycDocs = options.kycDocs;
  const bindKycProviderRef = options.bindKycProviderRef;
  const kycDocumentReviews = options.kycDocumentReviews;
  const waitlist = options.waitlist;
  const handleLookupLimiter = options.handleLookupLimiter ?? new HandleLookupLimiter();

  /** The owner's registration switch. Unset refuses as unset; closed says so with its own code. */
  function assertRegistrationOpen(): void {
    if (options.registrationOpen === undefined) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'REGISTRATION_OPEN is unset — owner must publish open or closed [identity.registration_open_unset]',
        cause: { code: 'identity.registration_open_unset' },
      });
    }
    if (!options.registrationOpen) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Registration is not open yet', cause: { code: 'identity.registration_closed' } });
    }
  }

  function requireReferral(): ReferralService {
    if (!referral) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Referral tree is not configured' });
    }
    return referral;
  }

  function requireReferralRebind(): ReferralRebindService {
    if (!options.referralRebind) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Referrer change review is not configured' });
    }
    return options.referralRebind;
  }

  function requireReferralLapse(): ReferralLapseService {
    if (!options.referralLapse) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Referral lapse is not configured' });
    }
    return options.referralLapse;
  }

  function requireReferralCodes(): ReferralCodeService {
    if (!options.referralCodes) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Referral codes are not configured' });
    }
    return options.referralCodes;
  }
  /** A link attach after sign-up runs under the owner's attach window (CM-referral-01). */
  const lateAttach = () => ({ windowSeconds: options.referralAttachWindowSeconds });

  function requireShare(): ShareService {
    if (!share) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Affiliate share store is not configured' });
    }
    return share;
  }

  function requireFreeze(): FreezeService {
    if (!freeze) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Affiliate freeze store is not configured' });
    }
    return freeze;
  }

  function requireAccruals(): AccrualStore {
    if (!accruals) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Affiliate accrual store is not configured' });
    }
    return accruals;
  }

  function requireKycSelfie(): KycSelfieDesk {
    if (!options.kycSelfie) throw new KycSelfieError('The selfie step is not configured', 'kyc.selfie_unconfigured');
    return options.kycSelfie;
  }
  function requireKycPoa(): KycPoaDesk {
    if (!options.kycPoa) throw new KycPoaError('Proof of address is not configured', 'kyc.poa_unconfigured');
    return options.kycPoa;
  }

  function requireKycProfile(): KycProfileDesk {
    if (!options.kycProfile) throw new KycProfileError('Guided verification is not configured', 'kyc.profile_unconfigured');
    return options.kycProfile;
  }

  function requireKycDocs(): KycDocumentVault {
    if (!kycDocs) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `KYC document vault is not configured [${KYC_VAULT_UNWIRED}]`,
      });
    }
    return kycDocs;
  }

  function readerNotRequester(): TRPCError {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: `Only the operator who asked to open this document can open it [${KYC_DOC_READER_NOT_REQUESTER}]`,
    });
  }

  function requireBindKyc(): (input: BindProviderRefInput) => Promise<BindProviderRefResult> {
    if (!bindKycProviderRef) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'KYC provider_ref bind is not configured',
      });
    }
    return bindKycProviderRef;
  }

  async function consumePrivileged(
    actorId: string,
    input: { approvalId?: string | null; operationId?: string | null },
    targetId: string,
    fields: Record<string, string> = {},
  ): Promise<{ requesterId: string; approverId: string }> {
    const approvals = options.actionApprovals;
    if (!approvals) {
      throw new PrivilegedDualControlError(
        'action-approval issuer is not wired; a typed-in second name is not approval',
        ACTION_APPROVAL_MISSING,
      );
    }
    const consumed = await requirePrivilegedDualControl(approvals, {
      actorId,
      approvalId: input.approvalId,
      operationId: input.operationId,
      targetId,
      fields,
    });
    return consumed;
  }

  /**
   * Nobody decides their own KYC: not the caller, the named second operator, the proposer or the approver.
   * Checked before the approval is consumed, so a refused decision does not spend it. A missing record is
   * not found here too, for the same reason. The decision re-checks the consumed parties under the row lock.
   */
  async function refuseOwnKyc(
    recordId: string,
    callerId: string,
    input: { approvalId?: string | null; confirmOperatorId?: string | null },
  ): Promise<void> {
    const target = await auth.getKycRecord(recordId);
    if (!target) throw new AuthError('KYC record not found', 'auth.not_found');
    const approvalId = input.approvalId?.trim();
    const parties = approvalId ? await options.actionApprovals?.partiesOf?.(approvalId) : null;
    assertNotOwnKyc(target.userId, [callerId, input.confirmOperatorId, parties?.requesterId, parties?.approverId]);
  }

  function requireWaitlist(): WaitlistService {
    if (!waitlist) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Waitlist capture is not wired [waitlist.unbuilt]',
      });
    }
    return waitlist;
  }

  return router({
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-identity') }))
      .query(() => ({ ok: true, service: 'svc-identity' as const })),

    /**
     * The caller's own handle (Receive screen, account menu). Self-only: the
     * user id comes from the session, there is no input.
     */
    me: protectedProcedure
      .output(z.object({ userId: z.string().guid(), handle: z.string(), emailVerified: z.boolean() }))
      .query(async ({ ctx }) => {
        const view = await auth.selfView(ctx.principal.userId);
        if (view === null) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
        return { userId: ctx.principal.userId, handle: view.handle, emailVerified: view.emailVerified };
      }),

    profile: createProfileRouter(options.profile, options.antiPhishing),
    account: createAccountRouter(options.account),
    accountClosure: createAccountClosureRouter(options.closure),

    users: router({
      /**
       * Pay by exact @handle: show the sender who they are about to pay.
       *
       * Returns the least that lets a sender confirm the right person: the
       * stored handle, the user id the transfer needs, and `self`. No display
       * name (a profile display name is never returned here), no email,
       * phone or legal name.
       *
       * No enumeration: exact case-insensitive match only; malformed, unknown,
       * frozen, closed and undiscoverable (to anyone but their owner) handles
       * all answer `{ found: false }`; a per-caller
       * budget (30/min) refuses bulk probing with 429. Sessions only: an API
       * key may not probe the handle space.
       */
      resolveHandle: protectedProcedure
        .input(z.object({ handle: z.string().max(64) }))
        .output(
          z.discriminatedUnion('found', [
            z.object({ found: z.literal(false) }),
            z.object({ found: z.literal(true), userId: z.string().guid(), handle: z.string(), self: z.boolean() }),
          ]),
        )
        .query(async ({ ctx, input }) => {
          if (ctx.principal.kid) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Handle lookup needs a signed-in session' });
          }
          if (!(await handleLookupLimiter.tryTake(ctx.principal.userId))) {
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: `Too many lookups. Try again in a minute. [${HANDLE_LOOKUP_RATE_LIMITED}]`,
              cause: Object.assign(new Error('handle lookup rate limited'), { code: HANDLE_LOOKUP_RATE_LIMITED }),
            });
          }
          const handle = normaliseHandleQuery(input.handle);
          if (handle === null) return { found: false as const };
          const hit = await auth.findActiveByHandle(handle);
          if (!hit) return { found: false as const };
          const self = hit.userId === ctx.principal.userId;
          // Discoverability off (PP-send-request-03): the same miss as an unknown handle for everyone but the owner.
          if (!hit.discoverable && !self) return { found: false as const };
          return { found: true as const, userId: hit.userId, handle: hit.handle, self };
        }),

      /**
       * Find a person by exact email or exact phone. Same budget and the same
       * miss as `resolveHandle`. A hit requires that person's consent flag.
       * The email and the phone are never in the answer.
       */
      searchPayees: protectedProcedure
        .input(
          z
            .object({
              email: z.string().max(320).optional(),
              phone: z.string().max(32).optional(),
            })
            .strict()
            .refine((value) => (value.email !== undefined) !== (value.phone !== undefined), 'Send an email or a phone, not both'),
        )
        .output(
          z.discriminatedUnion('found', [
            z.object({ found: z.literal(false) }),
            z.object({ found: z.literal(true), userId: z.string().guid(), handle: z.string(), self: z.boolean() }),
          ]),
        )
        .query(async ({ ctx, input }) => {
          if (ctx.principal.kid) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Payee search needs a signed-in session' });
          }
          if (!(await handleLookupLimiter.tryTake(ctx.principal.userId))) {
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: `Too many lookups. Try again in a minute. [${HANDLE_LOOKUP_RATE_LIMITED}]`,
            });
          }
          const email = input.email === undefined ? undefined : normalisePayeeEmail(input.email);
          const phone = input.phone === undefined ? undefined : normalisePayeePhone(input.phone);
          if (email === null || phone === null || (email === undefined && phone === undefined)) return { found: false as const };
          const hit = await auth.searchPayee(email !== undefined ? { email } : { phone: phone as string });
          if (!hit) return { found: false as const };
          return { found: true as const, userId: hit.userId, handle: hit.handle, self: hit.userId === ctx.principal.userId };
        }),

      /**
       * Opt in to being found by email or phone, and store the phone people
       * would match. The stored number is not returned.
       */
      setPayeeSearchConsent: protectedProcedure
        .input(
          z
            .object({
              emailConsent: z.boolean().optional(),
              phoneConsent: z.boolean().optional(),
              phone: z.string().max(32).nullable().optional(),
            })
            .strict()
            .refine(
              (value) => value.emailConsent !== undefined || value.phoneConsent !== undefined || value.phone !== undefined,
              'Nothing to change',
            ),
        )
        .output(z.object({ emailConsent: z.boolean(), phoneConsent: z.boolean(), phoneOnFile: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          if (ctx.principal.kid) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Payee search settings need a signed-in session' });
          }
          let phone: string | null | undefined;
          if (input.phone === undefined) phone = undefined;
          else if (input.phone === null) phone = null;
          else {
            phone = normalisePayeePhone(input.phone);
            if (phone === null) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'Phone numbers are stored as E.164 [identity.payee_phone_invalid]' });
            }
          }
          try {
            return await auth.setPayeeSearchConsent(ctx.principal.userId, {
              ...(input.emailConsent !== undefined ? { emailConsent: input.emailConsent } : {}),
              ...(input.phoneConsent !== undefined ? { phoneConsent: input.phoneConsent } : {}),
              ...(phone !== undefined ? { phone } : {}),
            });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    auth: router({
      register: publicProcedure
        .input(
          z.object({
            handle: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, 'handle must be 3-32 letters, numbers or underscores'),
            email: z.string().email(),
            password: z.string().min(12).max(200),
            region: z.string().length(2).optional(),
            /** A native or API client's own device key, trusted with the new account (a browser's comes in `ifc_dk`). */
            deviceKey: z.string().min(16).max(128).optional(),
            /**
             * Optional referrer at signup. Same law as `affiliates.attribute`
             * (self/cycle/depth/unknown refuse loud). Blank = no edge.
             * Account is created first; a failed attribute still leaves the user
             * (they can fix referrer via attribute later if product allows once).
             */
            referrerId: z.string().guid().optional(),
          }),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          assertRegistrationOpen();
          if (options.directRegister !== true) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Sign up with auth.signUpStart and the mailed code [identity.register_replaced]',
              cause: { code: 'identity.register_replaced' },
            });
          }
          try {
            const { referrerId, ...registerInput } = input;
            const session = await auth.register({
              ...registerInput,
              ip: requestIpAls.getStore(),
              deviceKey: presentedDeviceKey(ctx, registerInput.deviceKey),
            });
            if (referrerId) {
              await requireReferral().attribute({ userId: session.userId, referrerId });
            }
            return sessionWire(ctx, session);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Sign-up, step 1 (I-signin-sessions-18, I-kyc-compliance-06). Eligibility first (age, country,
       * nationality), then the password, then a six-digit code by email. Answers the same for a new address
       * and one that already has an account, and opens no session. Phone sign-up needs an SMS provider and
       * answers `vendor.sms` in this build; email sign-up works without it.
       */
      signUpStart: publicProcedure
        .input(
          z.object({
            channel: z.enum(['email', 'phone']),
            handle: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, 'handle must be 3-32 letters, numbers or underscores'),
            email: z.string().trim().email().max(320).optional(),
            phone: z.string().trim().max(20).optional(),
            password: z.string().max(200),
            country: z.string().trim().length(2),
            nationality: z.string().trim().length(2).optional(),
            dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date of birth must be YYYY-MM-DD'),
            accountType: z.enum(ACCOUNT_TYPES),
            referrerId: z.string().guid().optional(),
            /**
             * The invitation link the person signed up from (CM-referral-01, ENGINE RF-1): its referrer is attached when
             * the account is made, outside the late-attach window. An unknown or revoked link names no one; it never
             * blocks the sign-up.
             */
            inviteToken: z.string().guid().optional(),
          }),
        )
        .output(signUpAccepted)
        .mutation(async ({ input }) => {
          assertRegistrationOpen();
          try {
            if (input.channel === 'phone') {
              throw new SignUpError(
                'Phone sign-up needs a text-message provider, which is not connected in this build. Use email.',
                'vendor.sms',
              );
            }
            if (!input.email) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter an email address.' });
            const { channel: _channel, phone: _phone, email, inviteToken, ...rest } = input;
            const invitedBy = !rest.referrerId && inviteToken && share ? await share.referrerOf(inviteToken) : null;
            return await auth.signUpStart({ ...rest, email, ...(invitedBy ? { referrerId: invitedBy } : {}) });
          } catch (err) {
            throw signUpTrpcError(err);
          }
        }),

      /** Sign-up, step 1b: another code once the resend interval has passed. Same answer for either kind of address. */
      signUpResend: publicProcedure
        .input(z.object({ flowId: z.string().guid() }))
        .output(signUpAccepted)
        .mutation(async ({ input }) => {
          assertRegistrationOpen();
          try {
            return await auth.signUpResend(input);
          } catch (err) {
            throw signUpTrpcError(err);
          }
        }),

      /**
       * Sign-up, step 2: the right code makes the account, marks the email proved and opens the first session.
       * A wrong code counts toward the owner's lockout; a used code is refused. `accountType` tells the app
       * whether to open business verification next.
       */
      signUpConfirm: publicProcedure
        .input(z.object({ flowId: z.string().guid(), code: z.string().trim().min(1).max(12) }))
        .output(sessionOutput.and(z.object({ accountType: z.enum(ACCOUNT_TYPES) })))
        .mutation(async ({ input, ctx }) => {
          assertRegistrationOpen();
          try {
            const done = await auth.signUpConfirm({ ...input, ip: requestIpAls.getStore(), deviceKey: presentedDeviceKey(ctx, undefined) });
            if (done.referrerId) {
              // Attribution never blocks the account (it is already made); a refusal, or no referral tree, is logged.
              try {
                await requireReferral().attribute({ userId: done.session.userId, referrerId: done.referrerId });
              } catch (err) {
                const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
                process.stderr.write(`${JSON.stringify({ level: 'warn', code, msg: 'identity.signup_referral_refused' })}\n`);
              }
            }
            return { ...sessionWire(ctx, done.session), accountType: done.accountType };
          } catch (err) {
            throw signUpTrpcError(err);
          }
        }),

      /**
       * Is the founder enrolment door open? True only while the founder pair is not
       * pinned, invites are configured, the expiry has not passed and one is unspent.
       * Public and input-free; reveals nothing else.
       */
      founderEnrolmentStatus: publicProcedure.output(z.object({ open: z.boolean() })).query(async () => {
        try {
          return { open: await auth.founderEnrolmentOpen(founderInvites, founderNow()) };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

      /**
       * Founder enrolment: an invite-gated, single-use `register`. Independent of
       * REGISTRATION_OPEN, so public sign-up stays closed. Refuses forever once the
       * founder pair is pinned. Same handle/email/password rules as `register`;
       * the session it returns is a password session (mfa false) that may enrol
       * its first factor (the account is not privileged until pinned).
       * Errors (`intafacedCode`): auth.invite_invalid, auth.invite_used,
       * auth.invite_expired, auth.founder_enrolment_closed, plus handle/email taken.
       */
      registerFounder: publicProcedure
        .input(
          z.object({
            invite: z.string().min(1).max(100),
            handle: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, 'handle must be 3-32 letters, numbers or underscores'),
            email: z.string().email(),
            password: z.string().min(12).max(200),
            deviceKey: z.string().min(16).max(128).optional(),
          }),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            const session = await auth.registerFounder(
              { ...input, ip: requestIpAls.getStore(), deviceKey: presentedDeviceKey(ctx, input.deviceKey) },
              founderInvites,
              founderNow(),
            );
            return sessionWire(ctx, session);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      login: publicProcedure
        .input(
          z.object({
            identifier: z.string().min(1),
            password: z.string().min(1),
            totpCode: z.string().optional(),
            deviceKey: z.string().min(16).max(128).optional(),
          }),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            const session = await auth.login({ ...input, deviceKey: presentedDeviceKey(ctx, input.deviceKey) });
            return sessionWire(ctx, session);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * The second step by passkey (I-signin-sessions-10). `login` answered `auth.mfa_required` with a passkey challenge
       * (`secondStep.passkey`) once the password verified; the assertion over it opens a two-factor session. A passkey of
       * another account, or one bound to other actions, answers `auth.webauthn_invalid` and counts on the MFA lockout.
       */
      loginSecondStepPasskey: publicProcedure
        .input(
          z.object({
            credential: z.object({
              id: z.string().min(1),
              rawId: z.string().min(1),
              type: z.literal('public-key'),
              response: z.object({
                clientDataJSON: z.string().min(1),
                authenticatorData: z.string().min(1),
                signature: z.string().min(1),
                userHandle: z.string().nullish(),
              }),
              clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
            }),
            deviceKey: z.string().min(16).max(128).optional(),
          }),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
          try {
            const session = await auth.loginSecondStepPasskey({
              credential: input.credential,
              ip: requestIpAls.getStore(),
              deviceKey: presentedDeviceKey(ctx, input.deviceKey),
            });
            return sessionWire(ctx, session);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Sign-in by a mailed code, step 1 (I-signin-sessions-19, -20). Takes an email or handle and answers the same
       * for every name, with no session: only an active account is mailed a six-digit code.
       */
      loginCodeRequest: publicProcedure
        .input(z.object({ identifier: z.string().trim().min(1).max(320) }))
        .output(loginCodeAccepted)
        .mutation(async ({ input }) => {
          try {
            return await auth.loginCodeRequest(input);
          } catch (err) {
            throw loginCodeTrpcError(err);
          }
        }),

      /** Sign-in by a mailed code, step 1b: a new code once the resend interval has passed; the old one stops working. */
      loginCodeResend: publicProcedure
        .input(z.object({ flowId: z.string().guid() }))
        .output(loginCodeAccepted)
        .mutation(async ({ input }) => {
          try {
            return await auth.loginCodeResend(input);
          } catch (err) {
            throw loginCodeTrpcError(err);
          }
        }),

      /**
       * Sign-in by a mailed code, step 2: the right code opens one session. A wrong code counts toward the owner's
       * lockout, a used one is refused, and an account with an authenticator still answers `auth.mfa_required` until
       * its code comes too (the mailed code stays unspent meanwhile).
       */
      loginWithCode: publicProcedure
        .input(
          z.object({
            flowId: z.string().guid(),
            code: z.string().trim().min(1).max(12),
            totpCode: z.string().trim().min(1).max(64).optional(),
            deviceKey: z.string().min(16).max(128).optional(),
          }),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            return sessionWire(
              ctx,
              await auth.loginWithCode({ ...input, ip: requestIpAls.getStore(), deviceKey: presentedDeviceKey(ctx, input.deviceKey) }),
            );
          } catch (err) {
            throw loginCodeTrpcError(err);
          }
        }),

      /**
       * Social sign-in, step 1. With no provider registered this answers the allowlisted `idp.social`.
       * The same answer for every provider name, so a name tells a caller nothing.
       */
      oauthStart: publicProcedure
        .input(z.object({ provider: socialProviderName }).strict())
        .output(z.object({ provider: z.string(), authorizationUrl: z.string(), expiresAt: z.string() }).strict())
        .mutation(async ({ input }) => {
          try {
            const started = await socialOrNone(options.social).start({ provider: input.provider, purpose: 'signin' });
            return { provider: started.provider, authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt.toISOString() };
          } catch (err) {
            throw toSocialTrpcError(err);
          }
        }),

      /**
       * Social sign-in, step 2. Signs in only an account that already linked this provider identity;
       * the provider's email never links or creates one. An account with a second factor still needs its code.
       */
      oauthComplete: publicProcedure
        .input(
          z
            .object({
              provider: socialProviderName,
              state: z.string().min(1).max(200),
              code: z.string().min(1).max(2000),
              totpCode: z.string().optional(),
            })
            .strict(),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            const social = socialOrNone(options.social);
            const done = await social.complete({ provider: input.provider, purpose: 'signin', state: input.state, code: input.code });
            const userId = await social.findLinked(input.provider, done.profile.subject);
            if (!userId) throw new SocialError('That provider account is not linked to an account', 'identity.social_not_linked');
            return sessionWire(
              ctx,
              await auth.signInVerifiedIdentity(userId, {
                ...(input.totpCode === undefined ? {} : { totpCode: input.totpCode }),
                deviceKey: presentedDeviceKey(ctx, undefined),
              }),
            );
          } catch (err) {
            throw toSocialTrpcError(err);
          }
        }),

      /**
       * Wallet sign-in, step 1 (I-account-lifecycle-07): the EIP-4361 message a wallet signs, single use. The same answer
       * for every wallet, linked or not.
       */
      walletChallenge: publicProcedure
        .input(walletChallengeInput)
        .output(walletChallengeOutput)
        .mutation(async ({ input }) => {
          try {
            return await auth.walletSigninChallenge({
              address: input.address,
              chainId: input.chainId,
              ...(input.origin ? { origin: input.origin } : {}),
            });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Wallet sign-in, step 2: the signature from a wallet an account linked signs that account in, and its second step
       * still follows. An unlinked wallet answers `auth.invalid_credentials`; the challenge is spent either way.
       */
      walletSignIn: publicProcedure
        .input(
          z
            .object({
              ...walletAnswerFields,
              totpCode: z.string().trim().min(1).max(64).optional(),
              deviceKey: z.string().min(16).max(128).optional(),
            })
            .strict(),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            return sessionWire(
              ctx,
              await auth.loginWithWallet({ ...input, ip: requestIpAls.getStore(), deviceKey: presentedDeviceKey(ctx, input.deviceKey) }),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * New-device sign-in (I-signin-sessions-07), from the waiting browser: the code mailed to the account approves this
       * device and signs in at once. The flow's secret, which only that browser holds, proves it is the one asking. A
       * wrong code counts toward the owner's lockout.
       */
      deviceApprove: publicProcedure
        .input(
          z
            .object({
              flowId: z.string().guid(),
              secret: z.string().min(16).max(128),
              code: z.string().trim().min(1).max(12),
              deviceKey: z.string().min(16).max(128).optional(),
            })
            .strict(),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            return sessionWire(
              ctx,
              await auth.deviceApprove({ ...input, ip: requestIpAls.getStore(), deviceKey: presentedDeviceKey(ctx, input.deviceKey) }),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * New-device sign-in, after a trusted session approved it: the waiting browser completes once with its secret.
       * Not approved yet answers `auth.device_authorisation_pending`; a second completion `auth.device_authorisation_used`.
       */
      deviceComplete: publicProcedure
        .input(
          z
            .object({ flowId: z.string().guid(), secret: z.string().min(16).max(128), deviceKey: z.string().min(16).max(128).optional() })
            .strict(),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            return sessionWire(
              ctx,
              await auth.deviceComplete({ ...input, ip: requestIpAls.getStore(), deviceKey: presentedDeviceKey(ctx, input.deviceKey) }),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      refresh: publicProcedure
        .input(z.object({ refreshToken: z.string().min(1).optional() }).optional())
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          try {
            const session = await auth.refresh(presentedRefreshToken(ctx, input?.refreshToken));
            return sessionWire(ctx, session);
          } catch (err) {
            if (
              !input?.refreshToken &&
              err instanceof AuthError &&
              (err.code === 'auth.session_reused' || err.code === 'auth.session_invalid')
            ) {
              ctx.refreshCookie?.clear();
            }
            throw toTrpcError(err);
          }
        }),

      logout: publicProcedure
        .input(z.object({ refreshToken: z.string().min(1).optional() }).optional())
        .output(z.object({ ok: z.literal(true) }))
        .mutation(async ({ input, ctx }) => {
          const token = input?.refreshToken ?? ctx.refreshCookie?.presented ?? '';
          if (token) await auth.logout(token);
          ctx.refreshCookie?.clear();
          return { ok: true as const };
        }),

      logoutAll: protectedProcedure.output(z.object({ revoked: z.number() })).mutation(async ({ ctx }) => ({
        revoked: await auth.logoutAll(ctx.principal.userId),
      })),

      /**
       * Change the signed-in user's password. User sessions only (an API key or
       * sub-account is refused), the current password is required, and an account
       * with any second factor also needs an `mfa` session. Revokes every OTHER
       * session; the caller's stays. Rules: auth-service `changePassword`.
       */
      changePassword: protectedProcedure
        .input(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }))
        .output(z.object({ ok: z.literal(true) }))
        .mutation(async ({ ctx, input }) => {
          try {
            await auth.changePassword({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              actor: factorActor(ctx.principal, privilegedUserIds),
              currentPassword: input.currentPassword,
              newPassword: input.newPassword,
            });
            return { ok: true as const };
          } catch (err) {
            // A typo in the current password is not an expired session. Every 401 makes the
            // apps sign the person out, so this door answers 403 (code stays in `cause`).
            if (err instanceof AuthError && err.code === 'auth.invalid_credentials') {
              throw new TRPCError({ code: 'FORBIDDEN', message: userCopy(err.code), cause: err });
            }
            throw toFactorError(err);
          }
        }),

      /**
       * Self-service freeze (I-account-lifecycle-08). Needs the current password; revokes every session and key.
       * Not the staff freeze and not the ledger freeze.
       */
      selfFreeze: protectedProcedure
        .input(z.object({ reason: z.enum(SELF_FREEZE_REASONS), password: z.string().min(1).max(200) }))
        .output(z.object({ frozen: z.literal(true), reason: z.enum(SELF_FREEZE_REASONS), since: z.string(), changed: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          try {
            const done = await auth.selfFreeze({
              userId: ctx.principal.userId,
              actor: factorActor(ctx.principal, privilegedUserIds),
              reason: input.reason,
              password: input.password,
            });
            return { frozen: done.frozen, reason: done.reason, since: done.since.toISOString(), changed: done.changed };
          } catch (err) {
            if (err instanceof AuthError && err.code === 'auth.invalid_credentials') {
              throw new TRPCError({ code: 'FORBIDDEN', message: userCopy(err.code), cause: err });
            }
            throw toFactorError(err);
          }
        }),

      selfFreezeStatus: protectedProcedure
        .output(z.object({ frozen: z.boolean(), reason: z.enum(SELF_FREEZE_REASONS).nullable(), since: z.string().nullable() }))
        .query(async ({ ctx }) => {
          const s = await auth.selfFreezeStatus(ctx.principal.userId);
          return { frozen: s.frozen, reason: s.reason, since: s.since ? s.since.toISOString() : null };
        }),

      /**
       * Signed-out password reset, step 1 (D-38). Same answer whether or not
       * the email is registered. The one-time code is mailed, never returned.
       * The password hash does not change here.
       */
      requestPasswordReset: publicProcedure
        .input(z.object({ email: z.string().trim().email().max(320) }))
        .output(z.object({ accepted: z.literal(true) }))
        .mutation(async ({ input }) => {
          try {
            return await auth.requestPasswordReset({ email: input.email });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Username recovery. Same shape and same answer as `requestPasswordReset`: the username is mailed to a
       * known address, and nothing in the answer says whether the address has an account.
       */
      requestHandleRecovery: publicProcedure
        .input(z.object({ email: z.string().trim().email().max(320) }))
        .output(z.object({ accepted: z.literal(true) }))
        .mutation(async ({ input }) => {
          try {
            return await auth.requestHandleRecovery({ email: input.email });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Whether recovery mail can leave the server at all. The page shows its "not live" card only when this
       * says off. It is the same for every visitor.
       */
      passwordResetChannel: publicProcedure
        .output(z.object({ emailDelivery: z.enum(['on', 'off']) }))
        .query(() => auth.passwordResetChannel()),

      /**
       * Signed-out password reset, step 2. A correct proof replaces the hash
       * and ends the old sessions. This does not sign the caller in.
       */
      completePasswordReset: publicProcedure
        .input(
          z.object({
            email: z.string().trim().email().max(320),
            code: z.string().trim().min(1).max(200),
            newPassword: z.string().max(200),
          }),
        )
        .output(z.object({ ok: z.literal(true) }))
        .mutation(async ({ input }) => {
          try {
            await auth.completePasswordReset(input);
            return { ok: true as const };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Signed-in email confirmation, step 1. The link goes to this account's
       * own address. The response does not say whether a message was sent.
       * An API key is not a session.
       */
      requestEmailConfirmation: protectedProcedure.output(z.object({ accepted: z.literal(true) })).mutation(async ({ ctx }) => {
        if (ctx.principal.kid) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Email confirmation needs a signed-in session' });
        }
        try {
          return await auth.requestEmailConfirmation({ userId: ctx.principal.userId });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

      /**
       * Email confirmation, step 2. The token is the proof. A wrong, expired,
       * spent, or rebound token is the same refusal and does not name an account.
       */
      confirmEmail: publicProcedure
        .input(z.object({ token: z.string().trim().min(1).max(500) }))
        .output(z.object({ confirmed: z.literal(true) }))
        .mutation(async ({ input }) => {
          try {
            await auth.confirmEmail({ token: input.token });
            return { confirmed: true as const };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * THE STEP-UP CHALLENGE.
       *
       * `defaultScopes()` withholds `trade:withdraw` — "added only after a
       * step-up challenge" — and there was no step-up challenge anywhere in the
       * OS, which made every withdrawal surface unreachable by a real session.
       * This is that challenge: a live session plus a fresh TOTP / recovery code
       * **or** a WebAuthn assertion (after `stepUpOptions`) buys a five-minute
       * token that carries the scope. Passkey-only accounts can withdraw without
       * TOTP theatre; lost authenticator can still step up via recovery codes.
       *
       * `protectedProcedure`, not `scopedProcedure`: the caller is proving a
       * second factor, not exercising a permission. Requiring a scope to ask for
       * a scope would only mean the answer was already yes.
       */
      /**
       * WebAuthn options for step-up (passkey withdraw). Challenge kind is
       * `step-up` so a passwordless-login assertion cannot be reused here.
       */
      stepUpOptions: protectedProcedure.mutation(async ({ ctx }) => {
        if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
        try {
          return await auth.startWebauthnStepUp(ctx.principal.userId);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

      stepUp: protectedProcedure
        .input(
          z
            .object({
              // 6-digit TOTP or single-use recovery (XXXXX-XXXXX), same field as login.
              totpCode: z
                .string()
                .regex(/^(\d{6}|[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5})$/)
                .optional(),
              webauthn: z
                .object({
                  id: z.string().min(1),
                  rawId: z.string().min(1),
                  type: z.literal('public-key'),
                  response: z.object({
                    clientDataJSON: z.string().min(1),
                    authenticatorData: z.string().min(1),
                    signature: z.string().min(1),
                    userHandle: z.string().nullish(),
                  }),
                  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
                })
                .optional(),
            })
            .refine((v) => Boolean(v.totpCode) !== Boolean(v.webauthn), {
              message: 'Provide exactly one of totpCode or webauthn',
            }),
        )
        .output(z.object({ accessToken: z.string(), expiresAt: z.string(), scopes: z.array(z.string()) }))
        .mutation(async ({ ctx, input }) => {
          try {
            const elevated = await auth.stepUp({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              totpCode: input.totpCode,
              webauthn: input.webauthn,
            });
            return { ...elevated, expiresAt: elevated.expiresAt.toISOString() };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Confirm it's you, then mint a ten-minute access token that can refund
       * or pay out. The token is not refreshable. A plain session cannot call
       * payment.refund or settlement.payout.
       *
       * Input: `{ merchantId, scopes: ('pay:refund' | 'pay:payout')[], factorProof }`.
       * `factorProof` is exactly one of `{ totpCode }`, `{ webauthn }`,
       * or `{ proofId }` from a factor verified in the last five minutes
       * (`proveFreshFactor`, STEPUP #4880). A passkey assertion is signed over
       * the single-use challenge from `auth.stepUpOptions`.
       * Output: `{ accessToken, expiresAt, scopes, refreshable: false }`.
       * Refusals: `auth.step_up_required`, `auth.step_up_expired`, `pay.role_not_allowed`.
       * Nothing is minted on a refusal.
       */
      stepUpPay: protectedProcedure
        .input(
          z.object({
            merchantId: z.string().guid(),
            scopes: z
              .array(z.enum(['pay:refund', 'pay:payout']))
              .min(1)
              .max(2),
            factorProof: z.union([
              z.object({ totpCode: z.string().regex(/^\d{6}$/) }).strict(),
              z
                .object({
                  webauthn: z.object({
                    id: z.string().min(1),
                    rawId: z.string().min(1),
                    type: z.literal('public-key'),
                    response: z.object({
                      clientDataJSON: z.string().min(1),
                      authenticatorData: z.string().min(1),
                      signature: z.string().min(1),
                      userHandle: z.string().nullish(),
                    }),
                    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
                  }),
                })
                .strict(),
              z.object({ proofId: z.string().guid() }).strict(),
            ]),
          }),
        )
        .output(
          z.object({
            accessToken: z.string(),
            expiresAt: z.string(),
            scopes: z.array(z.string()),
            refreshable: z.literal(false),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            if (ctx.principal.kid || ctx.principal.sub_account) {
              throw new TRPCError({ code: 'FORBIDDEN', message: 'API keys and sub-accounts cannot confirm a payment' });
            }
            const elevated = await auth.stepUpPay({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              merchantId: input.merchantId,
              scopes: input.scopes,
              factorProof: input.factorProof,
            });
            return { ...elevated, expiresAt: elevated.expiresAt.toISOString() };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    totp: router({
      enrol: protectedProcedure
        .output(z.object({ secret: z.string(), uri: z.string(), recoveryCodes: z.array(z.string()) }))
        .mutation(async ({ ctx }) => {
          try {
            return await auth.startTotpEnrolment(ctx.principal.userId, factorActor(ctx.principal, privilegedUserIds));
          } catch (err) {
            throw toFactorError(err);
          }
        }),

      confirm: protectedProcedure
        .input(z.object({ secret: z.string().min(16), code: z.string().regex(/^\d{6}$/) }))
        .output(z.object({ ok: z.literal(true) }))
        .mutation(async ({ ctx, input }) => {
          try {
            await auth.confirmTotpEnrolment(ctx.principal.userId, factorActor(ctx.principal, privilegedUserIds), input.secret, input.code);
            return { ok: true as const };
          } catch (err) {
            throw toFactorError(err);
          }
        }),
    }),

    /**
     * WebAuthn (§4.1 `webauthn.enroll`, §9).
     *
     * Registration is two-step under a live session (options → verify), same
     * shape as TOTP. Authentication is passwordless: options → verify issues
     * the same session tokens as password login, with `mfa: true`.
     */
    webauthn: router({
      registerOptions: protectedProcedure.mutation(async ({ ctx }) => {
        if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
        try {
          return await auth.startWebauthnRegistration(ctx.principal.userId, factorActor(ctx.principal, privilegedUserIds));
        } catch (err) {
          throw toFactorError(err);
        }
      }),

      registerVerify: protectedProcedure
        .input(
          z.object({
            id: z.string().min(1),
            rawId: z.string().min(1),
            type: z.literal('public-key'),
            response: z.object({
              clientDataJSON: z.string().min(1),
              attestationObject: z.string().min(1),
              transports: z.array(z.string()).optional(),
            }),
            clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .output(z.object({ credentialId: z.string() }))
        .mutation(async ({ ctx, input }) => {
          if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
          try {
            return await auth.confirmWebauthnRegistration(ctx.principal.userId, factorActor(ctx.principal, privilegedUserIds), input);
          } catch (err) {
            throw toFactorError(err);
          }
        }),

      authOptions: publicProcedure.input(z.object({ identifier: z.string().min(1) })).mutation(async ({ input }) => {
        if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
        try {
          return await auth.startWebauthnAuthentication(input.identifier);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

      authVerify: publicProcedure
        .input(
          z.object({
            identifier: z.string().min(1),
            credential: z.object({
              id: z.string().min(1),
              rawId: z.string().min(1),
              type: z.literal('public-key'),
              response: z.object({
                clientDataJSON: z.string().min(1),
                authenticatorData: z.string().min(1),
                signature: z.string().min(1),
                userHandle: z.string().nullish(),
              }),
              clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
            }),
          }),
        )
        .output(sessionOutput)
        .mutation(async ({ input, ctx }) => {
          if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
          try {
            const session = await auth.confirmWebauthnAuthentication(input.identifier, input.credential);
            return sessionWire(ctx, session);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** Limit required — omit never dumps credentials. */
      list: protectedProcedure
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(
          z.array(
            z.object({
              credentialId: z.string(),
              createdAt: z.string(),
              transports: z.array(z.string()).optional(),
            }),
          ),
        )
        .query(async ({ ctx, input }) => {
          if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
          try {
            return await auth.listWebauthnCredentials(ctx.principal.userId, input.limit);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Retire one enrolled authenticator. Self-only via principal.
       * Missing/foreign id → removed:false (never confirms existence).
       */
      remove: protectedProcedure
        .input(z.object({ credentialId: z.string().min(1) }))
        .output(z.object({ removed: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          if (!webauthnEnabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'WebAuthn is disabled' });
          try {
            const removed = await auth.removeWebauthnCredential(
              ctx.principal.userId,
              factorActor(ctx.principal, privilegedUserIds),
              input.credentialId,
            );
            return { removed };
          } catch (err) {
            throw toFactorError(err);
          }
        }),
    }),

    /**
     * KYC (§4.1 `kyc.start / kyc.webhook / kyc.status`).
     *
     * WHAT THIS GATES, AND WHAT IT DOES NOT. §22 — zero-KYC follows custody.
     * These procedures exist for the CUSTODIAL side: the ledger holds the asset,
     * so the jurisdiction matrix applies to it. Nothing here gates a
     * non-custodial surface, and nothing here should ever be made to: a Protocol
     * Plane module is `custodial: false`, `checkAccess` returns
     * `allowed.permissionless` for it before any tier is read, and that
     * short-circuit is the law as code (`packages/config/src/jurisdiction.ts`).
     *
     * There is no provider integration here on purpose. Approval is an OPERATOR
     * ACTION against `kyc_records` — a human decides, and the row records which
     * human. A provider webhook can be added later as one more way to move a
     * record from `pending`, without changing what approval means.
     */
    kyc: router({
      /** The verification ladder: what each level unlocks, asks for and how long review takes (I-kyc-compliance-04/05). */
      levels: createKycLevelsRouter({
        kycTier: (userId) => auth.kycTier(userId),
        settings: options.kycLadder ?? EMPTY_KYC_LADDER_SETTINGS,
      }),
      /**
       * A user asks to be verified. Grants nothing.
       *
       * There is no `userId` input, so there is no way to submit on somebody
       * else's behalf — the identity comes from the token and cannot be
       * overridden. An ownership check would be a check on a value the caller
       * supplies; not accepting the value is stronger.
       */
      submit: scopedProcedure('identity:write')
        .input(
          z.object({
            tier: submittableTier,
            /** ISO-3166 alpha-2. The matrix is keyed on it, so it is not free text. */
            jurisdiction: z.string().length(2).toUpperCase(),
            /**
             * Deliberately absent: a client-supplied `providerRef` was a free-text
             * side-channel into `kyc_records.provider_ref` (§10 PII isolation —
             * "pointer never holds a name or DOB"). Opaque refs are minted by the
             * encrypted document store (or operator tools) when that store lands;
             * user submit only opens a pending row.
             */
          }),
        )
        .output(kycRecordOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            return presentKyc(
              await auth.submitKyc({
                userId: ctx.principal.userId,
                tier: input.tier,
                jurisdiction: input.jurisdiction,
              }),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** The caller's own records, and the tier they currently add up to. Limit required — omit never dumps records. */
      status: scopedProcedure('identity:read')
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(z.object({ tier: z.enum(['none', 'basic', 'full', 'institutional']), records: z.array(kycRecordOutput) }))
        .query(async ({ ctx, input }) => {
          try {
            return {
              // Read from the same function the token issuer uses, rather than
              // re-deriving "highest approved, unexpired" here. Two implementations
              // of that rule would eventually disagree, and the one the user is
              // shown is not the one that decides what they can do.
              tier: await auth.kycTier(ctx.principal.userId),
              records: (await auth.listKycRecords(ctx.principal.userId, input.limit)).map(presentKyc),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * THE OPERATOR ACTION — THIS GRANTS TRADING ACCESS.
       *
       * `admin:compliance`, which no user session carries, plus an explicit
       * second-factor check.
       *
       * WHY `requireMfa` IS HERE AND NOT IMPLIED BY THE SCOPE.
       * `admin:compliance` is in `INTERACTIVE_ONLY_SCOPES`, so an API key that
       * carries it is refused at `requireScope` (`scope.interactive_only`).
       * That list does not force 2FA: `SESSION_MFA_SCOPES` is the value-off-
       * platform subset, and approving a record moves nothing. It is still a
       * privilege-escalation primitive, so the second factor is enforced here,
       * locally. Dual-control reuses four-eyes
       * (`confirmOperatorId` mill field → distinct `confirmActorId`) so one
       * operator cannot self-grant `institutional`.
       */
      approve: scopedProcedure('admin:compliance')
        .input(
          z.object({
            recordId: z.string().guid(),
            /** When the verification lapses. Null means it does not. */
            expiresAt: z.string().datetime({ offset: true }).nullish(),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(kycRecordOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            refuseAgentKycReview(ctx);
            await refuseOwnKyc(input.recordId, ctx.principal.userId, input);
            const parties = await consumePrivileged(ctx.principal.userId, input, 'kyc.approve', { recordId: input.recordId });
            return presentKyc(
              await auth.approveKycRecord({
                recordId: input.recordId,
                reviewerId: ctx.principal.userId,
                expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
                service: ctx.service,
                kid: ctx.principal.kid,
                confirmActorId: input.confirmOperatorId,
                approvalId: input.approvalId,
                operationId: input.operationId,
                approvalParties: [parties.requesterId, parties.approverId],
              }),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * The other half of a review. Grants nothing. Dual-control matches approve. A reject names a code from the owner's
       * reason list (I-kyc-compliance-01), checked before the approval is spent: unset refuses `kyc.reason_codes_unset`,
       * a code not listed `kyc.reason_code_unknown`. The case records it with the reviewer's note, which the customer
       * sees only when `noteVisible`, and `kycRejected` goes out after commit. A retry with the same code returns the
       * stored result; another code on a rejected case refuses `kyc.case_state`.
       */
      reject: scopedProcedure('admin:compliance')
        .input(
          z.object({
            recordId: z.string().guid(),
            reasonCode: kycReasonCodeSchema,
            customerNote: z.string().trim().min(1).max(500).nullish(),
            noteVisible: z.boolean().optional(),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(kycRecordOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            refuseAgentKycReview(ctx);
            await refuseOwnKyc(input.recordId, ctx.principal.userId, input);
            requireRejectReason(options.kycRejectReasons ?? new Map(), input.reasonCode);
            const customerNote = input.customerNote ?? null;
            const noteVisible = input.noteVisible ?? false;
            await auth.assertKycRejectable(input.recordId, { reasonCode: input.reasonCode, customerNote, noteVisible });
            // The second operator approves what the customer will read: the reason, the note and whether it shows.
            const parties = await consumePrivileged(
              ctx.principal.userId,
              input,
              'kyc.reject',
              kycRejectApprovalFields({ recordId: input.recordId, reasonCode: input.reasonCode, customerNote, noteVisible }),
            );
            return presentKyc(
              await auth.rejectKycRecord({
                recordId: input.recordId,
                reviewerId: ctx.principal.userId,
                reasonCode: input.reasonCode,
                customerNote,
                noteVisible,
                service: ctx.service,
                kid: ctx.principal.kid,
                confirmActorId: input.confirmOperatorId,
                approvalId: input.approvalId,
                operationId: input.operationId,
                approvalParties: [parties.requesterId, parties.approverId],
              }),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * The caller's own verification cases, newest first, with each one's history and, for a reject, the owner's reason
       * and fix guidance (I-kyc-compliance-01). No `userId` input: nobody reads another person's cases through this.
       */
      history: scopedProcedure('identity:read')
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(kycHistoryOutputSchema)
        .query(async ({ ctx, input }) => {
          try {
            return { cases: await auth.listKycCases(ctx.principal.userId, input.limit, options.kycRejectReasons ?? new Map()) };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** Compliance reads any person's cases, the same shape the person sees. An unknown user is `auth.not_found`. */
      historyFor: scopedProcedure('admin:compliance')
        .input(z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200) }))
        .output(kycHistoryOutputSchema)
        .query(async ({ input }) => {
          try {
            return { cases: await auth.listKycCases(input.userId, input.limit, options.kycRejectReasons ?? new Map()) };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Proof of address (I-kyc-compliance-11, J-identity-08 #5): asked for after level Basic is approved. `read` gives
       * the owner's recency rule and the accepted and refused documents for a country; `submit` stores the file in the
       * vault under the photo caps and the submission for review. No `userId` input on the customer doors.
       */
      proofOfAddress: router({
        read: scopedProcedure('identity:read')
          .input(kycPoaReadInputSchema)
          .output(kycPoaReadSchema)
          .query(async ({ ctx, input }) => {
            try {
              return await requireKycPoa().read(ctx.principal.userId, input.country);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        submit: scopedProcedure('identity:write')
          .input(kycPoaSubmitInputSchema)
          .output(kycPoaSubmissionSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              const bytes = canonicalBase64(input.bytesBase64);
              const { bytesBase64: _bytes, ...rest } = input;
              return await requireKycPoa().submit(ctx.principal.userId, { ...rest, bytes });
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        listFor: scopedProcedure('admin:compliance')
          .input(z.object({ userId: z.string().uuid(), limit: z.number().int().min(1).max(50) }).strict())
          .output(z.object({ submissions: z.array(kycPoaSubmissionSchema) }))
          .query(async ({ input }) => {
            try {
              return { submissions: await requireKycPoa().listFor(input.userId, input.limit) };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),

      /**
       * Selfie (I-kyc-compliance-09, J-identity-08 #3). The face match and liveness check are not connected, so every
       * selfie is kept for a person to compare with the ID photo. `handoff.start` makes a one-time link for the
       * person's phone; `submit` with it uses it once. No `userId` input on the customer doors: a link works only for
       * the account that made it.
       */
      selfie: router({
        read: scopedProcedure('identity:read')
          .output(kycSelfieReadSchema)
          .query(async ({ ctx }) => {
            try {
              return await requireKycSelfie().read(ctx.principal.userId);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        submit: scopedProcedure('identity:write')
          .input(kycSelfieSubmitInputSchema)
          .output(kycSelfieSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              const bytes = canonicalBase64(input.bytesBase64);
              return await requireKycSelfie().submit(ctx.principal.userId, {
                contentType: input.contentType,
                bytes,
                ...(input.handoff ? { handoff: input.handoff } : {}),
              });
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        handoff: router({
          start: scopedProcedure('identity:write')
            .output(kycSelfieHandoffSchema)
            .mutation(async ({ ctx }) => {
              try {
                return await requireKycSelfie().startHandoff(ctx.principal.userId);
              } catch (err) {
                throw toTrpcError(err);
              }
            }),
          check: scopedProcedure('identity:read')
            .input(kycSelfieHandoffCheckInputSchema)
            .output(kycSelfieHandoffCheckSchema)
            .query(async ({ ctx, input }) => {
              try {
                return await requireKycSelfie().checkHandoff(ctx.principal.userId, input.token);
              } catch (err) {
                throw toTrpcError(err);
              }
            }),
        }),
        listFor: scopedProcedure('admin:compliance')
          .input(z.object({ userId: z.string().uuid(), limit: z.number().int().min(1).max(50) }).strict())
          .output(z.object({ selfies: z.array(kycSelfieForComplianceSchema) }))
          .query(async ({ input }) => {
            try {
              return { selfies: await requireKycSelfie().listFor(input.userId, input.limit) };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /**
         * The person's decision after comparing the selfie (its frame opened through `getDocument`) with the ID photo.
         * Same class as a review: MFA, never an agent, never the reviewer's own, and the four-eyes approval binds the
         * selfie and the decision. Checked before the approval is spent.
         */
        decide: scopedProcedure('admin:compliance')
          .input(kycSelfieDecideInputSchema)
          .output(kycSelfieForComplianceSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              requireMfa(ctx.principal);
              refuseAgentKycReview(ctx);
              const desk = requireKycSelfie();
              const approvalId = input.approvalId?.trim();
              const parties = approvalId ? await options.actionApprovals?.partiesOf?.(approvalId) : null;
              assertNotOwnKyc(await desk.assertDecidable(input.selfieId, input.decision), [
                ctx.principal.userId,
                parties?.requesterId,
                parties?.approverId,
              ]);
              const consumed = await consumePrivileged(ctx.principal.userId, input, 'kyc.selfie.decide', {
                selfieId: input.selfieId,
                decision: input.decision,
              });
              return await desk.decide({
                selfieId: input.selfieId,
                decision: input.decision,
                reviewerId: ctx.principal.userId,
                approvalParties: [consumed.requesterId, consumed.approverId],
              });
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),

      /**
       * The accepted ID types for one country from the owner's list (I-kyc-compliance-08). A country with none
       * published reads `published: false`, never an empty list that looks like "nothing accepted".
       */
      documentTypes: router({
        read: scopedProcedure('identity:read')
          .input(kycDocumentTypesInputSchema)
          .output(kycDocumentTypesSchema)
          .query(({ input }) => {
            try {
              return requireKycProfile().documentTypes(input.country);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),

      /**
       * Guided verification (I-kyc-compliance-08, J-identity-08 #2): the caller's own draft, saved a step at a time so
       * it resumes where it was left. No `userId` input on any door. The fields are sealed under the KYC document key;
       * the ID photo goes to the vault under the owner's caps. `submit` opens the request through `kyc.submit`'s path.
       */
      profile: router({
        read: scopedProcedure('identity:read')
          .output(kycProfileSchema)
          .query(async ({ ctx }) => {
            try {
              return await requireKycProfile().read(ctx.principal.userId);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        start: scopedProcedure('identity:write')
          .input(kycProfileStartInputSchema)
          .output(kycProfileDraftSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await requireKycProfile().start(ctx.principal.userId, input.tier);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        saveStep: scopedProcedure('identity:write')
          .input(kycProfileSaveStepInputSchema)
          .output(kycProfileDraftSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              return await requireKycProfile().saveStep(ctx.principal.userId, input);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        upload: scopedProcedure('identity:write')
          .input(kycProfileUploadInputSchema)
          .output(kycProfileDraftSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              const bytes = canonicalBase64(input.bytesBase64);
              return await requireKycProfile().upload(ctx.principal.userId, {
                version: input.version,
                contentType: input.contentType,
                bytes,
              });
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        submit: scopedProcedure('identity:write')
          .input(kycProfileSubmitInputSchema)
          .output(z.object({ recordId: z.string().uuid(), documentCheck: z.literal('not_connected') }))
          .mutation(async ({ ctx, input }) => {
            try {
              return await requireKycProfile().submit(ctx.principal.userId, input.version);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),

      /**
       * The caller's standing against the owner's limit on rejected requests (I-kyc-compliance-10): the limit, or null
       * when none is set; the rejections in the window; when a new request opens again. No `userId` input.
       */
      attempts: router({
        read: scopedProcedure('identity:read')
          .output(kycAttemptsSchema)
          .query(async ({ ctx }) => {
            try {
              return await auth.kycAttempts(ctx.principal.userId);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),

      /**
       * What a person's verification lets them do (I-kyc-compliance-07): custody, transfer and trade, crypto and fiat,
       * each `unrequested`, `pending`, `active` or `inactive`. An approval makes the owner-mapped ones active in its own
       * transaction. `inactive` is terminal: compliance sets it with a listed reason code under a four-eyes approval.
       */
      capabilities: router({
        /** The caller's own capabilities. No `userId` input. */
        get: scopedProcedure('identity:read')
          .output(kycCapabilitiesOutputSchema)
          .query(async ({ ctx }) => {
            try {
              return await auth.listKycCapabilities(ctx.principal.userId, options.kycCapabilityReasons ?? new Map());
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /** Compliance reads any person's capabilities. An unknown user is `auth.not_found`. */
        getFor: scopedProcedure('admin:compliance')
          .input(z.object({ userId: z.string().guid() }))
          .output(kycCapabilitiesOutputSchema)
          .query(async ({ input }) => {
            try {
              return await auth.listKycCapabilities(input.userId, options.kycCapabilityReasons ?? new Map());
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /**
         * Switch one capability off for good. The only state compliance sets here is `inactive`; levels turn
         * capabilities on. The code comes from the owner's capability reason list (`IDENTITY_KYC_CAPABILITY_REASONS`;
         * unset refuses `kyc.reason_codes_unset`), and the
         * four-eyes approval binds the person, the capability and the code. Checked before the approval is spent.
         */
        set: scopedProcedure('admin:compliance')
          .input(
            z.object({
              userId: z.string().guid(),
              capability: kycCapabilitySchema,
              state: z.literal('inactive'),
              reasonCode: kycReasonCodeSchema,
              approvalId: z.string().max(128).nullish(),
              operationId: z.string().max(128).nullish(),
            }),
          )
          .output(kycCapabilitiesOutputSchema)
          .mutation(async ({ ctx, input }) => {
            try {
              requireMfa(ctx.principal);
              refuseAgentKycReview(ctx);
              assertNotOwnKyc(input.userId, [ctx.principal.userId]);
              requireRejectReason(options.kycCapabilityReasons ?? new Map(), input.reasonCode, 'capability reasons');
              await auth.assertKycCapabilityDeactivatable(input.userId, input.capability, input.reasonCode);
              const parties = await consumePrivileged(ctx.principal.userId, input, 'kyc.capabilities.set', {
                userId: input.userId,
                capability: input.capability,
                state: input.state,
                reasonCode: input.reasonCode,
              });
              return await auth.deactivateKycCapability({
                userId: input.userId,
                capability: input.capability,
                reasonCode: input.reasonCode,
                reviewerId: ctx.principal.userId,
                approvalParties: [parties.requesterId, parties.approverId],
                reasons: options.kycCapabilityReasons ?? new Map(),
              });
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),

      /** The review queue. Without it `approve` needs a record id nobody can find. Limit required — omit never invents 50. */
      pending: scopedProcedure('admin:compliance')
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(z.array(kycRecordOutput))
        .query(async ({ input }) => {
          try {
            return (await auth.listPendingKyc(input.limit)).map(presentKyc);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * §10 — operator stores a KYC document into the encrypted vault.
       *
       * Returns meta + opaque id only. NEVER returns plaintext/ciphertext.
       * Live vendor webhook remains Class X; this is the in-house store path.
       * MFA required: same privilege class as approve (document = PII grant prep).
       * Dual-control reuses four-eyes (`confirmOperatorId` mill field → distinct
       * `confirmActorId`) so one MFA `admin:compliance` session cannot PII-put.
       */
      storeDocument: scopedProcedure('admin:compliance')
        .input(
          z.object({
            userId: z.string().guid(),
            contentType: z.string().min(1).max(128),
            /** Base64 document bytes (max 10 MiB decoded). */
            bytesBase64: z.string().min(1).max(14_000_000),
            /**
             * Distinct confirming operator. Enforced after parse so
             * missing/blank/same refuse `dual_control_missing`, not a schema dump.
             */
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(kycDocMetaOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            await consumePrivileged(ctx.principal.userId, input, 'kyc.doc.store', { userId: input.userId });
            const vault = requireKycDocs();
            let bytes: Buffer;
            try {
              bytes = Buffer.from(input.bytesBase64, 'base64');
            } catch {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'bytesBase64 is not valid base64' });
            }
            // Buffer.from accepts ignored characters, padding and unused-bit
            // variants. Store only the canonical encoding of the decoded bytes.
            if (bytes.toString('base64') !== input.bytesBase64) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'bytesBase64 is not valid base64' });
            }
            // Empty after decode is a put refusal from the store; reject early for a clean code.
            if (bytes.length === 0) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'Document bytes empty' });
            }
            return presentDocMeta(
              await vault.put({
                userId: input.userId,
                contentType: input.contentType,
                bytes,
                storedBy: ctx.principal.userId,
              }),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * §10 — operator opens a KYC document from the encrypted vault.
       *
       * MFA required: same privilege class as store/approve (document = PII).
       * Dual-control reuses four-eyes (`confirmOperatorId` mill field → distinct
       * `confirmActorId`) so one MFA `admin:compliance` session cannot PII-read.
       * Refuses a blank IDENTITY_KYC_DOC_KEY before reader — no invented AES key, no plaintext.
       */
      getDocument: scopedProcedure('admin:compliance')
        .input(
          z.object({
            documentId: z.string().guid(),
            /**
             * Distinct confirming operator. Enforced after parse so
             * missing/blank/same refuse `dual_control_missing`, not a schema dump.
             */
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(kycDocMetaOutput.extend({ bytesBase64: z.string() }))
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            // A switched-off vault refuses before the approval is spent.
            const vault = requireKycDocs();
            // Only the operator who asked may spend the approval on the read: the approver, or anyone else holding the ids,
            // is refused before it is spent, and again after, so the approval is never a bearer pass to the contents.
            const reader = ctx.principal.userId;
            const approvalId = input.approvalId?.trim();
            const parties = approvalId ? await options.actionApprovals?.partiesOf?.(approvalId) : null;
            if (parties && parties.requesterId !== reader) throw readerNotRequester();
            const consumed = await consumePrivileged(reader, input, 'kyc.doc.get', { documentId: input.documentId });
            if (consumed.requesterId !== reader) throw readerNotRequester();
            const opened = await vault.getFor(input.documentId, {
              kind: 'compliance',
              operatorId: ctx.principal.userId,
            });
            return { ...presentDocMeta(opened.meta), bytesBase64: opened.bytes.toString('base64') };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Meta-only list for one subject. No document bytes on the wire.
       * Compliance scope only — not a free userId lookup for ordinary sessions.
       * Limit required — omit never dumps KYC meta.
       */
      listDocuments: scopedProcedure('admin:compliance')
        .input(z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200) }))
        .output(z.array(kycDocListOutput))
        .query(async ({ input }) => {
          try {
            const vault = requireKycDocs();
            if (!kycDocumentReviews) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `KYC document review lookup is not configured [${KYC_DOC_REVIEWS_UNWIRED}]`,
              });
            }
            const docs = await vault.listMetaForUser(input.userId, input.limit);
            // Each document's status is the review of the newest KYC record attached to it, or `not_attached` when none is.
            const reviews = await kycDocumentReviews(
              input.userId,
              docs.map((d) => d.id),
            );
            return docs.map((meta) => {
              const review = reviews.get(meta.id);
              return {
                ...presentDocMeta(meta),
                reviewStatus: review?.status ?? 'not_attached',
                reviewRecordId: review?.recordId ?? null,
                reviewTier: review?.tier ?? null,
              };
            });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Bind vault document id as kyc_records.provider_ref for a pending record.
       * Ownership of the document must match the record subject — cross-user bind refused.
       * Returns the opaque pointer only (never bytes).
       * Dual-control reuses four-eyes (`confirmOperatorId` mill field → distinct
       * `confirmActorId`) so one MFA `admin:compliance` session cannot PII-bind.
       */
      bindDocument: scopedProcedure('admin:compliance')
        .input(
          z.object({
            recordId: z.string().guid(),
            documentId: z.string().guid(),
            /**
             * Distinct confirming operator. Enforced after parse so
             * missing/blank/same refuse `dual_control_missing`, not a schema dump.
             */
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            recordId: z.string().guid(),
            userId: z.string().guid(),
            providerRef: z.string().guid(),
            document: kycDocMetaOutput,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            await consumePrivileged(ctx.principal.userId, input, 'kyc.doc.bind', {
              recordId: input.recordId,
              documentId: input.documentId,
            });
            const bind = requireBindKyc();
            const result = await bind({
              recordId: input.recordId,
              documentId: input.documentId,
              operatorId: ctx.principal.userId,
            });
            return {
              recordId: result.recordId,
              userId: result.userId,
              providerRef: result.providerRef,
              document: presentDocMeta(result.document),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    rank: router({
      // Self-only on the interactive surface. Modules use HMAC
      // GET /internal/rank/:userId/perks — never free userId on edge tRPC.
      get: scopedProcedure('identity:read')
        .input(z.object({}).optional())
        .output(rankStateSchema)
        .query(async ({ ctx }) => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          const snapshot = await rank.get(userId);
          return {
            userId: snapshot.userId,
            rank: snapshot.rank,
            xp: snapshot.xp.toString(),
            seasonXp: snapshot.seasonXp.toString(),
            nextRankAt: snapshot.xpToNext?.toString() ?? null,
            updatedAt: snapshot.updatedAt.toISOString(),
          };
        }),

      /** Interactive self-only. Cross-user hot path is S2S HMAC, not this. */
      perks: scopedProcedure('identity:read')
        .input(z.object({}).optional())
        .output(rankPerksSchema)
        .query(({ ctx }) => {
          const userId = ctx.principal.userId;
          if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
          return rank.perks(userId);
        }),

      /**
       * Service-to-service only. Modules award XP by calling this rather than by
       * writing rank_state — svc-identity is the only writer (§4.1).
       *
       * Was `publicProcedure`, then `scopedProcedure('identity:write')` after a
       * partner audit. That still failed closed the wrong way: every interactive
       * session receives `identity:write` via `defaultScopes()`, so any logged-in
       * user could mint XP (and therefore rank, fee discounts, P2P limits,
       * launchpad allocation) for any userId. `serviceProcedure` requires the
       * shared INTERNAL_SERVICE_SECRET HMAC — same bar as ledger.post (#50).
       *
       * Full audit L2-2 / L11-2, 2026-07-29.
       */
      awardXp: serviceProcedure
        .input(
          z.object({
            userId: z.string().guid(),
            sourceModule: z.string().min(1),
            action: z.string().min(1),
            xpDelta: z.number().int(),
            idempotencyKey: z.string().min(8),
            meta: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .output(z.object({ rank: z.number(), xp: z.string(), applied: z.boolean(), rankChanged: z.boolean() }))
        .mutation(async ({ input }) => {
          const result = await rank.awardXp(input);
          return {
            rank: result.snapshot.rank,
            xp: result.snapshot.xp.toString(),
            applied: result.applied,
            rankChanged: result.rankChanged,
          };
        }),
    }),

    apiKeys: router({
      /**
       * Public: long-lived key → short-lived access JWT.
       * This is what makes identity.apikeys real — create alone is not enough.
       */
      exchange: publicProcedure
        .input(z.object({ key: z.string().min(8).max(200), request: requestSignWireSchema.optional() }))
        .output(
          z.object({
            accessToken: z.string(),
            expiresAt: z.string(),
            userId: z.string().guid(),
            keyId: z.string().guid(),
            scopes: z.array(z.string()),
            mode: z.enum(['live', 'sandbox']),
            requireSignature: z.boolean().optional(),
            requireNonEmptyIpAllowlist: z.boolean().optional(),
            ipAllowlist: z.array(z.string()).optional(),
          }),
        )
        .mutation(async ({ input, ctx }) => {
          try {
            // Origin is read from the trusted edge request, never from the body.
            // A non-empty domain_whitelist refuses foreign or missing origins.
            assertEdgeSignedRequest(ctx.service, input.request);
            const clientOrigin = (ctx as { clientOrigin?: string }).clientOrigin;
            const result = await requestSignAls.run(input.request, () => auth.exchangeApiKey(input.key, clientOrigin));
            return {
              accessToken: result.accessToken,
              expiresAt: result.expiresAt.toISOString(),
              userId: result.userId,
              keyId: result.keyId,
              scopes: result.scopes,
              mode: result.mode,
              ...(result.requireSignature === undefined ? {} : { requireSignature: result.requireSignature }),
              ...(result.requireNonEmptyIpAllowlist === undefined ? {} : { requireNonEmptyIpAllowlist: result.requireNonEmptyIpAllowlist }),
              ...(result.ipAllowlist === undefined ? {} : { ipAllowlist: result.ipAllowlist }),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      create: scopedProcedure('identity:write')
        .input(
          z.object({
            name: z.string().min(1).max(64),
            scopes: z.array(z.string()).min(1),
            domainWhitelist: z.array(z.string()).optional(),
            /** pay.public-api step 4 — sandbox keys route to the sandbox rail. */
            mode: z.enum(['live', 'sandbox']).optional(),
            /** A TOTP code, passkey assertion or proof id verified in the last five minutes. */
            factorProof: optionalFactorProof,
          }),
        )
        .output(
          z.object({
            id: z.string(),
            key: z.string(),
            prefix: z.string(),
            mode: z.enum(['live', 'sandbox']),
            scopes: z.array(z.string()),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            // `grantorScopes` comes from the verified principal, never from the
            // body. A key is a delegation of THIS session's authority, so the
            // ceiling has to be read from the token that asked for it.
            // A key (`kid`) is already a delegate and cannot mint another.
            assertDelegateCannotGrant(ctx.principal.kid);
            const money = input.scopes.filter((scope) => scope === 'pay:refund' || scope === 'pay:payout');
            const stepped = new Set(ctx.principal.stp ?? []);
            const payStepUp = money.length > 0 && money.every((scope) => stepped.has(scope) && ctx.principal.scopes.includes(scope));
            if (money.length > 0 && !payStepUp) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: `${userCopy('auth.step_up_required')} [auth.step_up_required]`,
              });
            }
            const { factorProof, ...keyInput } = input;
            const created = await guardedApiKeyAction(
              auth,
              ctx.principal,
              factorProof,
              { action: 'create', scopes: input.scopes },
              (scope) =>
                scope.createApiKey({
                  userId: ctx.principal.userId,
                  ...keyInput,
                  grantorScopes: ctx.principal.scopes,
                  grantorKid: ctx.principal.kid,
                  payStepUp,
                }),
            );
            return { ...created, scopes: created.scopes ?? input.scopes };
          } catch (err) {
            if (err instanceof TRPCError) throw err;
            if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
              throw toTrpcError(err);
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
          }
        }),

      /** Limit required — omit never dumps API keys. */
      list: scopedProcedure('identity:read')
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(
          z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              prefix: z.string(),
              scopes: z.array(z.string()),
              lastUsedAt: z.string().nullable(),
              revoked: z.boolean(),
              mode: z.enum(['live', 'sandbox']),
              requireSignature: z.boolean(),
              requireNonEmptyIpAllowlist: z.boolean(),
              ipAllowlist: z.array(z.string()),
            }),
          ),
        )
        .query(async ({ ctx, input }) => {
          try {
            const keys = await auth.listApiKeys(ctx.principal.userId, input.limit);
            return keys.map((k) => ({
              id: k.id,
              name: k.name,
              prefix: k.key_prefix,
              scopes: k.scopes,
              lastUsedAt: k.last_used_at?.toISOString() ?? null,
              revoked: k.revoked,
              mode: k.mode === 'sandbox' ? ('sandbox' as const) : ('live' as const),
              requireSignature: k.require_signature === true,
              requireNonEmptyIpAllowlist: k.require_non_empty_ip_allowlist === true,
              ipAllowlist: k.ip_allowlist ?? [],
            }));
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      revoke: scopedProcedure('identity:write')
        .input(z.object({ keyId: z.string().guid() }))
        .output(z.object({ revoked: z.boolean() }))
        .mutation(async ({ ctx, input }) => ({
          revoked: await auth.revokeApiKey(ctx.principal.userId, input.keyId, revokeCauseOf(ctx.principal)),
        })),
    }),

    /**
     * Compliance freeze of an identity (SPEC-SUBACCOUNTS §3).
     * Cascades: user frozen + all sessions revoked + all sub-accounts + all API keys revoked.
     */
    compliance: router({
      freezeIdentity: protectedProcedure
        .input(identityFreezeInputSchema)
        .output(accountControlResultSchema)
        .mutation(({ ctx, input }) => callFounderControl(options.founderControls, ctx, input)),

      unfreezeIdentity: protectedProcedure
        .input(identityRestoreInputSchema)
        .output(accountControlResultSchema)
        .mutation(async ({ ctx, input }) => {
          if (options.assertStaffSessionLive) {
            try {
              await options.assertStaffSessionLive(ctx.principal.sid, ctx.principal.userId);
            } catch (err) {
              if (err instanceof TradeIdentityAuthError) {
                throw new TRPCError({ code: 'FORBIDDEN', message: `${err.message} [${err.code}]`, cause: err });
              }
              throw err;
            }
          }
          return callFounderControl(options.founderControls, ctx, input);
        }),
    }),

    subAccounts: router({
      ...createSubAccountDeleteProcedures(options.subAccountDelete),
      ...createSubAccountFeatureProcedures(options.subAccountFeatures),
      ...createSubAccountEditProcedures(options.subAccountEdit),
      create: scopedProcedure('identity:write')
        .input(
          z.object({
            label: z.string().min(1).max(64),
            purpose: z.string().max(200).optional(),
            kind: z.enum(SUB_ACCOUNT_KINDS).optional(),
            nickname: z.string().max(64).optional(),
          }),
        )
        .output(z.object({ id: z.string().guid() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await auth.createSubAccount(ctx.principal.userId, input.label, input.purpose, {
              kind: input.kind,
              nickname: input.nickname,
            });
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** Limit required — omit never dumps partitions. */
      list: scopedProcedure('identity:read')
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(
          z.array(
            z.object({
              id: z.string().guid(),
              label: z.string(),
              purpose: z.string().nullable(),
              revoked: z.boolean(),
              frozen: z.boolean(),
              kind: z.enum(SUB_ACCOUNT_KINDS),
              nickname: z.string().nullable(),
              createdAt: z.string(),
            }),
          ),
        )
        .query(async ({ ctx, input }) => {
          try {
            const rows = await auth.listSubAccounts(ctx.principal.userId, input.limit);
            return rows.map((r) => ({
              id: r.id,
              label: r.label,
              purpose: r.purpose,
              revoked: r.revoked,
              frozen: r.frozen,
              kind: r.kind,
              nickname: r.nickname,
              createdAt: r.createdAt.toISOString(),
            }));
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Soft-disable. Self-only via principal.userId → parent_user_id.
       * No ledger posts — balances under this id are untouched.
       */
      revoke: scopedProcedure('identity:write')
        .input(z.object({ subAccountId: z.string().guid() }))
        .output(z.object({ revoked: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          // Revoke is the same act as delete, so it carries the same assets and open-orders check, and fails closed.
          try {
            if (!options.subAccountDelete) throw new SubAccountDeleteError('identity.sub_account_check_unavailable');
            await options.subAccountDelete.assertEmpty(ctx.principal.userId, input.subAccountId);
          } catch (err) {
            subAccountDeleteToTrpc(err);
          }
          return { revoked: await auth.revokeSubAccount(ctx.principal.userId, input.subAccountId) };
        }),

      /**
       * Single-row ownership door (SPEC-SUBACCOUNTS §2 / D26-P1-I1).
       *
       * Pure assert — does not move value. Trade and other money surfaces that
       * name one partition call this (or the S2S ownership snapshot with the
       * same checks) before acting. Missing id refuses; never defaults to primary.
       */
      assertOwned: scopedProcedure('identity:write')
        .input(
          z.object({
            subAccountId: z.string().guid().optional().nullable(),
          }),
        )
        .output(z.object({ id: z.string().guid(), parentUserId: z.string().guid() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await auth.assertSubAccountOwned(ctx.principal.userId, input.subAccountId);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Transfer ownership door (SPEC-SUBACCOUNTS §1–§2 / D26-P1-I1).
       *
       * Pure assert — does not move value. Money services call this (or the
       * AuthService method) before posting `recipes.subAccountTransfer`. A
       * missing id refuses; it never defaults to primary.
       */
      assertTransferDoor: scopedProcedure('identity:write')
        .input(
          z.object({
            fromSubAccountId: z.string().guid().optional().nullable(),
            toSubAccountId: z.string().guid().optional().nullable(),
          }),
        )
        .output(z.object({ fromId: z.string().guid(), toId: z.string().guid() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await auth.assertSubAccountTransferDoor(ctx.principal.userId, input.fromSubAccountId, input.toSubAccountId);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    /**
     * Affiliate referral tree Slice A — attribution only (no commission, no pay).
     * Spec: docs/ops/trk/ops.affiliates.md Slice A.
     */
    affiliates: router({
      policy: publicProcedure.query(() => describeAffiliatesPolicy()),

      attribute: scopedProcedure('identity:write')
        .input(z.object({ referrerId: z.string().guid() }))
        .output(
          z.object({
            userId: z.string().guid(),
            referrerId: z.string().guid(),
            attributedAt: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const edge = await requireReferral().attribute(
              {
                userId: ctx.principal.userId,
                referrerId: input.referrerId,
              },
              lateAttach(),
            );
            return {
              userId: edge.userId,
              referrerId: edge.referrerId,
              attributedAt: edge.attributedAt.toISOString(),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * One-tap share token mapped to this principal's user id (the referrer).
       * Idempotent while unrevoked. Hits are a counter, not money.
       */
      createShare: scopedProcedure('identity:write')
        .output(
          z.object({
            token: z.string().guid(),
            referrerId: z.string().guid(),
            hits: z.number().int(),
          }),
        )
        .mutation(async ({ ctx }) => {
          try {
            const rec = await requireShare().createShare(ctx.principal.userId);
            return { token: rec.token, referrerId: rec.referrerId, hits: rec.hits };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      revokeShare: scopedProcedure('identity:write')
        .output(
          z.object({
            token: z.string().guid(),
            referrerId: z.string().guid(),
            hits: z.number().int(),
            revokedAt: z.string(),
          }),
        )
        .mutation(async ({ ctx }) => {
          try {
            const rec = await requireShare().revokeShare(ctx.principal.userId);
            return {
              token: rec.token,
              referrerId: rec.referrerId,
              hits: rec.hits,
              revokedAt: rec.revokedAt ? rec.revokedAt.toISOString() : new Date().toISOString(),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Public hit. Signed-out: increment only. Signed-in: increment then
       * attribute via the same `affiliates.attribute` path (one tree).
       * Revoked / gone profile: named refuse, no later attribute.
       */
      shareHits: publicProcedure
        .input(z.object({ token: z.string().guid() }))
        .output(z.object({ hits: z.number().int(), attributed: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          try {
            // The link owner opening their own link is refused before it counts as a visit.
            if (ctx.principal && (await requireShare().referrerOf(input.token)) === ctx.principal.userId) {
              throw new ReferralError('Self-referral is refused', 'referral.self');
            }
            const rec = await requireShare().shareHits(input.token);
            let attributed = false;
            if (ctx.principal) {
              // A signed-in person attaches once, and only to this link's referrer (J-campaigns-05 #4).
              try {
                await requireReferral().attribute({ userId: ctx.principal.userId, referrerId: rec.referrerId }, lateAttach());
                attributed = true;
              } catch (err) {
                if (!(err instanceof ReferralError && err.code === 'referral.already_set')) throw err;
                // Opening the same referrer's link again is the same relationship; another referrer's link is refused.
                const edge = await requireReferral().edgeOf(ctx.principal.userId);
                if (edge?.referrerId !== rec.referrerId) throw err;
                attributed = true;
              }
            }
            return { hits: rec.hits, attributed };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      myReferrer: scopedProcedure('identity:read')
        .output(
          z
            .object({
              userId: z.string().guid(),
              referrerId: z.string().guid(),
              attributedAt: z.string(),
            })
            .nullable(),
        )
        .query(async ({ ctx }) => {
          try {
            const edge = await requireReferral().edgeOf(ctx.principal.userId);
            if (!edge) return null;
            return {
              userId: edge.userId,
              referrerId: edge.referrerId,
              attributedAt: edge.attributedAt.toISOString(),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** This person's short referral code, or null before they asked for one (CM-referral-01). */
      myCode: scopedProcedure('identity:read')
        .output(z.object({ code: z.string(), createdAt: z.string() }).nullable())
        .query(async ({ ctx }) => {
          try {
            const rec = await requireReferralCodes().codeOf(ctx.principal.userId);
            return rec ? { code: rec.code, createdAt: rec.createdAt.toISOString() } : null;
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** Makes this person's code on the first call; repeats return the same one. Blank length refuses. */
      createCode: scopedProcedure('identity:write')
        .output(z.object({ code: z.string(), createdAt: z.string() }))
        .mutation(async ({ ctx }) => {
          try {
            const rec = await requireReferralCodes().createCode(ctx.principal.userId);
            return { code: rec.code, createdAt: rec.createdAt.toISOString() };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Whether this person may still attach a referrer through a link, measured on the server from the account's
       * creation (J-campaigns-05 #4 and #5). A blank owner window reads `unset`; nothing is invented.
       */
      attachWindow: scopedProcedure('identity:read')
        .output(
          z.object({
            state: z.enum(['unset', 'open', 'closed']),
            accountCreatedAt: z.string(),
            windowSeconds: z.number().int().nullable(),
            closesAt: z.string().nullable(),
            /** Set when an earlier relationship lapsed: the window runs again from then (RF-4). */
            reopenedAt: z.string().nullable(),
          }),
        )
        .query(async ({ ctx }) => {
          try {
            const age = await requireReferral().accountAge(ctx.principal.userId);
            if (!age) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
            const status = attachWindowStatus(age.reopenedAt ?? age.createdAt, options.referralAttachWindowSeconds, age.now);
            return {
              state: status.state,
              accountCreatedAt: age.createdAt.toISOString(),
              reopenedAt: age.reopenedAt?.toISOString() ?? null,
              windowSeconds: status.state === 'unset' ? null : status.windowSeconds,
              closesAt: status.state === 'unset' ? null : status.closesAt.toISOString(),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Ask for a reviewed change of referrer (J-campaigns-05 #5): the invitation link names the new referrer, the
       * person gives a reason, and a second person decides. Only when a link attach cannot apply (window closed or
       * unset, or a referrer is already set). Asking again for the same link returns the open request.
       */
      requestRebind: scopedProcedure('identity:write')
        .input(z.object({ token: z.string().uuid(), reason: z.string().min(3).max(500) }))
        .output(rebindForCustomer)
        .mutation(async ({ ctx, input }) => {
          try {
            const toReferrerId = await requireShare().referrerOf(input.token);
            if (!toReferrerId) throw new ShareError('This invitation link is revoked or unknown [share.revoked]', 'share.revoked');
            return customerRebind(await requireReferralRebind().request(ctx.principal.userId, toReferrerId, input.reason));
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** This person's latest referrer change request and its state, or null. */
      myRebind: scopedProcedure('identity:read')
        .output(rebindForCustomer.nullable())
        .query(async ({ ctx }) => {
          try {
            const rec = await requireReferralRebind().latestOf(ctx.principal.userId);
            return rec ? customerRebind(rec) : null;
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** The person withdraws their own open request. */
      withdrawRebind: scopedProcedure('identity:write')
        .input(z.object({ requestId: z.string().uuid() }))
        .output(rebindForCustomer)
        .mutation(async ({ ctx, input }) => {
          try {
            return customerRebind(await requireReferralRebind().withdraw(ctx.principal.userId, input.requestId));
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** Requests waiting for a second person (founder-ops queue). Operator session with a second factor. */
      rebindQueue: scopedProcedure('admin:compliance')
        .input(z.object({ limit: z.number().int().min(1).max(100) }))
        .output(z.array(rebindForOperator))
        .query(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            return (await requireReferralRebind().queue(input.limit)).map(operatorRebind);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * A second person approves or rejects, with a reason (J-campaigns-05 #6). The requester can never decide their
       * own (`action_approval.same_person`), and neither the referrer it moves to nor the one it moves from may decide it
       * (`referral.rebind_interested`). Approval applies the new referrer from this time; stored accruals stay.
       */
      decideRebind: scopedProcedure('admin:compliance')
        .input(z.object({ requestId: z.string().uuid(), decision: z.enum(['approve', 'reject']), reason: z.string().min(3).max(500) }))
        .output(rebindForOperator)
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            return operatorRebind(
              await requireReferralRebind().decide(ctx.principal.userId, input.requestId, input.decision, input.reason),
            );
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Where this person's referral relationship stands against the owner's inactivity period (J-campaigns-05 #7): the
       * date it ends without a fee event, and their latest ended relationship. A blank period reads `unset`; no end date
       * is invented.
       */
      myLapse: scopedProcedure('identity:read')
        .output(
          z.object({
            state: z.enum(['unset', 'none', 'active']),
            periodSeconds: z.number().int().nullable(),
            lastActivityAt: z.string().nullable(),
            endsAt: z.string().nullable(),
            ended: lapseOutput.nullable(),
          }),
        )
        .query(async ({ ctx }) => {
          try {
            const lapse = requireReferralLapse();
            const [standing, ended] = await Promise.all([lapse.standingOf(ctx.principal.userId), lapse.latestOf(ctx.principal.userId)]);
            return {
              state: standing.state,
              periodSeconds: standing.state === 'active' ? standing.periodSeconds : null,
              lastActivityAt: standing.state === 'active' ? standing.lastActivityAt.toISOString() : null,
              endsAt: standing.state === 'active' ? standing.endsAt.toISOString() : null,
              ended: ended ? lapseView(ended) : null,
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** The lapse log for founder-ops, newest first. Operator session with a second factor. */
      lapseLog: scopedProcedure('admin:compliance')
        .input(z.object({ limit: z.number().int().min(1).max(100) }))
        .output(z.array(lapseOutput))
        .query(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            return (await requireReferralLapse().log(input.limit)).map(lapseView);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      myAncestors: scopedProcedure('identity:read')
        .output(z.array(z.string().guid()))
        .query(async ({ ctx }) => {
          try {
            return await requireReferral().ancestorsOf(ctx.principal.userId);
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Affiliate self-view of durable commission accruals only.
       * Always scoped to ctx.principal.userId — no beneficiaryId input (foreign refuse by design).
       * Empty list when no rows / rates unpublished (never invents rates or amounts).
       * Limit required — omit never invents 100. Owner/query may pass 100 explicitly.
       * Payout is a separate admin procedure (affiliates.payout) — refuse-closed without owner rates + ledger.
       */
      myAccruals: scopedProcedure('identity:read')
        .input(z.object({ limit: z.number().int().min(1).max(500) }))
        .output(
          z.object({
            rows: z.array(
              z.object({
                feeEventId: z.string(),
                beneficiaryId: z.string().guid(),
                payerId: z.string().guid(),
                hop: z.number().int(),
                rate: z.string(),
                feeAmount: z.string(),
                commissionAmount: z.string(),
                asset: z.string(),
                accruedAt: z.string(),
                sourceModule: z.string(),
              }),
            ),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            const store = requireAccruals();
            // Self-only: never accept a foreign beneficiaryId.
            const rows = await store.listByBeneficiary(ctx.principal.userId, input.limit);
            return {
              rows: rows.map((r) => ({
                feeEventId: r.feeEventId,
                beneficiaryId: r.beneficiaryId,
                payerId: r.payerId,
                hop: r.hop,
                rate: r.rate,
                feeAmount: r.feeAmount,
                commissionAmount: r.commissionAmount,
                asset: r.asset,
                accruedAt: r.accruedAt.toISOString(),
                sourceModule: r.sourceModule,
              })),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Operator freeze beneficiary — skips accrual; no payout path here.
       * `admin:write` is not INTERACTIVE_ONLY, so MFA is local (same reason as
       * `kyc.approve`). Dual-control reuses four-eyes (`confirmOperatorId` mill
       * field → distinct `confirmActorId`) so one operator cannot freeze alone.
       */
      freeze: scopedProcedure('admin:write')
        .input(
          z.object({
            beneficiaryId: z.string().guid(),
            reason: z.string().min(3).max(500),
            /**
             * Distinct confirming operator. Enforced after parse so
             * missing/blank/same refuse `dual_control_missing`, not a schema dump.
             */
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            beneficiaryId: z.string().guid(),
            frozenBy: z.string().guid(),
            reason: z.string(),
            frozenAt: z.string(),
            honestyLine: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            await consumePrivileged(ctx.principal.userId, input, 'affiliates.freeze', {
              beneficiaryId: input.beneficiaryId,
              reason: input.reason,
            });
            const svc = requireFreeze();
            const rec = await svc.freeze({
              beneficiaryId: input.beneficiaryId,
              frozenBy: ctx.principal.userId,
              reason: input.reason,
              confirmActorId: input.confirmOperatorId,
              approvalId: input.approvalId,
              operationId: input.operationId,
            });
            const frozenIds = await svc.frozenIds();
            return {
              beneficiaryId: rec.beneficiaryId,
              frozenBy: rec.frozenBy,
              reason: rec.reason,
              frozenAt: rec.frozenAt.toISOString(),
              honestyLine: affiliateFreezeHonestyLine({
                beneficiaryId: rec.beneficiaryId,
                frozenIds,
                action: 'freeze',
              }),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      unfreeze: scopedProcedure('admin:write')
        .input(
          z.object({
            beneficiaryId: z.string().guid(),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            beneficiaryId: z.string().guid(),
            frozenBy: z.string().guid(),
            reason: z.string(),
            frozenAt: z.string(),
            honestyLine: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            requireMfa(ctx.principal);
            await consumePrivileged(ctx.principal.userId, input, 'affiliates.unfreeze', {
              beneficiaryId: input.beneficiaryId,
            });
            const svc = requireFreeze();
            const rec = await svc.unfreeze(input.beneficiaryId, {
              actorId: ctx.principal.userId,
              confirmActorId: input.confirmOperatorId,
              approvalId: input.approvalId,
              operationId: input.operationId,
            });
            const frozenIds = await svc.frozenIds();
            return {
              beneficiaryId: rec.beneficiaryId,
              frozenBy: rec.frozenBy,
              reason: rec.reason,
              frozenAt: rec.frozenAt.toISOString(),
              honestyLine: affiliateFreezeHonestyLine({
                beneficiaryId: rec.beneficiaryId,
                frozenIds,
                action: 'unfreeze',
              }),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /** Limit required — omit never invents 100. Owner/query may pass 100 explicitly. */
      freezes: scopedProcedure('admin:read')
        .input(z.object({ limit: z.number().int().min(1).max(500) }))
        .output(
          z.array(
            z.object({
              beneficiaryId: z.string().guid(),
              frozenBy: z.string().guid(),
              reason: z.string(),
              frozenAt: z.string(),
            }),
          ),
        )
        .query(async ({ input }) => {
          try {
            const rows = await requireFreeze().list(input.limit);
            return rows.map((r) => ({
              beneficiaryId: r.beneficiaryId,
              frozenBy: r.frozenBy,
              reason: r.reason,
              frozenAt: r.frozenAt.toISOString(),
            }));
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Stage admin read — multi-tier tree board (structure + freeze count) plus
       * D26-P1-O2 rate-authority honesty. Never invents commission % into the board.
       */
      treeStatus: scopedProcedure('admin:read')
        .output(
          z.object({
            edges: z.number().int().nonnegative(),
            referrers: z.number().int().nonnegative(),
            maxDepth: z.number().int().nonnegative(),
            frozenCount: z.number().int().nonnegative(),
            maxDepthCap: z.number().int().positive(),
            statusLine: z.string(),
            /** Owner published IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON (no invent). */
            rateAuthorityPublished: z.boolean(),
            /** Ops board line — published flag + tier count only, never rate values. */
            rateAuthorityStatusLine: z.string(),
          }),
        )
        .query(async () => {
          try {
            const frozen = freeze ? await requireFreeze().frozenIds() : new Set<string>();
            const board = await requireReferral().treeBoard(frozen);
            return {
              ...board,
              statusLine: affiliateTreeStatusLine(board),
              rateAuthorityPublished: accrualTierLawIsPublished(accrualTierLaw),
              rateAuthorityStatusLine: accrualTreeAuthorityStatusLine(accrualTierLaw),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Stage admin read — one node's place in the IB / affiliate tree.
       * Structure + freeze flag only.
       */
      node: scopedProcedure('admin:read')
        .input(z.object({ userId: z.string().guid() }))
        .output(
          z.object({
            userId: z.string().guid(),
            referrerId: z.string().guid().nullable(),
            depth: z.number().int().nonnegative(),
            ancestors: z.array(z.string().guid()),
            directDownline: z.array(z.string().guid()),
            directDownlineCount: z.number().int().nonnegative(),
            frozen: z.boolean(),
            attributedAt: z.string().nullable(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const frozen = freeze ? await requireFreeze().frozenIds() : new Set<string>();
            const node = await requireReferral().nodeStatus(input.userId, frozen);
            return {
              userId: node.userId,
              referrerId: node.referrerId,
              depth: node.depth,
              ancestors: [...node.ancestors],
              directDownline: [...node.directDownline],
              directDownlineCount: node.directDownlineCount,
              frozen: node.frozen,
              attributedAt: node.attributedAt,
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Stage-2 admin read — attributed member roster (+ optional root filter).
       * Structure + freeze overlay only; no rates / payouts.
       * Limit required — omit never invents 100. Owner/query may pass 100 explicitly.
       */
      members: scopedProcedure('admin:read')
        .input(
          z.object({
            rootId: z.string().guid().optional(),
            limit: z.number().int().min(1).max(500),
          }),
        )
        .output(
          z.object({
            members: z.array(
              z.object({
                userId: z.string().guid(),
                referrerId: z.string().guid(),
                depth: z.number().int().nonnegative(),
                frozen: z.boolean(),
                attributedAt: z.string().nullable(),
              }),
            ),
            total: z.number().int().nonnegative(),
            frozenInList: z.number().int().nonnegative(),
            maxDepthInList: z.number().int().nonnegative(),
            rootId: z.string().guid().nullable(),
            statusLine: z.string(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const frozen = freeze ? await requireFreeze().frozenIds() : new Set<string>();
            const rootId = input.rootId ?? null;
            const { members, board } = await requireReferral().listMembers(frozen, rootId, input.limit);
            return {
              members: members.map((m) => ({
                userId: m.userId,
                referrerId: m.referrerId,
                depth: m.depth,
                frozen: m.frozen,
                attributedAt: m.attributedAt,
              })),
              total: board.total,
              frozenInList: board.frozenInList,
              maxDepthInList: board.maxDepthInList,
              rootId: board.rootId,
              statusLine: affiliateMemberListStatusLine(board),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Slice C payout — the mechanism is here and it is REFUSE-CLOSED ON THE RATE.
       *
       * DIRECTION §8 rates stay owner-only, so with an unpublished law this
       * refuses `affiliate.payout.rates_unset` and moves nothing. When the owner
       * publishes tiers, the same path fans the durable accrual rows out across
       * the tree through existing ledger recipes (§0.6 — no value moves outside
       * packages/ledger-client, and no recipe is invented here).
       *
       * `feeEventId` is OPTIONAL IN THE SCHEMA ON PURPOSE: the rate refusal must
       * be the one an operator sees first. Rejecting a missing field before
       * checking the law would answer "your request is malformed" to someone
       * whose real problem is that no rate exists.
       *
       * Posting is a value move. `admin:write` is not INTERACTIVE_ONLY, so MFA
       * is local (same reason as `kyc.approve`). Dual-control reuses four-eyes
       * (`confirmOperatorId` mill field → distinct `confirmActorId`). Dry-run
       * stays single-operator — it posts nothing.
       */
      payout: scopedProcedure('admin:write')
        .input(
          z.object({
            feeEventId: z.string().min(1).max(120).optional(),
            beneficiaryId: z.string().guid().optional(),
            dryRun: z.boolean().optional(),
            /**
             * Distinct confirming operator. Enforced after parse so
             * missing/blank/same refuse `dual_control_missing`, not a schema dump.
             */
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            // Rate law first — before store, ledger, or field validation.
            assertPayoutRateProvenance([], accrualTierLaw);

            const feeEventId = input.feeEventId?.trim() ?? '';
            if (!feeEventId) {
              throw new AffiliatePayoutRefuseError(
                'feeEventId is required — a payout idempotency key must be derived from the business event, never a clock',
                'affiliate.payout.invalid',
                AFFILIATE_PAYOUT_RESIDUAL,
              );
            }

            const rows = await requireAccruals().listByFeeEvent(feeEventId);
            // An unknown frozen set is not an empty one: without the freeze
            // service we cannot tell who is frozen, so neither plan nor pay.
            if (!freeze) {
              throw new AffiliatePayoutRefuseError(
                'Affiliate payout cannot run — no freeze service is wired, so the frozen beneficiary set is unknown',
                'affiliate.payout.freeze_unwired',
                AFFILIATE_PAYOUT_RESIDUAL,
              );
            }
            const frozen = await freeze.frozenIds();

            const plan = planAffiliatePayout({
              feeEventId,
              rows: input.beneficiaryId ? rows.filter((r) => r.beneficiaryId === input.beneficiaryId) : rows,
              law: accrualTierLaw,
              frozenBeneficiaryIds: frozen,
            });

            if (input.dryRun === true) {
              return {
                posted: false as const,
                feeEventId: plan.feeEventId,
                asset: plan.asset,
                totalCommission: plan.totalCommission,
                legCount: plan.legs.length,
                beneficiaryCount: plan.beneficiaryCount,
                idempotencyKeys: plan.legs.flatMap((l) => [l.sweep.idempotencyKey, l.payout.idempotencyKey]),
                statusLine: affiliatePayoutPlanStatusLine(plan),
              };
            }

            // §0.6: without a ledger client this path cannot move value, and it
            // says so rather than pretending a plan is a payment.
            if (!ledger) {
              throw new AffiliatePayoutRefuseError(
                'Affiliate payout cannot post — no ledger client is wired into this deployment',
                'affiliate.payout.ledger_unwired',
                AFFILIATE_PAYOUT_RESIDUAL,
              );
            }

            requireMfa(ctx.principal);
            const { approverId: confirmOperatorId } = await consumePrivileged(ctx.principal.userId, input, 'affiliates.payout', {
              feeEventId,
            });

            const receipt = await postAffiliatePayout(ledger, plan);
            return {
              posted: true as const,
              feeEventId: receipt.feeEventId,
              asset: receipt.asset,
              totalCommission: receipt.totalCommission,
              legCount: receipt.legCount,
              beneficiaryCount: receipt.beneficiaryCount,
              idempotencyKeys: receipt.idempotencyKeys,
              statusLine: affiliatePayoutPlanStatusLine(plan),
              confirmOperatorId,
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Slice B dry-run: fee event → commission rows under rate authority (D26-P1-O2).
       * NEVER posts ledger. Zero fee → empty rows. Real payout is affiliates.payout.
       * Simulation tiers allowed here only; durable accrue refuses invent.
       */
      accrueDryRun: scopedProcedure('admin:read')
        .input(
          z.object({
            feeEventId: z.string().min(1).max(120),
            userId: z.string().guid(),
            feeAmount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/),
            asset: z.string().min(1).max(32),
            /** Module fee pool that holds this fee (trade / pay / …). Default identity for legacy. */
            sourceModule: z
              .string()
              .regex(/^[a-z][a-z0-9_-]{0,31}$/)
              .optional(),
            at: z.string().datetime().optional(),
            /** Dry-run simulation only — never written to durable store. */
            tiers: z
              .array(
                z.object({
                  hop: z.number().int().min(0).max(20),
                  rate: z.string().regex(/^(0(\.\d{1,18})?|1(\.0{1,18})?)$/),
                }),
              )
              .max(20)
              .optional(),
          }),
        )
        .output(
          z.object({
            rows: z.array(
              z.object({
                feeEventId: z.string(),
                beneficiaryId: z.string().guid(),
                payerId: z.string().guid(),
                hop: z.number().int(),
                rate: z.string(),
                feeAmount: z.string(),
                commissionAmount: z.string(),
                asset: z.string(),
                accruedAt: z.string(),
                sourceModule: z.string(),
              }),
            ),
            frozenSkipped: z.number().int(),
          }),
        )
        .query(async ({ input }) => {
          try {
            const parent = await requireReferral().loadParentMap();
            const frozen = await requireFreeze().frozenIds();
            const fee = {
              feeEventId: input.feeEventId,
              userId: input.userId,
              feeAmount: input.feeAmount,
              asset: input.asset,
              sourceModule: input.sourceModule,
              at: input.at ? new Date(input.at) : new Date(),
            };
            const out = accrueTreeUnderRateAuthority({
              fee,
              parent,
              law: accrualTierLaw,
              frozenBeneficiaryIds: frozen,
              simulationTiers: input.tiers,
              mode: 'dryRun',
            });
            return {
              frozenSkipped: out.frozenSkipped,
              rows: out.rows.map((r) => ({
                feeEventId: r.feeEventId,
                beneficiaryId: r.beneficiaryId,
                payerId: r.payerId,
                hop: r.hop,
                rate: r.rate,
                feeAmount: r.feeAmount,
                commissionAmount: r.commissionAmount,
                asset: r.asset,
                accruedAt: r.accruedAt.toISOString(),
                sourceModule: r.sourceModule,
              })),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * Slice B persist: accrual tree under owner rate authority (D26-P1-O2).
       * NEVER posts ledger. Idempotent on (feeEventId, beneficiary, hop).
       * Zero fee → zero rows. Payout via ledger recipes only (Slice C).
       * Rates: owner-published IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON only —
       * per-call tiers refused (`affiliate.accrual.invent_refused`).
       */
      accrue: scopedProcedure('admin:write')
        .input(
          z.object({
            feeEventId: z.string().min(1).max(120),
            userId: z.string().guid(),
            feeAmount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/),
            asset: z.string().min(1).max(32),
            /** Module fee pool that holds this fee (trade / pay / …). Default identity for legacy. */
            sourceModule: z
              .string()
              .regex(/^[a-z][a-z0-9_-]{0,31}$/)
              .optional(),
            at: z.string().datetime().optional(),
            /**
             * Forbidden on durable accrue — present only so a caller that still
             * sends invent tiers gets invent_refused rather than silent ignore.
             */
            tiers: z
              .array(
                z.object({
                  hop: z.number().int().min(0).max(20),
                  rate: z.string().regex(/^(0(\.\d{1,18})?|1(\.0{1,18})?)$/),
                }),
              )
              .max(20)
              .optional(),
          }),
        )
        .output(
          z.object({
            inserted: z.number().int(),
            rows: z.array(
              z.object({
                feeEventId: z.string(),
                beneficiaryId: z.string().guid(),
                payerId: z.string().guid(),
                hop: z.number().int(),
                rate: z.string(),
                feeAmount: z.string(),
                commissionAmount: z.string(),
                asset: z.string(),
                accruedAt: z.string(),
                sourceModule: z.string(),
              }),
            ),
            frozenSkipped: z.number().int(),
          }),
        )
        .mutation(async ({ input }) => {
          try {
            const parent = await requireReferral().loadParentMap();
            const frozen = await requireFreeze().frozenIds();
            const store = requireAccruals();
            const fee = {
              feeEventId: input.feeEventId,
              userId: input.userId,
              feeAmount: input.feeAmount,
              asset: input.asset,
              sourceModule: input.sourceModule,
              at: input.at ? new Date(input.at) : new Date(),
            };
            const out = accrueTreeUnderRateAuthority({
              fee,
              parent,
              law: accrualTierLaw,
              frozenBeneficiaryIds: frozen,
              simulationTiers: input.tiers,
              mode: 'durable',
            });
            const inserted = await store.saveRows(out.rows);
            const stored = await store.listByFeeEvent(input.feeEventId);
            return {
              inserted,
              frozenSkipped: out.frozenSkipped,
              rows: stored.map((r) => ({
                feeEventId: r.feeEventId,
                beneficiaryId: r.beneficiaryId,
                payerId: r.payerId,
                hop: r.hop,
                rate: r.rate,
                feeAmount: r.feeAmount,
                commissionAmount: r.commissionAmount,
                asset: r.asset,
                accruedAt: r.accruedAt.toISOString(),
                sourceModule: r.sourceModule,
              })),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),

    /**
     * Drop 0 tease — email waitlist + referral queue.
     * Not the affiliate tree (`affiliates.*`). No rewards, no ledger.
     */
    waitlist: router({
      enroll: publicProcedure
        .input(
          z.object({
            email: z.string().email().max(320),
            referralCode: z
              .string()
              .regex(/^[a-fA-F0-9]{12}$/)
              .optional(),
          }),
        )
        .output(
          z.object({
            id: z.string().guid(),
            email: z.string(),
            position: z.number().int().positive(),
            referralCode: z.string(),
            referredBy: z.string().nullable(),
            referredCount: z.number().int().min(0),
            created: z.boolean(),
          }),
        )
        .mutation(async ({ input }) => {
          try {
            const out = await requireWaitlist().enroll(input);
            return {
              id: out.entry.id,
              email: out.entry.email,
              position: out.entry.position,
              referralCode: out.entry.referralCode,
              referredBy: out.entry.referredBy,
              referredCount: out.entry.referredCount,
              created: out.created,
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      position: publicProcedure
        .input(z.object({ referralCode: z.string().regex(/^[a-fA-F0-9]{12}$/) }))
        .output(waitlistPlaceOutput)
        .query(async ({ input }) => {
          try {
            return waitlistPlaceView(await requireWaitlist().position(input.referralCode));
          } catch (err) {
            throw toTrpcError(err);
          }
        }),

      /**
       * The signed-in caller's own place (RC-campaigns-05's drop room, J-campaigns-20 #4): the entry whose email is this
       * account's confirmed email, or null when it never joined. An unconfirmed email refuses `waitlist.email_unverified`.
       */
      mine: protectedProcedure.output(waitlistPlaceOutput.nullable()).query(async ({ ctx }) => {
        try {
          const out = await requireWaitlist().mine(() => auth.selfEmail(ctx.principal.userId));
          return out ? waitlistPlaceView(out) : null;
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

      /**
       * Referral-ranked waves (RC-campaigns-03, J-campaigns-20 #3). `list` shows the owner's wave size (null while blank),
       * the next wave number and every released wave. `release` needs a second person: an action approval for target
       * `waitlist.wave.release` whose payload binds { wave, size } as strings, in that order. It releases the top N
       * waiting entries once; the same wave again returns the stored wave and spends no approval.
       */
      waves: router({
        list: scopedProcedure('admin:read')
          .output(
            z.object({
              waveSize: z.number().int().positive().nullable(),
              nextWave: z.number().int().positive(),
              waiting: z.number().int().min(0),
              waves: z.array(waveOutput),
            }),
          )
          .query(async () => {
            try {
              const out = await requireWaitlist().waves();
              return { ...out, waves: out.waves.map(waveView) };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),

        release: scopedProcedure('admin:write')
          .input(
            z.object({
              waveNumber: z.number().int().positive(),
              approvalId: z.string().max(128).nullish(),
              operationId: z.string().max(128).nullish(),
            }),
          )
          .output(z.object({ wave: waveOutput, created: z.boolean() }))
          .mutation(async ({ ctx, input }) => {
            try {
              requireMfa(ctx.principal);
              const out = await requireWaitlist().release(
                { waveNumber: input.waveNumber, releasedBy: ctx.principal.userId },
                async (size) => {
                  const { approverId } = await consumePrivileged(ctx.principal.userId, input, 'waitlist.wave.release', {
                    wave: String(input.waveNumber),
                    size: String(size),
                  });
                  return { approverId };
                },
              );
              return { wave: waveView(out.wave), created: out.created };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),

      list: scopedProcedure('admin:read')
        .input(
          z.object({
            limit: z.number().int().min(1).max(200),
            offset: z.number().int().min(0).default(0),
          }),
        )
        .output(
          z.object({
            total: z.number().int().min(0),
            entries: z.array(
              z.object({
                id: z.string().guid(),
                email: z.string(),
                position: z.number().int().positive(),
                referralCode: z.string(),
                referredBy: z.string().nullable(),
                referredCount: z.number().int().min(0),
                createdAt: z.string(),
              }),
            ),
          }),
        )
        .query(async ({ input }) => {
          try {
            const out = await requireWaitlist().list(input);
            return {
              total: out.total,
              entries: out.entries.map((e) => ({
                id: e.id,
                email: e.email,
                position: e.position,
                referralCode: e.referralCode,
                referredBy: e.referredBy,
                referredCount: e.referredCount,
                createdAt: e.createdAt.toISOString(),
              })),
            };
          } catch (err) {
            throw toTrpcError(err);
          }
        }),
    }),
  });
}

export type IdentityRouter = ReturnType<typeof createIdentityRouter>;
