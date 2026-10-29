import { parseKycRequirementsByLevel, parseKycReviewHoursByLevel } from './kyc/levels.js';
import { parseKycRejectReasons, relayKycCaseEvents } from './kyc/cases.js';
import { parseKycCapabilitiesByLevel } from './kyc/capabilities.js';
import { parseKycAttemptLimit } from './kyc/attempts.js';
import { KycProfileDesk, parseKycDocumentTypes, parseKycUploadCaps } from './kyc/profile.js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { mergeRouters, s2sFromEnv } from '@intafaced/contracts';
import { serviceOfRequest } from './s2s-door.js';
import { readIdentityWatermark } from './restore-watermark.js';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { relaySecurityFactorEvents } from './auth/factor-changed-notice.js';
import { AuthService } from './auth/auth-service.js';
import { createPayMerchantEmailInviteClaimer } from './auth/merchant-email-invite-claim.js';
import { openIdentityMail } from './auth/local-mail.js';
import { withAntiPhishingCode } from './profile/anti-phishing-mail.js';
import { PlaceDoor } from './auth/place-door.js';
import { founderEnrolmentConfig } from './auth/founder-enrolment.js';
import { selectOnboardingUser } from './auth/onboarding-user.js';
import { fetchOwnerPayScopes } from './auth/owner-pay-scopes.js';
import { fetchPayStepUpGrant } from './auth/pay-step-up-grant.js';
import { registerApiKeyOwnershipRoute } from './auth/api-key-ownership-route.js';
import { registerServiceMailRoute } from './auth/service-mail.js';
import { registerTrustedDeviceReadRoute } from './auth/trusted-device-read.js';
import { assertProdTotpKey, assertSigningEncKey, parseTotpSecretKey } from './auth/totp-crypto.js';
import { RankService } from './rank/rank-service.js';
import { ReferralService } from './affiliates/referral-service.js';
import { ShareService } from './affiliates/share-service.js';
import { ReferralRebindService } from './affiliates/referral-rebind.js';
import {
  ReferralLapseService,
  lapseSweepStatusLine,
  parseLapsePeriodSeconds,
  parseLapseSweepSeconds,
} from './affiliates/referral-lapse.js';
import { ReferralCodeService, parseReferralCodeLength } from './affiliates/referral-code.js';
import { parseAttachWindowSeconds } from './affiliates/attach-window.js';
import { FreezeService } from './affiliates/freeze-service.js';
import { SqlAccrualStore } from './affiliates/accrual-store.js';
import { parseAccrualTierLawJson } from './affiliates/commission-rate-law.js';
import { parseDmaHierarchyLawJson } from './orgs/dma-hierarchy.js';
import { createLedgerClient } from './ledger-client.js';
import { assertArgon2Available, argon2Available, parseBreachedPasswords, useBreachedPasswords } from './auth/passwords.js';
import { createIdentityRouter } from './router.js';
import { createTradeIdentityAuthRouter } from './auth/trade-identity-auth-router.js';
import { assertStaffSessionLive, createSqlTradeIdentityStore } from './auth/trade-identity-auth.js';
import { gateFrozenSubAccount } from './auth/sub-account-place-gate.js';
import { createApiKeyIpRouter } from './api-key-ip-router.js';
import { createApiKeyOriginRouter } from './api-key-origin-router.js';
import { createApiKeyAccountRouter } from './api-key-account-router.js';
import { createApiKeyRotateRouter } from './api-key-rotate-router.js';
import { createApiKeyExpireRouter } from './api-key-expire-router.js';
import { createApiKeyRevokeAllRouter } from './api-key-revoke-all-router.js';
import { createSessionFamiliesRouter } from './session-families-router.js';
import { createGrantsRouter } from './grants-router.js';
import { createSessionRevokeAllRouter } from './session-revoke-all-router.js';
import { createSessionRevokeRouter } from './session-revoke-router.js';
import { createListSessionsRouter } from './list-sessions-router.js';
import { createPanicRevokeRouter } from './panic-revoke-router.js';
import { createApiKeyProductRouter } from './api-key-product-router.js';
import { createApiKeyAttributionRouter } from './api-key-attribution-router.js';
import { createDisableUserRouter } from './disable-user-router.js';
import { FounderControls, parseFounderPair } from './controls/founder-controls.js';
import { createFounderControlsRouter } from './controls/founder-controls-router.js';
import { CustomerDetailsDesk } from './controls/customer-details.js';
import { AccountLimitsDesk, parseLimitPolicy } from './controls/account-limits.js';
import { parseAccountTiers } from './controls/account-tiers.js';
import { parseDormancyDays } from './controls/account-archive.js';
import { createOperatorOpsRouter } from './ops/ops-router.js';
import { SocialSignin } from './social/social-signin.js';
import { createPreferencesRouter } from './preferences/preferences-router.js';
import { createMembershipRouter } from './membership/membership-router.js';
import { OAuthService } from './oauth/oauth.js';
import { createOAuthRouter } from './oauth/oauth-router.js';
import { edgeTrustFromEnv, isExplicitDevOrTest } from '@intafaced/config';
import { createIdentityRequestContext, configuredIdentityOperationOwners } from './controls/founder-context.js';
import { AuthKeyRing, parseAuthKeys } from './auth/auth-key-ring.js';
import { createAuthKeysRouter } from './auth-keys-router.js';
import { OperationIdentityDecisions } from './controls/operation-identity-decisions.js';
import { createOperationIdentityRouter } from './controls/operation-identity-router.js';
import { createLimitFeeTierRouter } from './limit-fee-tier-router.js';
import { SavedRecipientService } from './saved-recipients.js';
import { createSavedRecipientsRouter } from './saved-recipients.router.js';
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
import { createRecoveryKeysRouter } from './recovery-keys-router.js';
import { createDeathNoticesRouter } from './death-notices-router.js';
import { listRecoveryEstates, relayDeathNoticeEvents, verifyRecoveryClaim } from './auth/death-notices.js';
import { registerRecoveryClaimVerifyRoute } from './auth/recovery-claim-verify.js';
import { RecoveryKeys } from './auth/recovery-keys.js';
import { createTrustedDevicesRouter } from './trusted-devices-router.js';
import { SecurityLock } from './auth/security-lock.js';
import { SelfFreezeLift } from './auth/self-freeze-lift.js';
import { TotpLifecycle } from './auth/totp-lifecycle.js';
import { SqlPendingTotpEnrolmentStore } from './auth/pending-totp-store.js';
import { requireEnrolledSecondFactor } from './auth/passkey-manage.js';
import { SecurityStepUp } from './auth/security-step-up.js';
import { createUnenrollPasskeyRouter } from './unenroll-passkey-router.js';
import { installDisabledMintRefuse } from './auth/disable-user.js';
import { installPasskeyMintRefuse } from './auth/mint-api-key-passkey.js';
import { installApiKeyAttribution, installFourEyes } from './auth/four-eyes.js';
import { installFreezeDualControl, installPrivilegedDualControl } from './auth/privileged-dual-control.js';
import { installLimitFeeTierDualControl } from './rank/limit-fee-tier.js';
import { requestMetaAls } from './auth/request-meta.js';
import { installApiKeyIpExchange, requestIpAls } from './auth/auth-service-ip.js';
import { installRefreshCookieHooks } from './auth/refresh-cookie.js';
import { installApiKeyRequestSignExchange } from './auth/api-key-request-sign.js';
import { createApiKeyRequestSignRouter } from './api-key-request-sign-router.js';
import { createDeveloperKeysRouter } from './developer-keys-router.js';
import { parseApiKeyCapByTier, passkeyMintRule } from './auth/developer-keys.js';
import { installApiKeyProductExchange, requestProductAls } from './auth/auth-service-product.js';
import { installApiKeyAccountExchange } from './auth/bind-api-key-account.js';
import { bootKycVault } from './kyc/boot-vault.js';
import { parseKycDocKey } from './kyc/document-crypto.js';
import { identityReadyHonesty } from './ready-honesty.js';
import { SqlActionApprovalStore } from './auth/action-approval-store.js';
import { ActionApprovalService } from './auth/action-approval-service.js';
import { createActionApprovalRouter } from './action-approval-router.js';
import { createStepUpRouter } from './step-up-router.js';
import { CustomerStepUpService } from './auth/customer-step-up.js';
import { SqlCustomerStepUpStore } from './auth/customer-step-up-store.js';
import { ProfileService } from './profile/profile-service.js';
import { AccountChange } from './account/account-router.js';
import { httpClosureChecker } from './closure/closure-client.js';
import { SubAccountDeleteService } from './sub-accounts/sub-account-delete.js';
import { SubAccountEditService } from './sub-accounts/sub-account-edit.js';
import { AntiPhishingService, antiPhishingKey } from './profile/anti-phishing.js';
import { SubAccountFeatureService, parseFeatureEligibility } from './sub-accounts/sub-account-features.js';
import { registerClosureFinalize } from './closure/closure-job.js';
import { createClosureOpsRouter } from './closure/closure-ops-router.js';
import { AccountClosureService } from './closure/closure-service.js';
import { SqlWaitlistStore } from './waitlist/waitlist-store.js';
import { parseWaveSize, WaitlistService } from './waitlist/waitlist-service.js';
import { registerAffiliateProducerAccrue } from './affiliates/producer-accrue.js';
import { registerBusinessDirectoryRoutes, sqlBusinessDirectory } from './business-directory.js';
import { registerHolderNameCheck } from './holder-name-check.js';
import { registerAffiliateProducerPayout } from './affiliates/producer-payout.js';
import { createNavigatorSessionStore } from './agents/navigator-session-store.js';
import { registerNavigatorSessionRoutes } from './agents/navigator-session-routes.js';
import { subscribeBlueprintProfileEvents, subscribeXpEvents } from './events.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-identity — one account, one verification, one rank (§4.1).
 *
 * Graph W1-C: mount tRPC; verify edge-signed principal (mount-boundary #48).
 * Blueprint cascade: subscribe to blueprintCreated/Deleted so profiles.blueprint_id
 * tracks svc-blueprint without writing across service tables (§2 / §7.2).
 * XP: subscribe to xpEarned, so awards published by svc-p2p and svc-trade reach
 * rank_state. Until this consumer existed they reached nothing — see ./events.ts.
 */

if (env.APP_ENV === 'prod') {
  await assertArgon2Available();
  // TOTP secrets must not sit base32-plaintext in prod; refuse boot without key.
  assertProdTotpKey(env);
}
// The owner's breached-password list: read once; a set path that cannot be read or parsed stops the boot. A relative
// path is read from the svc-identity folder, whatever directory the process was started in.
if (env.IDENTITY_BREACHED_PASSWORDS_FILE) {
  const listPath = resolvePath(fileURLToPath(new URL('..', import.meta.url)), env.IDENTITY_BREACHED_PASSWORDS_FILE);
  useBreachedPasswords(parseBreachedPasswords(readFileSync(listPath, 'utf8')));
}
// Request-signing secrets must not sit plaintext in prod or staging.
assertSigningEncKey(env);
const signingEncKey = parseTotpSecretKey(env.API_KEY_SIGNING_ENC_KEY);

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'identity,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM users LIMIT 1`.catch(() => {
  throw new Error('identity schema is missing — run migrations before starting svc-identity');
});
// Code-before-migration must fail here, not on the first login (0027 per-account lockout counters).
await sql`SELECT consecutive_failures FROM auth_attempts LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: auth_attempts (with consecutive_failures) is missing — apply drizzle/0027_auth_attempt_lockouts.sql before starting svc-identity',
  );
});

// Same for 0028: registerFounder would otherwise fail on the first invite, not at boot.
await sql`SELECT hash FROM founder_invites_used LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: founder_invites_used is missing — apply drizzle/0028_founder_invites_used.sql before starting svc-identity',
  );
});
await sql`SELECT require_signature FROM api_keys LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: api_keys.require_signature is missing — apply drizzle/0030_api_keys_request_sign.sql before starting svc-identity',
  );
});
await sql`SELECT code_hash FROM password_reset_proofs LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: password_reset_proofs is missing — apply drizzle/0031_password_reset_proofs.sql before starting svc-identity',
  );
});
await sql`SELECT successor_refresh FROM sessions LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: sessions.successor_refresh is missing — apply drizzle/0032_session_refresh_grace.sql before starting svc-identity',
  );
});
await sql`SELECT challenge_id FROM customer_step_ups LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: customer_step_ups is missing — apply drizzle/0033_customer_step_up.sql before starting svc-identity',
  );
});
await sql`SELECT email_verified_at FROM users LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: users.email_verified_at is missing — apply drizzle/0034_email_confirmation.sql before starting svc-identity',
  );
});
await sql`SELECT consumed_by_service, consumed_by_principal, consumed_request_id FROM action_approvals LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: action_approvals consume provenance is missing — apply drizzle/0038_action_approval_consume_provenance.sql before starting svc-identity',
  );
});
await sql`SELECT user_id, restricted, version FROM trading_restrictions LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: trading_restrictions is missing — apply drizzle/0038_action_approval_consume_provenance.sql before starting svc-identity',
  );
});
await sql`SELECT version FROM profiles LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: profiles.version is missing — apply drizzle/0042_profile_version.sql before starting svc-identity',
  );
});
await sql`SELECT code_hash FROM contact_change_proofs LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: contact_change_proofs is missing — apply drizzle/0043_contact_change.sql before starting svc-identity',
  );
});
await sql`SELECT phone FROM user_phones LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: user_phones is missing — apply drizzle/0043_contact_change.sql before starting svc-identity',
  );
});

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['identity'],
});

const rank = new RankService(sql, bus);
await rank.seedTiers();

/** §7.2 cascade — must be wired before traffic; durable consumers catch up on restart. */
const blueprintSubs = await subscribeBlueprintProfileEvents(bus, sql);

/**
 * XP from every other module. Wired here rather than inside `RankService`
 * because the service is also called directly by our own auth flows and by
 * `awardXp` over tRPC — the bus is a fourth caller of the same method, not a
 * different way of writing rank_state.
 *
 * `identity` is our own stream, so this cannot fail on a stream that does not
 * exist yet; svc-p2p and svc-trade publish into it.
 */
const xpSub = await subscribeXpEvents(bus, rank);

// Signing keys with rotation overlap: the ring is read live by the token config below.
const authKeyRing = new AuthKeyRing(sql, env.JWT_ACCESS_SECRET, parseAuthKeys(env.IDENTITY_AUTH_KEYS), {
  consume: (service, input) => actionApprovals.consume(service, input),
});
await authKeyRing.refresh();
authKeyRing.start();

const auth = new AuthService(
  sql,
  bus,
  rank,
  authKeyRing.tokenConfig({
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
  }),
  {
    rpID: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    origin: env.WEBAUTHN_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  env.IDENTITY_TOTP_SECRET_KEY,
  undefined,
  undefined,
  env.IDENTITY_MAX_SUB_ACCOUNTS,
  env.REFRESH_REUSE_GRACE_SECONDS,
  env.REFRESH_RECOVERY_SECONDS,
  env.IDENTITY_SUB_ACCOUNT_KINDS,
);
// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the ledger, pay and closure calls on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-identity');
/** The same keys on the inbound doors: a key-signed caller is named by its own key. */
const doorS2s = s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined;
/** Own-key signing for the outgoing calls; undefined leaves them on the shared secret. */
const outS2s = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
if (env.PAY_URL) {
  const payUrl = env.PAY_URL;
  auth.useOwnerPayScopeSource(async (userId) => {
    const user = await selectOnboardingUser(sql, userId);
    return fetchOwnerPayScopes({
      payUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
      userId,
      ...(user ? { user } : {}),
      ...(outS2s ? { s2s: outS2s } : {}),
    });
  });
  auth.usePayStepUpRoleSource(async ({ userId, merchantId }) => {
    const grant = await fetchPayStepUpGrant({
      payUrl,
      secret: env.INTERNAL_SERVICE_SECRET,
      userId,
      merchantId,
      ...(outS2s ? { s2s: outS2s } : {}),
    });
    return {
      refundsCreate: grant.permissions['refunds.create'] === true,
      payoutSend: grant.permissions['payout.send'] === true,
    };
  });
}
// Lifetime can be published without a mail port. With either one missing, every
// reset request refuses auth.reset_unwired. The only transport this process
// can install is the local-outbox file, and only when APP_ENV is exactly dev
// or test. Staging and production stay unwired. No provider is configured.
const transportMail = openIdentityMail({
  appEnv: process.env.APP_ENV,
  transport: env.IDENTITY_MAIL_TRANSPORT,
  outboxPath: env.IDENTITY_LOCAL_MAIL_OUTBOX,
});
// Mails to an account's own address carry the anti-phishing code its owner set.
const antiPhishingMailKey = antiPhishingKey(parseTotpSecretKey(env.IDENTITY_TOTP_SECRET_KEY));
const mail = transportMail && withAntiPhishingCode(transportMail, sql, antiPhishingMailKey);
auth.usePasswordResetMail(mail);
auth.useKycCapabilities(parseKycCapabilitiesByLevel(env.IDENTITY_KYC_CAPABILITIES_BY_LEVEL));
auth.useKycAttemptLimit(parseKycAttemptLimit(env));
auth.usePasswordResetTtl(env.IDENTITY_PASSWORD_RESET_TTL_SECONDS);
auth.usePasswordResetPolicy({
  maxAttempts: env.IDENTITY_PASSWORD_RESET_MAX_ATTEMPTS,
  requestMax: env.IDENTITY_PASSWORD_RESET_REQUEST_MAX,
  requestWindowSeconds: env.IDENTITY_PASSWORD_RESET_REQUEST_WINDOW_SECONDS,
  subjectKey: env.IDENTITY_FLOW_SUBJECT_KEY,
  notifyUnknown: env.IDENTITY_RESET_NOTIFY_UNKNOWN,
});
// Recovery mail leaves from the outbox, not from the request. A request starts a drain right after it
// commits; the timer picks up anything a crash or a failed start left pending. A drain claims each row
// once, so the two never send the same mail.
const drainRecoveryMail = () => {
  void auth
    .drainMailOutbox()
    .catch((err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'auth.mail_relay_failed'));
};
auth.useMailRelayTrigger(() => {
  setImmediate(drainRecoveryMail);
});
setInterval(drainRecoveryMail, 15_000).unref();
if (env.PAY_URL) {
  auth.useMerchantEmailInviteClaimer(createPayMerchantEmailInviteClaimer(env.PAY_URL, env.INTERNAL_SERVICE_SECRET, fetch, outS2s));
}
auth.useEmailConfirmation({
  mail,
  ttlSeconds: env.IDENTITY_EMAIL_CONFIRM_TTL_SECONDS,
  rateMax: env.IDENTITY_EMAIL_CONFIRM_RATE_MAX,
  rateWindowSeconds: env.IDENTITY_EMAIL_CONFIRM_RATE_WINDOW_SECONDS,
});
// Sign-up sends its code through the same outbox and relay. Any blank number refuses every sign-up the same way.
auth.useSignUpPolicy({
  minAgeYears: env.IDENTITY_SIGNUP_MIN_AGE_YEARS,
  codeTtlSeconds: env.IDENTITY_SIGNUP_CODE_TTL_SECONDS,
  maxAttempts: env.IDENTITY_SIGNUP_CODE_MAX_ATTEMPTS,
  resendSeconds: env.IDENTITY_SIGNUP_RESEND_SECONDS,
  requestMax: env.IDENTITY_SIGNUP_REQUEST_MAX,
  requestWindowSeconds: env.IDENTITY_SIGNUP_REQUEST_WINDOW_SECONDS,
  closedCountries: env.IDENTITY_SIGNUP_CLOSED_COUNTRIES,
});
// Sign-in by a mailed code uses the same outbox and relay. Any blank number refuses every code sign-in the same way.
auth.useLoginCodePolicy({
  codeTtlSeconds: env.IDENTITY_LOGIN_CODE_TTL_SECONDS,
  maxAttempts: env.IDENTITY_LOGIN_CODE_MAX_ATTEMPTS,
  resendSeconds: env.IDENTITY_LOGIN_CODE_RESEND_SECONDS,
  requestMax: env.IDENTITY_LOGIN_CODE_REQUEST_MAX,
  requestWindowSeconds: env.IDENTITY_LOGIN_CODE_REQUEST_WINDOW_SECONDS,
});
// The locked-out second-factor reset waits the owner's time; blank refuses and the sign-in page points to Support.
auth.useMfaResetWait(env.IDENTITY_MFA_RESET_WAIT_SECONDS);
auth.useSupportRecoveryLinkTtl(env.IDENTITY_SUPPORT_RECOVERY_LINK_TTL_SECONDS);
auth.useNewDevicePolicy({
  check: env.IDENTITY_NEW_DEVICE_CHECK === 'on',
  flowTtlSeconds: env.IDENTITY_NEW_DEVICE_TTL_SECONDS,
  maxAttempts: env.IDENTITY_NEW_DEVICE_MAX_ATTEMPTS,
  trustedTtlSeconds: env.IDENTITY_TRUSTED_DEVICE_TTL_SECONDS,
});

const placeDoor = new PlaceDoor(sql);
const founderPair = parseFounderPair(env.IDENTITY_FOUNDER_NITRO_USER_ID, env.IDENTITY_FOUNDER_PHANTOM_USER_ID);
const founderControls = new FounderControls(sql, founderPair, {
  tradingRestrictRequiresApproval: env.IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL === true,
});
await founderControls.bootstrap();
auth.useFounderDirectory({ isFounder: (userId, query) => founderControls.isLiveFounder(userId, query) });
auth.useFounderSessionScopes(env.IDENTITY_FOUNDER_SESSION_SCOPES);

const referral = new ReferralService(sql);
const share = new ShareService(sql);
const referralCodes = new ReferralCodeService(sql, parseReferralCodeLength(env.IDENTITY_REFERRAL_CODE_LENGTH));
const referralAttachWindowSeconds = parseAttachWindowSeconds(env.IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS);
const referralLapsePeriodSeconds = parseLapsePeriodSeconds(env.IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS);
const referralLapseSweepSeconds = parseLapseSweepSeconds(env.IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS);
const referralLapse = new ReferralLapseService(sql, { periodSeconds: referralLapsePeriodSeconds });
const freeze = new FreezeService(sql);
const accruals = new SqlAccrualStore(sql);
/** Fail boot on malformed owner rates — never invent commission percentages. */
const accrualTierLaw = parseAccrualTierLawJson(env.IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON);
/** Fail boot on malformed owner DMA law — never invent a broker tree. */
const dmaHierarchyLaw = parseDmaHierarchyLawJson(env.IDENTITY_DMA_HIERARCHY_LAW_JSON);

/**
 * The affiliate payout rail. Compose sets LEDGER_URL to in-network svc-ledger.
 * Absent (non-compose / omitted) → payout refuses `affiliate.payout.ledger_unwired`
 * rather than reporting a payment it could not make. No localhost default.
 */
const ledger = env.LEDGER_URL ? createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, outS2s) : undefined;

/**
 * §10 KYC encrypted vault. Unset IDENTITY_KYC_DOC_KEY → vault null (procedures
 * named-refuse `[kyc_doc.unwired]`). Set but invalid → boot throws `kyc_doc.key_missing`
 * (not a silent missing store). Never invent a key. Live vendor webhook remains Class X.
 */
const vault = bootKycVault(sql, env.IDENTITY_KYC_DOC_KEY);
// Guided verification (I-kyc-compliance-08): drafts sealed under the same key; the photo goes to the vault.
const kycProfile = new KycProfileDesk(sql, parseKycDocKey(env.IDENTITY_KYC_DOC_KEY), {
  documentTypes: parseKycDocumentTypes(env.IDENTITY_KYC_DOCUMENT_TYPES_BY_COUNTRY),
  uploadCaps: parseKycUploadCaps(env),
  vault: vault?.kycDocs,
  submit: (input) => auth.submitKyc(input),
});
// Staff-edited customer details (J-ops-console-04 #9) are encrypted under the same key; unset, every details door refuses.
const customerDetails = new CustomerDetailsDesk(sql, founderControls, parseKycDocKey(env.IDENTITY_KYC_DOC_KEY));
// Customer limit overrides (J-ops-console-04 #12) under the owner's IDENTITY_LIMIT_OVERRIDE_POLICY; unset, every set refuses.
const accountLimits = new AccountLimitsDesk(sql, founderControls, parseLimitPolicy(env.IDENTITY_LIMIT_OVERRIDE_POLICY));

const waitlist = new WaitlistService(
  new SqlWaitlistStore(sql),
  {
    drop: env.LAUNCH_DROP,
    env: {
      INTAFACED_FLAG_WAITLIST_ENABLED: env.INTAFACED_FLAG_WAITLIST_ENABLED,
      INTAFACED_FLAG_REFERRAL_QUEUE: env.INTAFACED_FLAG_REFERRAL_QUEUE,
    },
  },
  parseWaveSize(env.IDENTITY_WAITLIST_WAVE_SIZE),
);

installApiKeyIpExchange(auth, sql);
installApiKeyAccountExchange(auth, sql);
installApiKeyProductExchange(auth, sql);
installDisabledMintRefuse(auth, sql);
installPasskeyMintRefuse(auth, sql);
auth.usePasskeyLimit(env.PASSKEY_MAX_PER_ACCOUNT);
installFourEyes();
installApiKeyAttribution(auth);
installApiKeyRequestSignExchange(auth, sql, signingEncKey);

const stepUpStore = new SqlCustomerStepUpStore(sql);
const actionApprovals = new ActionApprovalService(
  new SqlActionApprovalStore(sql),
  {
    ttlSeconds: env.IDENTITY_ACTION_APPROVAL_TTL_SECONDS,
    // Founder-only action types (pay, matching, ledger, bank, token, ...) re-check both parties against the live founder
    // entitlement at approve and again at consume. Unconfigured founder controls answer false, so those types refuse closed.
    founders: { isFounder: (userId) => founderControls.isLiveFounder(userId) },
  },
  () => new Date(),
  (row, at) =>
    stepUpStore.auditConsumed({
      approvalId: row.approvalId,
      requesterId: row.requesterId,
      sessionId: row.sessionId,
      actionType: row.actionType,
      at,
    }),
);
const customerStepUp = new CustomerStepUpService(sql, stepUpStore, auth);
const securityStepUp = new SecurityStepUp({ sql, approvals: actionApprovals, secondFactor: requireEnrolledSecondFactor(sql) });
const selfFreezeLift = new SelfFreezeLift(sql, env.IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS);
const securityLock = new SecurityLock(sql, env.IDENTITY_SECURITY_LOCK_UNLOCK_WAIT_SECONDS);
await sql`SELECT frozen FROM sub_accounts LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: sub_accounts.frozen is missing — apply drizzle/0044_sub_account_frozen.sql before starting svc-identity',
  );
});
await sql`SELECT id FROM account_security_locks LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: account_security_locks is missing — apply drizzle/0072_account_security_locks.sql before starting svc-identity',
  );
});
await sql`SELECT id FROM account_closures LIMIT 0`.catch(() => {
  throw new Error(
    'identity schema is out of date: account_closures is missing — apply drizzle/0048_account_closures.sql before starting svc-identity',
  );
});
const profile = new ProfileService(sql);
// Phone codes have no provider. account.phone.begin refuses auth.change_unwired
// until an owner installs a PhoneCodeSender. This process does not send SMS.
const account = new AccountChange({
  sql,
  approvals: actionApprovals,
  mail,
  phone: undefined,
  ttlSeconds: env.IDENTITY_CONTACT_CHANGE_TTL_SECONDS,
  maxAttempts: env.IDENTITY_CONTACT_CHANGE_MAX_ATTEMPTS,
  now: () => new Date(),
  log: { warn() {} },
});
const closureSecret = env.INTERNAL_SERVICE_SECRET;
const bankClosureCheck = httpClosureChecker({
  url: env.IDENTITY_CLOSURE_BANK_URL,
  secret: closureSecret,
  ...(outS2s ? { s2s: { ...outS2s, audience: 'svc-bank' } } : {}),
});
const tradeClosureCheck = httpClosureChecker({
  url: env.IDENTITY_CLOSURE_TRADE_URL,
  secret: closureSecret,
  ...(outS2s ? { s2s: { ...outS2s, audience: 'svc-trade' } } : {}),
});
const p2pClosureCheck = httpClosureChecker({
  url: env.IDENTITY_CLOSURE_P2P_URL,
  secret: closureSecret,
  ...(outS2s ? { s2s: { ...outS2s, audience: 'svc-p2p' } } : {}),
});
founderControls.useAccountTiers(parseAccountTiers(env.IDENTITY_ACCOUNT_TIERS));
founderControls.useDormancyDays(parseDormancyDays(env.IDENTITY_DORMANCY_DAYS));
// A staff close (J-ops-console-04 #7) runs the same checks as a customer closure before the approval is spent.
founderControls.useClosureChecks(async (input) => {
  const results = await Promise.all([bankClosureCheck.check(input), tradeClosureCheck.check(input), p2pClosureCheck.check(input)]);
  if (results.some((result) => !result.ok)) return { ok: false };
  return { ok: true, blockers: results.flatMap((result) => (result.ok ? result.blockers : [])) };
});
const subAccountDelete = new SubAccountDeleteService({ sql, approvals: actionApprovals, bank: bankClosureCheck, trade: tradeClosureCheck });
const subAccountEdit = new SubAccountEditService({ sql, approvals: actionApprovals });
const antiPhishing = new AntiPhishingService({
  sql,
  approvals: actionApprovals,
  key: antiPhishingMailKey,
});
const subAccountFeatures = new SubAccountFeatureService({ sql, eligibility: parseFeatureEligibility(env.IDENTITY_SUB_ACCOUNT_FEATURES) });
const closure = new AccountClosureService({
  sql,
  approvals: actionApprovals,
  enabled: env.IDENTITY_ACCOUNT_CLOSE_ENABLED,
  coolingOffDays: env.IDENTITY_ACCOUNT_CLOSE_COOLING_OFF_DAYS,
  founderUserIds: founderPair ?? [],
  bank: bankClosureCheck,
  trade: tradeClosureCheck,
  p2p: p2pClosureCheck,
  now: () => new Date(),
});
account.email.useOnConfirmed((userId) => auth.claimConfirmedEmailInvites(userId));
installPrivilegedDualControl(auth, actionApprovals);
installFreezeDualControl(freeze, actionApprovals);
installLimitFeeTierDualControl(rank, sql, actionApprovals);

// No provider is built in: every start answers the allowlisted `idp.social` until one is registered here.
const social = new SocialSignin(sql, { providers: new Map(), flowTtlSeconds: env.IDENTITY_SOCIAL_FLOW_TTL_SECONDS });

export const appRouter = mergeRouters(
  createIdentityRouter(auth, rank, {
    registrationOpen: env.REGISTRATION_OPEN,
    // The code-less register door is for the dev and test stacks' own tools only.
    directRegister: isExplicitDevOrTest(process.env.APP_ENV),
    founderEnrolment: { invites: founderEnrolmentConfig(env.IDENTITY_FOUNDER_INVITE_HASHES, env.IDENTITY_FOUNDER_INVITE_EXPIRES_AT) },
    webauthnEnabled: env.WEBAUTHN_ENABLED,
    // Parsed at start: a malformed published list or review time stops the service rather than showing a wrong one.
    kycLadder: {
      requirements: parseKycRequirementsByLevel(env.IDENTITY_KYC_REQUIREMENTS_BY_LEVEL),
      reviewHours: parseKycReviewHoursByLevel(env.IDENTITY_KYC_REVIEW_HOURS_BY_LEVEL),
    },
    kycRejectReasons: parseKycRejectReasons(env.IDENTITY_KYC_REJECT_REASONS),
    kycCapabilityReasons: parseKycRejectReasons(env.IDENTITY_KYC_CAPABILITY_REASONS, 'IDENTITY_KYC_CAPABILITY_REASONS'),
    kycProfile,
    social,
    referral,
    share,
    referralCodes,
    referralAttachWindowSeconds,
    referralRebind: new ReferralRebindService(sql, actionApprovals, { attachWindowSeconds: referralAttachWindowSeconds }),
    referralLapse,
    freeze,
    accruals,
    accrualTierLaw,
    ledger,
    ...(vault ?? {}),
    waitlist,
    actionApprovals,
    founderControls,
    privilegedUserIds: founderPair ?? [],
    assertStaffSessionLive: (sessionId, userId) => assertStaffSessionLive(createSqlTradeIdentityStore(sql), sessionId, userId),
    profile,
    account,
    closure,
    subAccountDelete,
    subAccountFeatures,
    subAccountEdit,
    antiPhishing,
  }),
  createClosureOpsRouter(sql),
  createApiKeyIpRouter(sql, auth, auth),
  createApiKeyRequestSignRouter(sql, auth, signingEncKey),
  createApiKeyOriginRouter(sql, auth, auth),
  createApiKeyAccountRouter(sql, auth, auth),
  createApiKeyRotateRouter(sql, auth, auth, signingEncKey),
  createApiKeyExpireRouter(sql),
  createApiKeyRevokeAllRouter(sql),
  createDeveloperKeysRouter({
    sql,
    gate: auth,
    kycTier: (userId, executor) => auth.kycTier(userId, executor),
    capByTier: parseApiKeyCapByTier(env.IDENTITY_API_KEYS_MAX_BY_TIER),
    mayMint: passkeyMintRule(sql),
  }),
  createGrantsRouter(sql),
  createSessionRevokeAllRouter(sql),
  createSessionRevokeRouter(sql),
  createSessionFamiliesRouter(sql),
  createListSessionsRouter(sql),
  createPanicRevokeRouter(sql),
  createApiKeyProductRouter(sql, auth, auth),
  createApiKeyAttributionRouter(auth),
  createDisableUserRouter(founderControls),
  createFounderControlsRouter(founderControls, customerDetails, accountLimits),
  createOperatorOpsRouter(sql),
  createPreferencesRouter(sql, {
    displayCurrencies: env.IDENTITY_DISPLAY_CURRENCIES,
    watchlists: {
      listCap: env.IDENTITY_WATCHLIST_LIST_CAP ?? null,
      symbolCap: env.IDENTITY_WATCHLIST_SYMBOL_CAP ?? null,
      savedScreenCap: env.IDENTITY_SAVED_SCREEN_CAP ?? null,
    },
  }),
  createMembershipRouter(env.IDENTITY_MEMBERSHIP_TIERS),
  createOAuthRouter(
    new OAuthService(sql, { codeTtlSeconds: env.OAUTH_CODE_TTL_SECONDS, accessTokenTtlSeconds: env.OAUTH_ACCESS_TOKEN_TTL_SECONDS }),
  ),
  createOperationIdentityRouter(new OperationIdentityDecisions(sql)),
  createAuthKeysRouter(authKeyRing, { isFounder: (userId) => founderControls.isLiveFounder(userId) }),
  createLimitFeeTierRouter(sql, rank, actionApprovals),
  createSavedRecipientsRouter(new SavedRecipientService(sql)),
  createOrgRouter(sql, dmaHierarchyLaw),
  createEnrollPasskeyRouter(
    sql,
    {
      rpId: env.WEBAUTHN_RP_ID,
      rpName: env.WEBAUTHN_RP_NAME,
      origin: env.WEBAUTHN_ORIGIN,
    },
    founderPair ?? [],
    { maxPerAccount: env.PASSKEY_MAX_PER_ACCOUNT },
  ),
  createVerifyPasskeyRouter(sql, {
    rpId: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    origin: env.WEBAUTHN_ORIGIN,
  }),
  createUnenrollPasskeyRouter(sql),
  createTotpLifecycleRouter(
    new TotpLifecycle({ sql, key: parseTotpSecretKey(env.IDENTITY_TOTP_SECRET_KEY), pending: new SqlPendingTotpEnrolmentStore(sql) }),
    securityStepUp,
  ),
  createPasskeyManageRouter(sql, securityStepUp, { maxPerAccount: env.PASSKEY_MAX_PER_ACCOUNT }),
  createFactorStatusRouter(sql),
  createSigninMethodsRouter(sql, securityStepUp, { wallet: auth.walletConfig(), social }),
  createWorkItemsRouter(sql),
  createServerTimeRouter(),
  createSelfFreezeLiftRouter(selfFreezeLift, securityStepUp),
  createSecurityLockRouter(securityLock, securityStepUp),
  createAccountStatusRouter(new AccountStatusDesk(sql, env.IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS)),
  createMfaResetRouter(auth),
  createSupportRecoveryRouter(() => auth.supportRecoveryDeps()),
  createTrustedDevicesRouter(auth, securityStepUp),
  createRecoveryKeysRouter(new RecoveryKeys(sql, securityStepUp, founderPair ?? [])),
  createDeathNoticesRouter(() => ({ sql, now: () => new Date() })),
  createActionApprovalRouter(actionApprovals, {
    privilegedUserIds: founderPair ?? [],
    // Fresh factor for money-out step-up: the same verification as `auth.stepUp`, token discarded.
    verifyFactor: async (input) => {
      await auth.stepUp(input);
    },
  }),
  createStepUpRouter(customerStepUp),
  createTradeIdentityAuthRouter(sql, {
    tokens: authKeyRing.tokenConfig({
      secret: env.JWT_ACCESS_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    }),
  }),
);
export type AppRouter = typeof appRouter;

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
  ...(doorS2s ? { serviceVerifier: doorS2s.verifier, s2sMode: doorS2s.mode } : {}),
  // The tRPC door has no v1 callers (every outbound client signs v2), so it is
  // `require` whatever INTERNAL_SERVICE_BODY_BIND says: that fleet knob exists
  // for the raw /internal routes that still need a migration window, and letting
  // it downgrade this door would re-open unbound-signature replay on
  // rank.awardXp and the other serviceProcedures.
  bodyBindMode: 'require',
});

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });
auth.useLogger(app.log);
selfFreezeLift.useLogger(app.log);
securityLock.useLogger(app.log);
account.useLog({
  warn(obj, msg) {
    app.log.warn(obj, msg);
  },
});

const refreshCookieOf = installRefreshCookieHooks(app);

app.addHook('onRequest', (req, _reply, done) => {
  const rawIp = req.headers['x-forwarded-for'] ?? req.headers['x-real-ip'];
  const forwarded = Array.isArray(rawIp) ? rawIp[0] : rawIp;
  const clientIp = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  const rawProduct = req.headers['x-product'];
  const productHeader = Array.isArray(rawProduct) ? rawProduct[0] : rawProduct;
  const clientProduct = typeof productHeader === 'string' ? productHeader.trim() : undefined;
  const rawAgent = req.headers['user-agent'];
  const userAgent = typeof rawAgent === 'string' ? rawAgent : undefined;
  requestIpAls.run(clientIp || undefined, () => {
    requestProductAls.run(clientProduct || undefined, () => requestMetaAls.run({ ip: clientIp || undefined, userAgent }, () => done()));
  });
});

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));
app.get('/ready', async () => ({
  ...identityReadyHonesty({
    kycDocKey: env.IDENTITY_KYC_DOC_KEY,
    ledgerUrl: env.LEDGER_URL,
    registrationOpen: env.REGISTRATION_OPEN,
    waitlistEnabled: env.INTAFACED_FLAG_WAITLIST_ENABLED,
    referralQueue: env.INTAFACED_FLAG_REFERRAL_QUEUE,
    launchDrop: env.LAUNCH_DROP,
  }),
  argon2: await argon2Available(),
  founderControls: founderControls.readiness(),
  operationAdmission: configuredIdentityOperationOwners({
    privateAuthoritySecret: env.IDENTITY_WS_AUTHORITY_SECRET,
    edgeAuthoritySecret: env.IDENTITY_EDGE_AUTHORITY_SECRET,
    secret: env.EDGE_PRINCIPAL_SECRET,
    serviceName: env.SERVICE_NAME,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    operationAdmissionSecrets: { 'svc-trade': env.IDENTITY_TRADE_ADMISSION_SECRET, 'svc-pay': env.IDENTITY_PAY_ADMISSION_SECRET },
  }),
}));

/**
 * D26-P1-O2: fee producers (svc-trade / svc-pay) accrue under owner rate law.
 * Same durable store as affiliates.accrue — no ledger post. Body-bound S2S.
 */
registerAffiliateProducerAccrue(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  referral,
  freeze,
  accruals,
  accrualTierLaw,
  activity: referralLapse,
});

registerBusinessDirectoryRoutes(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  store: sqlBusinessDirectory(sql),
  installRawBody: false,
});

// The own-name rule for svc-p2p's payout destinations (P-ads-merchant-18): only the outcome leaves identity.
registerHolderNameCheck(app, { internalSecret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s, details: customerDetails });

registerClosureFinalize(app, { secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s, closure });
registerAffiliateProducerPayout(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  freeze,
  accruals,
  accrualTierLaw,
  ledger,
  // Accrue already installed retainRawBody on this instance.
  installRawBody: false,
});

const navigatorSessionStore = createNavigatorSessionStore(sql);
// GET ownership/session follow compose. Navigator POST publish/refresh
// hardcode require — do not mill the fleet INTERNAL_SERVICE_BODY_BIND default.
registerNavigatorSessionRoutes(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  store: navigatorSessionStore,
  bodyBind: 'require',
  installRawBody: false,
});

/**
 * Service-to-service rank perks (svc-trade reads at order accept).
 * Authenticated by the shared service secret — same control as bank jobs (#62).
 * Previously unauthenticated (full audit L2-3).
 */
/**
 * The joint-restore position (OPS-ledger-desk-05). A read for svc-ops alone; any other service, or none, is refused.
 */
app.get('/internal/restore/watermark', async (req, reply) => {
  const caller = serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service;
  if (caller === null) return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  if (caller !== 'svc-ops') return reply.code(403).send({ error: 'caller not allowed', code: 'identity.caller_forbidden' });
  return readIdentityWatermark(sql);
});

app.get<{ Params: { userId: string } }>('/internal/rank/:userId/perks', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  return rank.perks(req.params.userId);
});

/**
 * Service-to-service sub-account ownership (svc-trade placeOrder gate).
 * Fail-closed at the caller: missing credentials → 401; unknown id → 404;
 * frozen → 423. A freeze read that throws answers 5xx, never 200.
 * Body is the published `subAccountOwnershipSchema` contract.
 */
app.get<{ Params: { subAccountId: string } }>('/internal/sub-accounts/:subAccountId', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const row = await auth.getSubAccountOwnership(req.params.subAccountId);
  if (!row) {
    return reply.code(404).send({ error: 'sub-account not found', code: 'identity.sub_account_not_found' });
  }
  const gated = await gateFrozenSubAccount(sql, row);
  if (gated.status !== 200) return reply.code(gated.status).send(gated.body);
  return gated.body;
});

/** Mail another service asks identity to send to a customer's own proved address (service-mail.ts). */
registerServiceMailRoute(app, {
  queue: (input) => auth.queueServiceMail(input),
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  bodyBind: env.INTERNAL_SERVICE_BODY_BIND,
  ...(doorS2s ? { s2s: doorS2s } : {}),
});

/** Whether a customer's trusted device can still be relied on, for a service that lets one device approve another's request. */
registerTrustedDeviceReadRoute(app, {
  read: (userId, deviceId) => auth.trustedDeviceState(userId, deviceId),
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  bodyBind: env.INTERNAL_SERVICE_BODY_BIND,
  ...(doorS2s ? { s2s: doorS2s } : {}),
});

/** Whether a recovery claim holds, for svc-bank before it sweeps a dead owner's trading balances to the heir (RC-identity-08). */
registerRecoveryClaimVerifyRoute(app, {
  verify: (input) => verifyRecoveryClaim(sql, input),
  estates: (heirUserId) => listRecoveryEstates(sql, heirUserId),
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  bodyBind: env.INTERNAL_SERVICE_BODY_BIND,
  ...(doorS2s ? { s2s: doorS2s } : {}),
});

/**
 * Service-to-service API key ownership (place gate).
 * Fail-closed at the caller: missing credentials → 401; unknown id → 404.
 * Body is the published `apiKeyOwnershipSchema` contract (no permission scopes).
 * Bind lists ride as extra JSON fields so WS/edge live-check can read them.
 */
registerApiKeyOwnershipRoute(app, {
  privateAuthoritySecret: env.IDENTITY_WS_AUTHORITY_SECRET,
  edgeAuthoritySecret: env.IDENTITY_EDGE_AUTHORITY_SECRET,
  operationAdmissionSecrets: { 'svc-trade': env.IDENTITY_TRADE_ADMISSION_SECRET, 'svc-pay': env.IDENTITY_PAY_ADMISSION_SECRET },
  door: placeDoor,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  bodyBind: env.INTERNAL_SERVICE_BODY_BIND,
  installRawBody: false,
});

/**
 * Service-to-service session ownership (place gate).
 * Fail-closed at the caller: missing credentials → 401; unknown id → 404.
 * Body is the published `sessionOwnershipSchema` contract (includes revoked:true).
 */
app.get<{ Params: { sessionId: string } }>('/internal/sessions/:sessionId', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const row = await placeDoor.getSessionOwnership(req.params.sessionId);
  if (!row) {
    return reply.code(404).send({ error: 'session not found', code: 'identity.session_not_found' });
  }
  return row;
});

/**
 * Service-to-service account state (svc-support's grounding read).
 *
 * Three fields — status and KYC tier — published as `accountStateSchema`. It is
 * an S2S route and not a `scopedProcedure` for the same reason `/internal/rank`
 * is: the caller is svc-support acting for an operator who is NOT the account
 * holder, and the tRPC surface would need a user principal svc-support does not
 * hold. Making identity accept "trust me, this is a support person" instead
 * would be granting an authority no scope defines.
 *
 * Unknown user → 404, which the caller renders as "not read". It must never
 * render as an account in good standing.
 */
app.get<{ Params: { userId: string } }>('/internal/account/:userId', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const state = await auth.accountState(req.params.userId);
  if (!state) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  return state;
});

/**
 * Who an account is for a campaign's participation rules (CM-eligibility-rules-01), `campaignParticipantSchema`:
 * account type, region, status and KYC tier. svc-campaigns reads it per check and keeps no copy. Service credentials
 * only. Unknown user → 404, which the caller refuses on, never reads as eligible.
 */
app.get<{ Params: { userId: string } }>('/internal/campaign-participant/:userId', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const participant = await auth.campaignParticipant(req.params.userId);
  if (!participant) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  return participant;
});

/**
 * Whether a user's current email is proved (RC-identity-01), `emailProofSchema`. svc-trade reads it per order and
 * refuses a new custodial order while it is `missing`. Service credentials only; no address in the answer.
 * Unknown user → 404, which the caller refuses on.
 */
app.get<{ Params: { userId: string } }>('/internal/email-proof/:userId', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const proof = await auth.emailProof(req.params.userId);
  if (!proof) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  return proof;
});

/**
 * The customer security lock (W-withdraw-09), `securityLockSchema`. A service that moves money out or changes a
 * withdrawal address reads it per request and refuses while `locked` is true; it keeps no copy. Service credentials only.
 * Unknown user → 404, which the caller refuses on. A read error is a 500, which the caller also refuses on.
 */
app.get<{ Params: { userId: string } }>('/internal/security-lock/:userId', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const userId = req.params.userId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  const view = await securityLock.read(userId);
  if (!view) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  return view;
});

/**
 * The limit override in force now for one customer, rail and asset (J-ops-console-04 #12), `accountLimitOverrideReadSchema`.
 * The service that enforces the limit reads it per request and keeps no copy; `override: null` means the base limit
 * applies. Service credentials only. A rail or asset identity does not recognise → 400 `identity.limit_query_invalid`; an
 * unknown user → 404. The caller refuses on either, never reads it as "none".
 */
app.get<{ Params: { userId: string }; Querystring: { rail?: string; assetId?: string } }>(
  '/internal/limit-override/:userId',
  async (req, reply) => {
    if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    const read = await accountLimits.overrideInForce(req.params.userId, req.query.rail ?? '', req.query.assetId ?? '');
    if (read === 'bad_query') {
      return reply.code(400).send({ error: 'rail or asset not recognised', code: 'identity.limit_query_invalid' });
    }
    if (read === 'not_found') {
      return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
    }
    return read;
  },
);

/**
 * Public handle for a user id. svc-bank snapshots it onto a personal-send receipt.
 * Service credentials only. 404 for an unknown id. Frozen and closed still have
 * a handle; the caller does not learn the status from this route.
 */
app.get<{ Params: { userId: string } }>('/internal/handle/:userId', async (req, reply) => {
  if (serviceOfRequest(req, env.INTERNAL_SERVICE_SECRET, env.INTERNAL_SERVICE_BODY_BIND, doorS2s).service === null) {
    return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
  }
  const userId = req.params.userId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  const handle = await auth.handleOf(userId);
  if (!handle) {
    return reply.code(404).send({ error: 'account not found', code: 'identity.account_not_found' });
  }
  return { userId, handle };
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => {
      // New POST authority reads require exact retained body bytes. Preserve the
      // full request for both factories; copying headers discards rawBodyOf.
      const base = identityRequestContext(req);
      // Origin for apiKeys.exchange domain_whitelist (edge-forwarded; not body).
      const raw = req.headers.origin ?? req.headers['x-forwarded-origin'];
      const clientOrigin = Array.isArray(raw) ? raw[0] : raw;
      const refreshCookie = refreshCookieOf(req) ?? null;
      return clientOrigin ? { ...base, clientOrigin, refreshCookie } : { ...base, refreshCookie };
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
});

// Each change to a sign-in factor leaves an outbox row in its own transaction (I-signin-sessions-08). The relay
// publishes them for the inbox notice, at least once; one run at a time, so the changes of an account keep their
// order. The factor-changed mails ride the mail outbox, drained after any run that found work, published or not.
let factorRelayRunning = false;
const relayFactorChanges = () => {
  if (factorRelayRunning) return;
  factorRelayRunning = true;
  void relaySecurityFactorEvents({ sql, bus, now: () => new Date() })
    .then((published) => {
      if (published > 0) drainRecoveryMail();
    })
    .catch((err) => {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'auth.factor_change_relay_failed');
      drainRecoveryMail();
    })
    .finally(() => {
      factorRelayRunning = false;
    });
};
setInterval(relayFactorChanges, 3_000).unref();
// Death notices (RC-identity-02) are published from their own rows, at least once; one run at a time.
let deathNoticeRelayRunning = false;
setInterval(() => {
  if (deathNoticeRelayRunning) return;
  deathNoticeRelayRunning = true;
  void relayDeathNoticeEvents({ sql, bus, now: () => new Date() })
    .catch((err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'identity.death_notice_relay_failed'))
    .finally(() => {
      deathNoticeRelayRunning = false;
    });
}, 3_000).unref();
// KYC case history (I-kyc-compliance-01): kycSubmitted and kycRejected from their own rows, at least once; one run at a time.
let kycCaseRelayRunning = false;
setInterval(() => {
  if (kycCaseRelayRunning) return;
  kycCaseRelayRunning = true;
  void relayKycCaseEvents({ sql, bus, now: () => new Date() })
    .catch((err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'identity.kyc_case_relay_failed'))
    .finally(() => {
      kycCaseRelayRunning = false;
    });
}, 3_000).unref();
await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  { port: env.HTTP_PORT, argon2: await argon2Available(), registrationOpen: env.REGISTRATION_OPEN, trpc: true },
  'svc-identity ready',
);

// Referral lapse sweep (CM-referral-01 RF-4). Off, with a status line saying why, while either owner value is blank.
app.log.info(lapseSweepStatusLine(referralLapsePeriodSeconds, referralLapseSweepSeconds));
let lapseSweep: Promise<unknown> | null = null;
let lapseTimer: NodeJS.Timeout | undefined;
if (referralLapsePeriodSeconds !== undefined && referralLapseSweepSeconds !== undefined) {
  lapseTimer = setInterval(() => {
    if (lapseSweep) return;
    lapseSweep = referralLapse
      .sweep()
      .then((ended) => {
        if (ended.length) app.log.info({ ended: ended.length }, 'referral.lapse_swept');
      })
      .catch((err) => app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'referral.lapse_sweep_failed'))
      .finally(() => {
        lapseSweep = null;
      });
  }, referralLapseSweepSeconds * 1000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      clearInterval(lapseTimer);
      await app.close();
      await lapseSweep;
      await Promise.all([...blueprintSubs, xpSub].map((s) => s.unsubscribe()));
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
