import Fastify, { type FastifyRequest } from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { z } from 'zod';
import { edgeTrustFromEnv, isExplicitDevOrTest } from '@intafaced/config';
import { encodePrincipal, mergeRouters, procedureCallers, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import type { Env } from './env.js';
import { parseKycRequirementsByLevel, parseKycReviewHoursByLevel } from './kyc/levels.js';
import { parseKycRejectReasons } from './kyc/cases.js';
import { parseKycCapabilitiesByLevel } from './kyc/capabilities.js';
import { registerApiKeyOwnershipRoute } from './auth/api-key-ownership-route.js';
import { registerServiceMailRoute } from './auth/service-mail.js';
import { registerRotationRequestRoutes } from './auth/key-rotation-requests.js';
import { registerWalletSignatureVerifyRoute, signingAccount, verifyWalletSignature } from './auth/wallet-signature-verify.js';
import { linkedWallets, registerLinkedWalletsRoute } from './auth/linked-wallets.js';
import { deskLayoutsFor, registerSupportDeskLayoutsRoute } from './preferences/desk-layouts-support-read.js';
import { readAgentKey, readAgentKeyCalls, registerAgentKeyCallsRoute, registerAgentKeyReadRoute } from './auth/agent-key-read.js';
import { registerTrustedDeviceReadRoute } from './auth/trusted-device-read.js';
import { founderEnrolmentConfig } from './auth/founder-enrolment.js';
import { parseTotpSecretKey } from './auth/totp-crypto.js';
import { ReferralRebindService } from './affiliates/referral-rebind.js';
import { parseProgrammeDepth } from './affiliates/programme-depth.js';
import { parseAttachWindowSeconds } from './affiliates/attach-window.js';
import { parseAccrualTierLawJson } from './affiliates/commission-rate-law.js';
import { parseDmaHierarchyLawJson } from './orgs/dma-hierarchy.js';
import { createIdentityRouter } from './router.js';
import { PgHandleLookupLimiter } from './handle-lookup.js';
import { createTradeIdentityAuthRouter } from './auth/trade-identity-auth-router.js';
import { assertStaffSessionLive, createSqlTradeIdentityStore } from './auth/trade-identity-auth.js';
import { createApiKeyIpRouter } from './api-key-ip-router.js';
import { createApiKeyOriginRouter } from './api-key-origin-router.js';
import { createApiKeyAccountRouter } from './api-key-account-router.js';
import { createApiKeyRotateRouter } from './api-key-rotate-router.js';
import { createApiKeyExpireRouter } from './api-key-expire-router.js';
import { createApiKeyRevokeAllRouter } from './api-key-revoke-all-router.js';
import { createSessionFamiliesRouter } from './session-families-router.js';
import { createSessionSettingsRouter, parseSessionLimits } from './auth/session-limits.js';
import { createGrantsRouter } from './grants-router.js';
import { createSessionRevokeAllRouter } from './session-revoke-all-router.js';
import { createSessionRevokeRouter } from './session-revoke-router.js';
import { createListSessionsRouter } from './list-sessions-router.js';
import { createPanicRevokeRouter } from './panic-revoke-router.js';
import { createApiKeyProductRouter } from './api-key-product-router.js';
import { createApiKeyAttributionRouter } from './api-key-attribution-router.js';
import { createDisableUserRouter } from './disable-user-router.js';
import { parseFounderPair } from './controls/founder-controls.js';
import { createFounderControlsRouter } from './controls/founder-controls-router.js';
import { createOperatorOpsRouter } from './ops/ops-router.js';
import { createLearnerCardRouter } from './ops/learner-card.js';
import { createPreferencesRouter } from './preferences/preferences-router.js';
import { createMembershipRouter } from './membership/membership-router.js';
import { OAuthService } from './oauth/oauth.js';
import { createOAuthRouter } from './oauth/oauth-router.js';
import { createIdentityRequestContext } from './controls/founder-context.js';
import { AuthKeyRing, parseAuthKeys } from './auth/auth-key-ring.js';
import { createAuthKeysRouter } from './auth-keys-router.js';
import { OperationIdentityDecisions } from './controls/operation-identity-decisions.js';
import { createOperationIdentityRouter } from './controls/operation-identity-router.js';
import { createLimitFeeTierRouter } from './limit-fee-tier-router.js';
import { SavedRecipientService } from './saved-recipients.js';
import { createSavedRecipientsRouter } from './saved-recipients.router.js';
import { createHandleRouter } from './profile/handle-router.js';
import { createReceiveContactsRouter } from './account/receive-contacts-router.js';
import { ReceiveContactService, receiveContactSettings } from './account/receive-contacts.js';
import { createPayQrRouter } from './profile/pay-qr-router.js';
import { PayQrService, payQrKeyFromEnv } from './profile/pay-qr.js';
import { HandleSettingsService } from './profile/handle-settings.js';
import { createOrgRouter } from './org-router.js';
import { createEnrollPasskeyRouter } from './enroll-passkey-router.js';
import { createVerifyPasskeyRouter } from './verify-passkey-router.js';
import { createPasskeyManageRouter } from './passkey-manage-router.js';
import { createFactorStatusRouter } from './factor-status-router.js';
import { createSigninMethodsRouter } from './signin-methods-router.js';
import { createWorkItemsRouter } from './work-items.js';
import { createServerTimeRouter } from './server-time-router.js';
import { createTotpLifecycleRouter } from './totp-lifecycle-router.js';
import { createSelfFreezeLiftRouter } from './self-freeze-lift-router.js';
import { createSecurityLockRouter } from './security-lock-router.js';
import { createAccountStatusRouter } from './account/account-status-router.js';
import { AccountStatusDesk } from './account/account-status.js';
import { createMfaResetRouter } from './mfa-reset-router.js';
import { createSupportRecoveryRouter } from './support-recovery-router.js';
import { createFreezeLinkRouter } from './freeze-link-router.js';
import { createAppealsRouter } from './account/appeals-router.js';
import { createRecoveryKeysRouter } from './recovery-keys-router.js';
import { createDeathNoticesRouter } from './death-notices-router.js';
import { listRecoveryEstates, verifyRecoveryClaim } from './auth/death-notices.js';
import { registerRecoveryClaimVerifyRoute } from './auth/recovery-claim-verify.js';
import { RecoveryKeys } from './auth/recovery-keys.js';
import { createTrustedDevicesRouter } from './trusted-devices-router.js';
import {
  freezeWithdrawalsForSupport,
  registerSupportWithdrawalFreezeRoute,
  supportWithdrawalFreezeRecords,
} from './auth/support-withdrawal-freeze.js';
import { TotpLifecycle } from './auth/totp-lifecycle.js';
import { SqlPendingTotpEnrolmentStore } from './auth/pending-totp-store.js';
import { createUnenrollPasskeyRouter } from './unenroll-passkey-router.js';
import { requestMetaAls } from './auth/request-meta.js';
import { requestIpAls } from './auth/auth-service-ip.js';
import { requestProductAls } from './auth/auth-service-product.js';
import { installRefreshCookieHooks } from './auth/refresh-cookie.js';
import { parseRequestSignWindow } from './auth/api-key-request-sign.js';
import { createRequestSigningPolicyRouter } from './request-signing-policy-router.js';
import { createApiKeyRequestSignRouter } from './api-key-request-sign-router.js';
import { createDeveloperKeysRouter } from './developer-keys-router.js';
import { httpLeadCheck } from './auth/lead-key-check.js';
import { parseApiKeyCapByTier, parsePortfolioKeyCap, parseApiKeyIdleExpirySeconds, passkeyMintRule } from './auth/developer-keys.js';
import { parseDeveloperRoles } from './auth/developer-team.js';
import { parseRatePolicy } from './auth/api-rate-limits.js';
import { createApiRateLimitsRouter } from './api-rate-limits-router.js';
import { parseRotateOverlapMaxSeconds } from './auth/developer-key-rotate.js';
import { createDeveloperSandboxesRouter } from './developer-sandboxes-router.js';
import { parseSandboxBaseUrl, parseSandboxCapByTier } from './auth/developer-sandboxes.js';
import { StaffDirectory } from './staff/staff-directory.js';
import { createStaffRouter } from './staff/staff-router.js';
import { createActionApprovalRouter } from './action-approval-router.js';
import { createStepUpRouter } from './step-up-router.js';
import { registerClosureFinalize, registerGraceClosureFinalize } from './closure/closure-job.js';
import { createClosureOpsRouter } from './closure/closure-ops-router.js';
import { registerAffiliateProducerAccrue } from './affiliates/producer-accrue.js';
import { registerBusinessDirectoryRoutes, sqlBusinessDirectory } from './business-directory.js';
import { registerHolderNameCheck } from './holder-name-check.js';
import { registerAffiliateProducerPayout } from './affiliates/producer-payout.js';
import { createNavigatorSessionStore } from './agents/navigator-session-store.js';
import { registerNavigatorSessionRoutes } from './agents/navigator-session-routes.js';

/**
 * The wire replay for svc-identity: every identity call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden.json` and `wire-replay.golden/` hold what svc-identity answered (main 2026-11-19, as it is, bugs
 * included) to a matrix of requests: every procedure of the merged router `index.ts` mounts and every REST route it
 * mounts through an exported register function, six inputs, four callers and each signed service, sent through the
 * production Fastify adapter with `index.ts`'s context, hooks and order. A later move of these calls must answer each one
 * byte for byte the same; a wrong scope, a changed refusal code, a widened input or a reshaped envelope shows here.
 *
 * No database, bus, ledger or partner: every dependency `index.ts` builds before it composes the router is a recording
 * stub that refuses any call with its own name (`replay stub: <name>`), and every service `index.ts` builds inside the
 * composition is the real class over that stub. Settings are parsed by the real parsers from a blank environment (only
 * the secrets the schema requires are set), so every owner value is the blank one. So the recording pins the boundary
 * (who may call, what input is accepted, how each refusal is shaped) and which dependency each accepted call reaches first.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

/** The recording's index: who may call each procedure, and the shard files below it. */
const INDEX = new URL('./wire-replay.golden.json', import.meta.url);
/**
 * Error replies no longer carry tRPC's stack. Recordings made before that hold `"stack":"<stack>"` in their error bodies;
 * it is dropped on reading, while the live side still turns any stack into `<stack>`, so a stack that comes back fails.
 */
const RECORDED_STACK = '\\"stack\\":\\"<stack>\\",';
const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded shard in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const SECRET = 'an-identity-wire-replay-edge-secret-long-enough';
const INTERNAL = 'an-identity-wire-replay-internal-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
/**
 * Blank owner settings: nothing set but what the schema refuses to start without, as on a test stack nobody
 * configured. `index.ts` reads APP_ENV raw too, so it is `test` here, the stack the journeys run on.
 */
const ENV_SOURCE: NodeJS.ProcessEnv = {
  APP_ENV: 'test',
  SERVICE_NAME: 'svc-identity',
  DATABASE_URL: 'postgres://replay:replay@localhost:5432/replay',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: INTERNAL,
  JWT_ACCESS_SECRET: 'an-identity-wire-replay-access-secret-long-enough',
  JWT_REFRESH_SECRET: 'an-identity-wire-replay-refresh-secret-long-enough',
};

/** `env.ts` parses `process.env` when it is imported: it is imported once, over the blank source alone. */
async function loadBlankEnv(): Promise<Env> {
  const saved = process.env;
  process.env = { ...ENV_SOURCE };
  try {
    return (await import('./env.js')).env;
  } finally {
    process.env = saved;
  }
}
const env = await loadBlankEnv();
const APP_ENV = ENV_SOURCE.APP_ENV;

/** A dependency nobody wired: any property is another stub, any call refuses with the path it was reached by. */
function stub(name: string): never {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return stub(`${name}.${prop}`);
    },
    apply() {
      throw new Error(`replay stub: ${name}`);
    },
    construct() {
      throw new Error(`replay stub: new ${name}`);
    },
  }) as never;
}

/** A stub that answers the named members itself: what the composition reads from it while it is being built. */
function stubWith(name: string, own: Record<string, unknown>): never {
  const inner = stub(name) as object;
  return new Proxy(inner, { get: (t, prop) => (typeof prop === 'string' && prop in own ? own[prop] : Reflect.get(t, prop)) }) as never;
}

/** The log `index.ts` hands Fastify's logger to: the replay's app logs nothing. */
const silentLog = { warn() {} };

export function createReplayIdentityRouter() {
  const sql = stub('sql');
  // The composition reads the wallet origins and nothing else from `auth` while it is built: the real rule, over blank settings.
  const auth = stubWith('auth', {
    walletConfig: () => ({
      origins: [
        env.WEBAUTHN_ORIGIN.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ].flat(),
    }),
  });
  const rank = stub('rank');
  const actionApprovals = stub('actionApprovals');
  // Its keys are read when a token is cut, after the composition: the real ring over blank keys, never refreshed.
  const authKeyRing = new AuthKeyRing(sql, env.JWT_ACCESS_SECRET, parseAuthKeys(env.IDENTITY_AUTH_KEYS), {
    consume: (service, input) => (actionApprovals as { consume: (s: unknown, i: unknown) => never }).consume(service, input),
  });
  const founderControls = stub('founderControls');
  const signingEncKey = parseTotpSecretKey(env.API_KEY_SIGNING_ENC_KEY);
  const requestSignWindowSeconds = parseRequestSignWindow(env.IDENTITY_REQUEST_SIGN_WINDOW_SECONDS);
  const sessionLimits = parseSessionLimits(env, { accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS });
  const founderPair = parseFounderPair(env.IDENTITY_FOUNDER_NITRO_USER_ID, env.IDENTITY_FOUNDER_PHANTOM_USER_ID);
  const tradingRestrictionReasons = parseKycRejectReasons(env.IDENTITY_TRADING_RESTRICTION_REASONS, 'IDENTITY_TRADING_RESTRICTION_REASONS');
  const referralAttachWindowSeconds = parseAttachWindowSeconds(env.IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS);
  const programmeDepth = parseProgrammeDepth(env.IDENTITY_PARTNER_PROGRAMME_DEPTH);
  const accrualTierLaw = parseAccrualTierLawJson(env.IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON);
  const dmaHierarchyLaw = parseDmaHierarchyLawJson(env.IDENTITY_DMA_HIERARCHY_LAW_JSON);
  const ratePolicy = parseRatePolicy(env.IDENTITY_API_RATE_LIMITS);
  const kycCapabilityMap = parseKycCapabilitiesByLevel(env.IDENTITY_KYC_CAPABILITIES_BY_LEVEL);
  const kycCapabilityReasons = parseKycRejectReasons(env.IDENTITY_KYC_CAPABILITY_REASONS, 'IDENTITY_KYC_CAPABILITY_REASONS');
  const securityStepUp = stub('securityStepUp');
  const mail = stub('mail');
  const closureSecret = env.INTERNAL_SERVICE_SECRET;
  return mergeRouters(
    createIdentityRouter(auth, rank, {
      registrationOpen: env.REGISTRATION_OPEN,
      extraControlsMin: env.IDENTITY_EXTRA_CONTROLS_MIN,
      handleLookupLimiter: new PgHandleLookupLimiter(sql),
      directRegister: isExplicitDevOrTest(APP_ENV),
      signInChallenge: stub('signInChallenge'),
      founderEnrolment: { invites: founderEnrolmentConfig(env.IDENTITY_FOUNDER_INVITE_HASHES, env.IDENTITY_FOUNDER_INVITE_EXPIRES_AT) },
      webauthnEnabled: env.WEBAUTHN_ENABLED,
      kycLadder: {
        requirements: parseKycRequirementsByLevel(env.IDENTITY_KYC_REQUIREMENTS_BY_LEVEL),
        reviewHours: parseKycReviewHoursByLevel(env.IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL),
      },
      kycRejectReasons: parseKycRejectReasons(env.IDENTITY_KYC_REJECT_REASONS),
      kycCapabilityReasons,
      kycProfile: stub('kycProfile'),
      tradingChecks: stub('tradingChecks'),
      kycPoa: stub('kycPoa'),
      kycSelfie: stub('kycSelfie'),
      social: stub('social'),
      referral: stub('referral'),
      share: stub('share'),
      referralCodes: stub('referralCodes'),
      referralAttachWindowSeconds,
      referralRebind: new ReferralRebindService(sql, actionApprovals, { attachWindowSeconds: referralAttachWindowSeconds }),
      partnerApplications: stub('partnerApplications'),
      programmeDepth,
      referralLapse: stub('referralLapse'),
      freeze: stub('freeze'),
      accruals: stub('accruals'),
      accrualTierLaw,
      // `index.ts` builds the ledger client only with LEDGER_URL; blank, it is undefined.
      ledger: undefined,
      waitlist: stub('waitlist'),
      actionApprovals,
      founderControls,
      privilegedUserIds: founderPair ?? [],
      assertStaffSessionLive: (sessionId, userId) => assertStaffSessionLive(createSqlTradeIdentityStore(sql), sessionId, userId),
      profile: stub('profile'),
      account: stub('account'),
      closure: stub('closure'),
      subAccountDelete: stub('subAccountDelete'),
      subAccountFeatures: stub('subAccountFeatures'),
      subAccountEdit: stub('subAccountEdit'),
      antiPhishing: stub('antiPhishing'),
    }),
    createClosureOpsRouter(sql),
    createApiKeyIpRouter(sql, auth, auth),
    createApiKeyRequestSignRouter(sql, auth, signingEncKey, env.API_KEY_SIGNING_OPTIONAL.trim() === 'true'),
    createRequestSigningPolicyRouter(requestSignWindowSeconds),
    createApiKeyOriginRouter(sql, auth, auth),
    createApiKeyAccountRouter(sql, auth, auth, parsePortfolioKeyCap(env.IDENTITY_PORTFOLIO_KEYS_MAX)),
    createApiKeyRotateRouter(sql, auth, auth, signingEncKey),
    createApiKeyExpireRouter(sql, auth),
    createApiKeyRevokeAllRouter(sql),
    createDeveloperKeysRouter({
      sql,
      gate: auth,
      kycTier: (userId, executor) => (auth as { kycTier: (u: unknown, e: unknown) => never }).kycTier(userId, executor),
      capByTier: parseApiKeyCapByTier(env.IDENTITY_API_KEYS_MAX_BY_TIER),
      ratePolicy,
      portfolioKeyCap: parsePortfolioKeyCap(env.IDENTITY_PORTFOLIO_KEYS_MAX),
      developerRoles: parseDeveloperRoles(env.IDENTITY_DEVELOPER_ROLES),
      idleExpirySeconds: parseApiKeyIdleExpirySeconds(env.IDENTITY_API_KEY_IDLE_EXPIRY_SECONDS),
      rotateOverlapMaxSeconds: parseRotateOverlapMaxSeconds(env.IDENTITY_API_KEY_ROTATE_OVERLAP_MAX_SECONDS),
      mayMint: passkeyMintRule(sql),
      signingEncKey,
      signingWindowSeconds: requestSignWindowSeconds,
      leadCheck: httpLeadCheck({ url: env.IDENTITY_CLOSURE_TRADE_URL, secret: closureSecret }),
    }),
    createApiRateLimitsRouter(sql, ratePolicy),
    createDeveloperSandboxesRouter({
      sql,
      gate: auth,
      kycTier: (userId, executor) => (auth as { kycTier: (u: unknown, e: unknown) => never }).kycTier(userId, executor),
      capByTier: parseApiKeyCapByTier(env.IDENTITY_API_KEYS_MAX_BY_TIER),
      ratePolicy,
      mayMint: passkeyMintRule(sql),
      sandboxCapByTier: parseSandboxCapByTier(env.IDENTITY_SANDBOXES_MAX_BY_TIER),
      baseUrl: parseSandboxBaseUrl(env.IDENTITY_SANDBOX_BASE_URL),
    }),
    createGrantsRouter(sql),
    createSessionRevokeAllRouter(sql),
    createSessionRevokeRouter(sql),
    createSessionFamiliesRouter(sql),
    createSessionSettingsRouter(sql, sessionLimits, {
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
    }),
    createListSessionsRouter(sql),
    createPanicRevokeRouter(sql),
    createApiKeyProductRouter(sql, auth, auth),
    createApiKeyAttributionRouter(auth),
    createDisableUserRouter(founderControls),
    createFounderControlsRouter(founderControls, stub('customerDetails'), stub('accountLimits')),
    createOperatorOpsRouter(sql),
    createLearnerCardRouter(sql),
    createPreferencesRouter(sql, {
      displayCurrencies: env.IDENTITY_DISPLAY_CURRENCIES,
      watchlists: {
        listCap: env.IDENTITY_WATCHLIST_LIST_CAP ?? null,
        symbolCap: env.IDENTITY_WATCHLIST_SYMBOL_CAP ?? null,
        savedScreenCap: env.IDENTITY_SAVED_SCREEN_CAP ?? null,
      },
      deskLayouts: {
        layoutCap: env.IDENTITY_DESK_LAYOUT_CAP ?? null,
        restoreCap: env.IDENTITY_DESK_LAYOUT_RESTORE_CAP ?? null,
        restoreDays: env.IDENTITY_DESK_LAYOUT_RESTORE_DAYS ?? null,
      },
    }),
    createMembershipRouter(env.IDENTITY_MEMBERSHIP_TIERS),
    createOAuthRouter(
      new OAuthService(sql, { codeTtlSeconds: env.OAUTH_CODE_TTL_SECONDS, accessTokenTtlSeconds: env.OAUTH_ACCESS_TOKEN_TTL_SECONDS }),
    ),
    createOperationIdentityRouter(new OperationIdentityDecisions(sql)),
    createAuthKeysRouter(authKeyRing, {
      isFounder: (userId) => (founderControls as { isLiveFounder: (u: string) => never }).isLiveFounder(userId),
    }),
    createStaffRouter({
      rows: stub('consolePolicyRows'),
      approvals: actionApprovals,
      founders: { isFounder: (userId) => (founderControls as { isLiveFounder: (u: string) => never }).isLiveFounder(userId) },
      directory: new StaffDirectory({
        sql,
        approvals: actionApprovals,
        mail,
        inviteTtlSeconds: env.IDENTITY_STAFF_INVITE_TTL_SECONDS,
        registerAccount: (input, claim) =>
          (auth as { registerInvitedStaff: (i: unknown, c: unknown) => never }).registerInvitedStaff(input, claim),
      }),
    }),
    createLimitFeeTierRouter(sql, rank, actionApprovals),
    createSavedRecipientsRouter(new SavedRecipientService(sql)),
    createHandleRouter(new HandleSettingsService(sql, env.IDENTITY_HANDLE_CHANGE_MAX ?? null)),
    createReceiveContactsRouter(
      new ReceiveContactService({
        sql,
        mail,
        text: undefined,
        settings: receiveContactSettings({
          max: env.IDENTITY_RECEIVE_CONTACT_MAX,
          codeTtlSeconds: env.IDENTITY_RECEIVE_CONTACT_CODE_TTL_SECONDS,
          codeMaxAttempts: env.IDENTITY_RECEIVE_CONTACT_CODE_MAX_ATTEMPTS,
        }),
        log: silentLog,
      }),
    ),
    createPayQrRouter(new PayQrService(sql, payQrKeyFromEnv(env.IDENTITY_PAY_QR_KEY, APP_ENV))),
    createOrgRouter(sql, dmaHierarchyLaw),
    createEnrollPasskeyRouter(
      sql,
      { rpId: env.WEBAUTHN_RP_ID, rpName: env.WEBAUTHN_RP_NAME, origin: env.WEBAUTHN_ORIGIN },
      founderPair ?? [],
      { maxPerAccount: env.PASSKEY_MAX_PER_ACCOUNT },
    ),
    createVerifyPasskeyRouter(sql, { rpId: env.WEBAUTHN_RP_ID, rpName: env.WEBAUTHN_RP_NAME, origin: env.WEBAUTHN_ORIGIN }),
    createUnenrollPasskeyRouter(sql),
    createTotpLifecycleRouter(
      new TotpLifecycle({ sql, key: parseTotpSecretKey(env.IDENTITY_TOTP_SECRET_KEY), pending: new SqlPendingTotpEnrolmentStore(sql) }),
      securityStepUp,
    ),
    createPasskeyManageRouter(sql, securityStepUp, { maxPerAccount: env.PASSKEY_MAX_PER_ACCOUNT }),
    createFactorStatusRouter(sql),
    createSigninMethodsRouter(sql, securityStepUp, {
      wallet: (auth as { walletConfig: () => never }).walletConfig(),
      social: stub('social'),
      phone: { sms: stub('sms') },
    }),
    createWorkItemsRouter(sql),
    createServerTimeRouter(),
    createSelfFreezeLiftRouter(stub('selfFreezeLift'), securityStepUp),
    createSecurityLockRouter(stub('securityLock'), securityStepUp),
    createAccountStatusRouter(
      new AccountStatusDesk(
        sql,
        env.IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS,
        kycCapabilityReasons,
        kycCapabilityMap,
        tradingRestrictionReasons,
      ),
    ),
    createMfaResetRouter(auth),
    createSupportRecoveryRouter(() => (auth as { supportRecoveryDeps: () => never }).supportRecoveryDeps()),
    createFreezeLinkRouter(auth),
    createAppealsRouter(stub('appeals'), auth),
    createTrustedDevicesRouter(auth, securityStepUp),
    createRecoveryKeysRouter(new RecoveryKeys(sql, securityStepUp, founderPair ?? [])),
    createDeathNoticesRouter(() => ({ sql, now: () => new Date() })),
    createActionApprovalRouter(actionApprovals, {
      privilegedUserIds: founderPair ?? [],
      verifyFactor: async (input) => {
        await (auth as { stepUp: (i: unknown) => Promise<never> }).stepUp(input);
      },
    }),
    createStepUpRouter(stub('customerStepUp')),
    createTradeIdentityAuthRouter(sql, {
      tokens: authKeyRing.tokenConfig({
        secret: env.JWT_ACCESS_SECRET,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
      }),
    }),
  );
}

/** The request context exactly as `index.ts` builds it, over blank settings. */
const identityRequestContext = createIdentityRequestContext({
  privateAuthoritySecret: env.IDENTITY_WS_AUTHORITY_SECRET,
  edgeAuthoritySecret: env.IDENTITY_EDGE_AUTHORITY_SECRET,
  operationAdmissionSecrets: {
    'svc-trade': env.IDENTITY_TRADE_ADMISSION_SECRET,
    'svc-pay': env.IDENTITY_PAY_ADMISSION_SECRET,
  },
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  bodyBindMode: 'require',
});

/** Every REST route `index.ts` mounts through an exported register function, in its order, with its options. */
function registerRest(app: ReturnType<typeof Fastify>) {
  const sql = stub('sql');
  const auth = stub('auth');
  const securityLock = stub('securityLock');
  const doorS2s = undefined;
  registerAffiliateProducerAccrue(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: doorS2s,
    referral: stub('referral'),
    freeze: stub('freeze'),
    accruals: stub('accruals'),
    accrualTierLaw: parseAccrualTierLawJson(env.IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON),
    programmeDepth: parseProgrammeDepth(env.IDENTITY_PARTNER_PROGRAMME_DEPTH),
    activity: stub('referralLapse'),
  });
  registerBusinessDirectoryRoutes(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: doorS2s,
    store: sqlBusinessDirectory(sql),
    installRawBody: false,
  });
  registerHolderNameCheck(app, { internalSecret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s, details: stub('customerDetails') });
  registerClosureFinalize(app, { secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s, closure: stub('closure') });
  registerGraceClosureFinalize(app, { secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s, controls: stub('founderControls') });
  registerAffiliateProducerPayout(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: doorS2s,
    freeze: stub('freeze'),
    accounts: auth,
    accruals: stub('accruals'),
    accrualTierLaw: parseAccrualTierLawJson(env.IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON),
    programmeDepth: parseProgrammeDepth(env.IDENTITY_PARTNER_PROGRAMME_DEPTH),
    ledger: undefined,
    installRawBody: false,
  });
  registerNavigatorSessionRoutes(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: doorS2s,
    store: createNavigatorSessionStore(sql),
    bodyBind: 'require',
    installRawBody: false,
  });
  const door = { internalSecret: env.INTERNAL_SERVICE_SECRET, bodyBind: env.INTERNAL_SERVICE_BODY_BIND } as const;
  registerRotationRequestRoutes(app, { sql, ...door });
  registerServiceMailRoute(app, {
    queue: (input) => (auth as { queueServiceMail: (i: unknown) => never }).queueServiceMail(input),
    ...door,
  });
  registerWalletSignatureVerifyRoute(app, {
    verify: (input) => verifyWalletSignature((userId) => signingAccount(sql, userId), input),
    ...door,
  });
  registerLinkedWalletsRoute(app, { read: (userId) => linkedWallets(sql, userId), ...door });
  registerSupportDeskLayoutsRoute(app, { read: (userId) => deskLayoutsFor(sql, userId), ...door });
  registerAgentKeyReadRoute(app, { read: (userId, keyId) => readAgentKey(sql, userId, keyId), ...door });
  registerAgentKeyCallsRoute(app, { read: (userId, keyId, limit) => readAgentKeyCalls(sql, userId, keyId, limit), ...door });
  registerTrustedDeviceReadRoute(app, {
    read: (userId, deviceId) => (auth as { trustedDeviceState: (u: string, d: string) => never }).trustedDeviceState(userId, deviceId),
    ...door,
  });
  registerRecoveryClaimVerifyRoute(app, {
    verify: (input) => verifyRecoveryClaim(sql, input),
    estates: (heirUserId) => listRecoveryEstates(sql, heirUserId),
    ...door,
  });
  registerApiKeyOwnershipRoute(app, {
    privateAuthoritySecret: env.IDENTITY_WS_AUTHORITY_SECRET,
    edgeAuthoritySecret: env.IDENTITY_EDGE_AUTHORITY_SECRET,
    operationAdmissionSecrets: { 'svc-trade': env.IDENTITY_TRADE_ADMISSION_SECRET, 'svc-pay': env.IDENTITY_PAY_ADMISSION_SECRET },
    door: stub('placeDoor'),
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: doorS2s,
    bodyBind: env.INTERNAL_SERVICE_BODY_BIND,
    installRawBody: false,
  });
  registerSupportWithdrawalFreezeRoute(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: doorS2s,
    installRawBody: false,
    freeze: (input) => freezeWithdrawalsForSupport(securityLock, input),
    records: (input) => supportWithdrawalFreezeRecords(sql, input),
  });
}

/** One app as `index.ts` builds it: the refresh-cookie and request-meta hooks, the REST routes, then the tRPC mount. */
async function serve(routes: Array<{ method: string; url: string; body: unknown }>) {
  // Fastify gives each request a counted id; one fixed id keeps an added call from shifting every later answer.
  const app = Fastify({ maxParamLength: 5_000, genReqId: () => 'replay-request' });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || route.url.startsWith('/trpc')) continue;
      routes.push({ method, url: route.url, body: (route.schema as { body?: unknown } | undefined)?.body });
    }
  });
  const refreshCookieOf = installRefreshCookieHooks(app);
  // `index.ts`'s request-meta hook, as it is there.
  app.addHook('onRequest', (req, _reply, done) => {
    const rawIp = req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'];
    const forwarded = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    const clientIp = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
    const rawProduct = req.headers['x-product'];
    const productHeader = Array.isArray(rawProduct) ? rawProduct[0] : rawProduct;
    const clientProduct = typeof productHeader === 'string' ? productHeader.trim() : undefined;
    const rawAgent = req.headers['user-agent'];
    const userAgent = typeof rawAgent === 'string' ? rawAgent : undefined;
    const rawRegion = req.headers['x-intafaced-region'];
    const region = typeof rawRegion === 'string' ? rawRegion : undefined;
    requestIpAls.run(clientIp || undefined, () => {
      requestProductAls.run(clientProduct || undefined, () =>
        requestMetaAls.run({ ip: clientIp || undefined, userAgent, region }, () => done()),
      );
    });
  });
  registerRest(app);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createReplayIdentityRouter(),
      createContext: ({ req }: { req: FastifyRequest }) => {
        const base = identityRequestContext(req);
        const raw = req.headers.origin ?? req.headers['x-forwarded-origin'];
        const clientOrigin = Array.isArray(raw) ? raw[0] : raw;
        const refreshCookie = refreshCookieOf(req) ?? null;
        return clientOrigin ? { ...base, clientOrigin, refreshCookie } : { ...base, refreshCookie };
      },
    },
  });
  await app.ready();
  return app;
}

function headers(caller: Caller): Record<string, string> {
  if (caller.scopes === null) return {};
  const principal = {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: caller.scopes,
    tier: caller.tier,
    mfa: caller.mfa,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, caller.region),
    'x-intafaced-region': caller.region,
  };
}

interface Caller {
  readonly scopes: readonly Scope[] | null;
  readonly tier: 'none' | 'basic' | 'full';
  readonly mfa: boolean;
  readonly region: string;
}

/** Nobody; a signed-in person holding no scope; a fully verified holder of every scope, in a served and an unserved region. */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: null, tier: 'none', mfa: false, region: 'DE' }],
  ['no-scope', { scopes: [], tier: 'basic', mfa: false, region: 'DE' }],
  ['all', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'DE' }],
  ['all-US', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'US' }],
];

/** The services that call svc-identity, each calling with a body-bound signature over the shared secret. */
const SERVICES = [
  'svc-trade',
  'svc-pay',
  'svc-bank',
  'svc-ops',
  'svc-support',
  'svc-agents',
  'svc-token',
  'svc-p2p',
  'svc-campaigns',
  'svc-edge',
] as const;

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = [
  '1.50',
  '1',
  '1.5',
  'BTC',
  'USDC',
  'DE',
  'placeholder',
  ID,
  '2026-01-01',
  '2026-01-01T00:00:00Z',
  'a-b',
  'A',
  '0x' + 'a'.repeat(40),
];

/** A plain sample of what an input's own JSON schema asks for. Not always accepted (custom checks are not in the schema): that answer is recorded too. */
function sample(schema: unknown, depth = 0): unknown {
  if (acceptsAnyJson(schema)) return null;
  if (typeof schema !== 'object' || schema === null || depth > 8) return null;
  const s = schema as Json;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[k])) {
      const options = (s[k] as Json[]).filter((o) => o.type !== 'null');
      if (k === 'allOf') return Object.assign({}, ...options.map((o) => sample(o, depth + 1)));
      return sample(options[0] ?? s[k][0], depth + 1);
    }
  }
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const out: Json = {};
      for (const key of (s.required ?? []) as string[]) out[key] = sample(props[key], depth + 1);
      return out;
    }
    case 'array':
      return typeof s.minItems === 'number' && s.minItems > 0 ? Array.from({ length: s.minItems }, () => sample(s.items, depth + 1)) : [];
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return true;
    case 'string': {
      if (s.format === 'uuid') return ID;
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (s.format === 'date') return '2026-01-01';
      if (s.format === 'email') return 'a@example.com';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com/';
      if (typeof s.pattern === 'string') {
        const re = new RegExp(s.pattern as string, 'u');
        return PATTERN_TRIES.find((t) => re.test(t)) ?? 'x';
      }
      // A sample says it is a placeholder, so the secret scan never reads a sample `key` as a committed credential.
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
      return 'placeholder'.length <= max ? 'placeholder'.padEnd(min, 'x') : 'x'.repeat(Math.max(1, min));
    }
    default:
      return null;
  }
}

type Proc = { _def: { type: 'query' | 'mutation' | 'subscription'; inputs: unknown[] } };

function sampleInput(proc: Proc): unknown {
  const input = proc._def.inputs[0];
  if (input === undefined) return undefined;
  try {
    return sample(z.toJSONSchema(input as z.ZodType, { io: 'input', unrepresentable: 'any' }));
  } catch {
    return {};
  }
}

/**
 * The two inputs made from a call's own schema, recorded in the golden file so a changed schema cannot change its own
 * requests. Kept as the JSON text that is sent, byte for byte.
 */
type Samples = { readonly sample: string; readonly 'sample-nulls': string };

function nulls(valid: unknown): unknown {
  return valid !== null && typeof valid === 'object' && !Array.isArray(valid)
    ? Object.fromEntries(Object.keys(valid).map((k) => [k, null]))
    : null;
}

function samplesOf(valid: unknown): Samples {
  return { sample: JSON.stringify(valid ?? null), 'sample-nulls': JSON.stringify(nulls(valid)) };
}

/** Each call gets: nothing; null; a wrong type; an object missing every field; a sample; the sample with every field null. */
function inputs(samples: Samples): Array<[string, unknown]> {
  return [
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['sample', JSON.parse(samples.sample)],
    ['sample-nulls', JSON.parse(samples['sample-nulls'])],
  ];
}

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  /** The requests made from each call's schema when the recording was written: replayed as they are. */
  readonly inputs: Record<string, Samples>;
  /** Per call, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

/**
 * The shard a call is kept in: its namespace (`merchantOps`), or for REST its first two fixed path parts
 * (`rest-v1-payments`); `depth` adds one more part when a shard would pass SHARD_BYTES.
 */
function shardOf(call: string, depth: number): string {
  const rest = /^[A-Z]+ (\/.*)$/.exec(call);
  if (rest)
    return [
      'rest',
      ...rest[1]!
        .split('/')
        .filter((x) => x && !x.startsWith(':'))
        .slice(0, depth + 1),
    ].join('-');
  return call.split('.').slice(0, depth).join('.');
}

/** One shard file: each distinct body once, every answer a status and that body's index. One line per body and per call. */
function shardText(calls: string[], g: Golden): string {
  const bodies: string[] = [];
  const index = new Map<string, number>();
  const rows = calls.map((call) => {
    const answers = Object.entries(g.answers[call]!).map(([k, a]) => {
      if (!index.has(a.body)) index.set(a.body, bodies.push(a.body) - 1);
      return `${JSON.stringify(k)}: [${a.status}, ${index.get(a.body)}]`;
    });
    return `    ${JSON.stringify(call)}: { ${answers.join(', ')} }`;
  });
  const inputs = calls.filter((c) => g.inputs[c]).map((c) => `    ${JSON.stringify(c)}: ${JSON.stringify(g.inputs[c])}`);
  return [
    '{',
    `  "inputs": {\n${inputs.join(',\n')}\n  },`,
    `  "bodies": [\n${bodies.map((b) => `    ${JSON.stringify(b)}`).join(',\n')}\n  ],`,
    `  "answers": {\n${rows.join(',\n')}\n  }`,
    '}',
    '',
  ].join('\n');
}

/** Writes the recording in the repo's own format (the format check reads JSON), each shard under SHARD_BYTES. */
async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, text: string) => {
    const file = goldenJson(name).pathname;
    return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const files = new Map<string, string>();
  const place = async (calls: string[], depth: number) => {
    const groups = new Map<string, string[]>();
    for (const c of calls) groups.set(shardOf(c, depth), [...(groups.get(shardOf(c, depth)) ?? []), c]);
    for (const [name, group] of groups) {
      const text = await format(name, shardText(group, g));
      if (Buffer.byteLength(text) <= SHARD_BYTES) files.set(name, text);
      else if (depth < 4 && new Set(group.map((c) => shardOf(c, depth + 1))).size > 1) await place(group, depth + 1);
      else throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
    }
  };
  await place(Object.keys(g.answers), 1);
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
  const index = JSON.stringify({ callers: g.callers, shards: [...files.keys()].sort() });
  writeFileSync(INDEX, await prettier.format(index, { ...(await prettier.resolveConfig(INDEX.pathname)), filepath: INDEX.pathname }));
}

function readGolden(): Golden {
  const index = JSON.parse(readFileSync(INDEX, 'utf8').replaceAll(RECORDED_STACK, '')) as { callers: unknown; shards: string[] };
  const g: Golden = { callers: index.callers, inputs: {}, answers: {} };
  // A shard the index does not name is a leftover, and fails like a missing one.
  expect(readdirSync(GOLDEN).sort()).toEqual(index.shards.map((s) => `${s}.json`).sort());
  for (const shardName of index.shards) {
    const shard = JSON.parse(readFileSync(goldenJson(shardName), 'utf8').replaceAll(RECORDED_STACK, '')) as {
      inputs: Record<string, Samples>;
      bodies: string[];
      answers: Record<string, Record<string, [number, number]>>;
    };
    Object.assign(g.inputs, shard.inputs);
    for (const [call, answers] of Object.entries(shard.answers))
      g.answers[call] = Object.fromEntries(Object.entries(answers).map(([k, [status, i]]) => [k, { status, body: shard.bodies[i]! }]));
  }
  return g;
}

async function send(
  app: Awaited<ReturnType<typeof serve>>,
  method: string,
  url: string,
  payload: string | undefined,
  h: Record<string, string>,
) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload }),
  });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
  return { status: res.statusCode, body: res.body.replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"') };
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const r = createReplayIdentityRouter();
  const anyRouter: AnyRouter = r;
  const procedures: Record<string, Proc> = anyRouter._def.procedures;
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  const routes: Array<{ method: string; url: string; body: unknown }> = [];
  const app = await serve(routes);
  try {
    for (const path of Object.keys(procedures).sort()) {
      const proc = procedures[path]!;
      if (proc._def.type === 'subscription') continue;
      // A call missing from the recording gets samples from its schema; its answers then match no recorded key and fail.
      samples[path] = recorded?.[path] ?? samplesOf(sampleInput(proc));
      const query = proc._def.type === 'query';
      const request = (input: unknown) => ({
        method: query ? 'GET' : 'POST',
        url: `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        payload: query ? undefined : input === undefined ? '' : JSON.stringify(input),
      });
      for (const [inputName, input] of inputs(samples[path]))
        for (const [callerName, caller] of CALLERS) {
          const { method, url, payload } = request(input);
          (answers[path] ??= {})[`${inputName} ${callerName}`] = await send(app, method, url, payload, headers(caller));
        }
      // A procedure that refuses every person as unauthenticated is a service door: each signed service calls it too.
      const personAnswers = Object.entries(answers[path]!).filter(([k]) => / all(-US)?$/.test(k));
      if (personAnswers.every(([, a]) => a.status === 401))
        for (const [inputName, input] of inputs(samples[path]))
          for (const service of SERVICES) {
            const { method, url, payload } = request(input);
            answers[path]![`${inputName} ${service}`] = await send(
              app,
              method,
              url,
              payload,
              serviceAuthHeadersForBody(service, INTERNAL, payload ?? ''),
            );
          }
    }
    // REST: every route, path parameters filled with one id; a body-taking route gets the same six bodies.
    for (const route of [...routes].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`))) {
      const name = `${route.method} ${route.url}`;
      const url = route.url.replace(/:[A-Za-z]+/g, ID);
      const takesBody = route.method !== 'GET' && route.method !== 'DELETE';
      if (takesBody) {
        const valid = route.body === undefined ? {} : sample(route.body);
        samples[name] = recorded?.[name] ?? samplesOf(valid);
      }
      const bodies: Array<[string, unknown]> = takesBody ? inputs(samples[name]!) : [['absent', undefined]];
      for (const [inputName, input] of bodies) {
        const payload = takesBody ? (input === undefined ? '' : JSON.stringify(input)) : undefined;
        for (const [callerName, caller] of CALLERS)
          (answers[name] ??= {})[`${inputName} ${callerName}`] = await send(app, route.method, url, payload, headers(caller));
        for (const service of SERVICES)
          (answers[name] ??= {})[`${inputName} ${service}`] = await send(
            app,
            route.method,
            url,
            payload,
            serviceAuthHeadersForBody(service, INTERNAL, payload ?? ''),
          );
      }
    }
  } finally {
    await app.close();
  }
  return { callers: procedureCallers(r as never), inputs: samples, answers };
}

describe('the wire replay: svc-identity answers every identity call as recorded', () => {
  // Some answers carry the time (the server clock, a request's deadline): one fixed time keeps them the same on every run.
  // Shared packages read APP_ENV and a few settings per request: they read the same blank source, whatever runs the test.
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-19T00:00:00.000Z') });
    saved = process.env;
    process.env = { ...ENV_SOURCE, ...(saved.WIRE_REPLAY_WRITE ? { WIRE_REPLAY_WRITE: saved.WIRE_REPLAY_WRITE } : {}) };
  });
  afterEach(() => {
    process.env = saved;
    vi.useRealTimers();
  });

  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const write = process.env.WIRE_REPLAY_WRITE === '1';
    const now = await replay(write ? null : readGolden().inputs);
    if (write) await writeGolden(now);
    const golden = readGolden();
    expect(now.callers).toEqual(golden.callers);
    expect(now.inputs).toEqual(golden.inputs);
    const flat = (g: Golden) =>
      Object.fromEntries(Object.entries(g.answers).flatMap(([call, a]) => Object.entries(a).map(([k, v]) => [`${call} ${k}`, v])));
    const was = flat(golden);
    const is = flat(now);
    expect(Object.keys(is).sort()).toEqual(Object.keys(was).sort());
    const diffs = Object.entries(was)
      .filter(([key, a]) => is[key]?.status !== a.status || is[key]?.body !== a.body)
      .map(([key, a]) => `${key}: ${a.status} ${a.body.slice(0, 160)} != ${is[key]?.status} ${is[key]?.body.slice(0, 160)}`);
    expect(diffs).toEqual([]);
  }, 300_000);
});

/**
 * `jsonValueSchema` (z.json()) as JSON Schema: a choice of every JSON kind. Main had `z.unknown()` there (`{}`), which
 * the sampler read as null; this reads the same, so the replay sends main's request (tooling/codemod/call-records/portable.mjs).
 */
function acceptsAnyJson(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const options = (schema as { anyOf?: unknown }).anyOf;
  if (!Array.isArray(options)) return false;
  const kinds = new Set(options.map((o: unknown) => (typeof o === 'object' && o !== null ? (o as { type?: unknown }).type : undefined)));
  return ['string', 'number', 'boolean', 'null', 'array', 'object'].every((k) => kinds.has(k));
}
