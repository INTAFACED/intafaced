import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, tstz, updatedAt } from '@intafaced/db';

/** Postgres bytea ↔ Buffer (KYC document ciphertext / nonce). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * IDENTITY (§4.1).
 *
 * "One account, one verification, one rank — the key that opens every room."
 *
 * The rank graph is the important part. Every module emits XP; this service is
 * the ONLY writer to rank_state; every module reads the perks table. That is
 * what makes an Academy certification raise a P2P limit without either module
 * knowing the other exists.
 */
export const identity = pgSchema('identity');

export const userStatusEnum = identity.enum('user_status', ['active', 'frozen', 'closed']);
export const kycTierEnum = identity.enum('kyc_tier', ['none', 'basic', 'full', 'institutional']);
export const kycStatusEnum = identity.enum('kyc_status', ['pending', 'approved', 'rejected', 'expired']);

export const users = identity.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    handle: citext('handle').notNull(),
    email: citext('email').notNull(),
    /** Null until the current address is confirmed. Cleared when the email changes. */
    emailVerifiedAt: tstz('email_verified_at'),
    /** argon2id. Never a fast hash — §9. */
    passwordHash: text('password_hash').notNull(),
    /**
     * TOTP shared secret, base32. Null until enrolled.
     * PII-adjacent: never logged, never returned by any API.
     */
    totpSecret: text('totp_secret'),
    totpEnrolledAt: tstz('totp_enrolled_at'),
    /**
     * Last TOTP counter that successfully authenticated (login / step-up / enrol confirm).
     * Null until first use. Replay of the same step is refused so a captured code
     * cannot be reused inside the ±1-step validity window.
     */
    totpLastStep: bigint('totp_last_step', { mode: 'bigint' }),
    /** SHA-256 hashes of single-use recovery codes; plaintext never stored. */
    recoveryCodeHashes: jsonb('recovery_code_hashes').notNull().default([]),

    /** WebAuthn credentials — array of {credentialId, publicKey, counter, ...}. */
    webauthnCreds: jsonb('webauthn_creds').notNull().default([]),
    /** The owner asked for a passkey after the password at sign-in (I-signin-sessions-10). Read only while a passkey exists. */
    passkeySecondStep: boolean('passkey_second_step').notNull().default(false),
    /** The owner signs in by a mailed code to the proved address (I-account-lifecycle-07). On unless they turned it off. */
    emailCodeSignin: boolean('email_code_signin').notNull().default(true),
    status: userStatusEnum('status').notNull().default('active'),
    identityControlVersion: bigint('identity_control_version', { mode: 'bigint' }).notNull().default(0n),
    /** Staff close reason code (0068). Null while open, and for a closure the customer finalised. */
    closedReason: text('closed_reason'),
    /** Closed while staff-frozen (0068): a reopen returns it frozen. */
    closedFromFrozen: boolean('closed_from_frozen').notNull().default(false),
    /** Staff archive of a closed account (J-ops-console-04 #10): set once with its reason code, never cleared. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archiveReason: text('archive_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_handle_idx').on(t.handle), uniqueIndex('users_email_idx').on(t.email)],
);

export const profiles = identity.table('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  /** trader | merchant | creator | student — a user can be several at once. */
  modes: text('modes').array().notNull().default([]),
  locale: text('locale').notNull().default('en'),
  /** ISO-3166 alpha-2. Drives JURISDICTION_MATRIX lookups. Customers do not set it. */
  region: text('region'),
  /** Compare-and-set token for profile.update. Existing rows start at 0. */
  version: integer('version').notNull().default(0),
  /** Set by svc-blueprint in Phase 4. Null until then. */
  blueprintId: uuid('blueprint_id'),
  updatedAt: updatedAt(),
});

export const kycRecords = identity.table(
  'kyc_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: kycTierEnum('tier').notNull(),
    /**
     * Opaque reference at the verification provider.
     *
     * §10 PII isolation: "KYC docs in separate encrypted store; services get
     * status flags, never documents." This column holds a pointer, never a
     * document, a name, or a date of birth.
     */
    providerRef: text('provider_ref'),
    jurisdiction: text('jurisdiction').notNull(),
    status: kycStatusEnum('status').notNull().default('pending'),
    /**
     * WHICH OPERATOR granted the tier.
     *
     * Approving a record grants access to every custodial module in the OS, so
     * "who did this" has to be answerable from the row itself rather than from a
     * log somebody has to still have. Deliberately not a foreign key to `users`:
     * an approval can arrive from an admin console service identity that is not
     * a platform account, and a constraint saying otherwise would be wrong the
     * first time that happens.
     */
    reviewedBy: text('reviewed_by'),
    reviewedAt: tstz('reviewed_at'),
    expiresAt: tstz('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('kyc_user_idx').on(t.userId, t.status),
    /** The operator queue: every record waiting on a human, oldest first. */
    index('kyc_pending_idx').on(t.status, t.createdAt),
  ],
);

/**
 * §10 encrypted document store — bytes never land on kyc_records.
 * Opaque id may be stored as kyc_records.provider_ref by operator tooling.
 */
export const kycDocuments = identity.table(
  'kyc_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    byteLength: integer('byte_length').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    keyId: text('key_id').notNull().default('v1'),
    /**
     * Operator (or tooling principal) who put the ciphertext.
     * Text not FK — same reason as kyc_records.reviewed_by: admin console
     * identities may not be platform users. Never holds document bytes.
     */
    storedBy: text('stored_by'),
    createdAt: createdAt(),
  },
  (t) => [index('kyc_documents_user_idx').on(t.userId, t.createdAt)],
);

/**
 * WebAuthn ceremony challenges — durable multi-pod store.
 * take() is single-use (DELETE). userId null when authentication target unknown.
 */
export const webauthnChallenges = identity.table(
  'webauthn_challenges',
  {
    challenge: text('challenge').primaryKey(),
    kind: text('kind').notNull(),
    userId: uuid('user_id'),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('webauthn_challenges_expires_idx').on(t.expiresAt)],
);

/**
 * Pending TOTP enrolment — durable multi-pod store (migration 0012).
 * secret_hash only (never base32 secret). takeIfSecretHash is single-use.
 */
export const totpPendingEnrolments = identity.table(
  'totp_pending_enrolments',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    secretHash: text('secret_hash').notNull(),
    recoveryCodeHashes: jsonb('recovery_code_hashes').notNull().default([]),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('totp_pending_enrolments_expires_idx').on(t.expiresAt)],
);

/**
 * The rank graph. svc-identity is the only writer.
 *
 * `xp` is a bigint count, not money — it never touches the ledger and is
 * deliberately not a decimal.
 */
export const rankState = identity.table('rank_state', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  rank: integer('rank').notNull().default(0),
  xp: bigint('xp', { mode: 'bigint' }).notNull().default(0n),
  seasonXp: bigint('season_xp', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: updatedAt(),
});

export const xpEvents = identity.table(
  'xp_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceModule: text('source_module').notNull(),
    action: text('action').notNull(),
    xpDelta: bigint('xp_delta', { mode: 'bigint' }).notNull(),
    meta: jsonb('meta').notNull().default({}),
    /**
     * Dedupe key. An award is a fact about something that happened once — a
     * certification, a completed P2P trade — so replaying the event must not
     * pay it twice (§10: consumers idempotent).
     */
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('xp_events_idempotency_idx').on(t.idempotencyKey), index('xp_events_user_idx').on(t.userId, t.id)],
);

/**
 * The machine-readable perk table other services query (§4.1).
 *
 * Deliberately data, not code: re-tuning what rank 7 is worth must never
 * require touching svc-trade.
 */
export const rankThresholds = identity.table('rank_thresholds', {
  rank: integer('rank').primaryKey(),
  xpRequired: bigint('xp_required', { mode: 'bigint' }).notNull(),
  title: text('title').notNull(),
  perks: jsonb('perks').notNull(),
});

export const sessions = identity.table(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque refresh token. The token itself is never stored. */
    refreshHash: text('refresh_hash').notNull(),
    device: text('device'),
    ip: text('ip'),
    /** One sign-in on one device: every row a refresh token rotates into shares it. */
    familyId: uuid('family_id').notNull().defaultRandom(),
    userAgent: text('user_agent'),
    /** Empty until a trusted geo source feeds it. */
    country: text('country'),
    /** True once this session has passed a second factor. */
    mfa: boolean('mfa').notNull().default(false),
    expiresAt: tstz('expires_at').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    /**
     * Set when a rotated token is reused — the signal that a refresh token was
     * stolen. Reuse detection is the entire point of rotating them.
     */
    reuseDetectedAt: tstz('reuse_detected_at'),
    /**
     * Set when this refresh token is rotated. A second presentation inside the
     * grace window reads `successorId` instead of burning the family.
     */
    rotatedAt: tstz('rotated_at'),
    successorId: uuid('successor_id'),
    /** AES-256-GCM (`enc:v1`) of the successor refresh token. Not the raw token. */
    successorRefresh: text('successor_refresh'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_refresh_idx').on(t.refreshHash), index('sessions_user_idx').on(t.userId, t.revoked)],
);

/**
 * One row per signed-out recovery request, known address or not. `subjectHash` is an HMAC of the
 * address; the address itself is never stored here.
 */
export const authFlows = identity.table(
  'auth_flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    subjectHash: text('subject_hash').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the mailed code. Null for a flow that carries no code. */
    codeHash: text('code_hash'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('auth_flows_subject_idx').on(t.subjectHash, t.kind, t.createdAt), index('auth_flows_user_open_idx').on(t.userId)],
);

/** The mail the relay sends. `code` and `handle` are cleared when the relay claims the row. */
export const mailOutbox = identity.table(
  'mail_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null only for a mail another service asked for (`POST /internal/mail`), which has its key and account instead. */
    flowId: uuid('flow_id').references(() => authFlows.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    recipient: text('recipient').notNull(),
    code: text('code'),
    handle: text('handle'),
    expiresAt: tstz('expires_at').notNull(),
    status: text('status').notNull(),
    createdAt: createdAt(),
    sentAt: tstz('sent_at'),
    userId: uuid('user_id'),
    dedupeKey: text('dedupe_key'),
    bodyHash: text('body_hash'),
    detail: text('detail'),
    /** Sends that threw. Only a security notice (password changed, second-step reset) is tried again, until this reaches `MAIL_RETRY_CAP`. */
    failedSends: integer('failed_sends').notNull().default(0),
    /** A retried notice waits until this time; null for every first try. */
    nextAttemptAt: tstz('next_attempt_at'),
  },
  (t) => [
    index('mail_outbox_pending_idx').on(t.createdAt),
    // Partial in the migration (WHERE dedupe_key IS NOT NULL); owner check: a flow, or a key, account and body hash.
    uniqueIndex('mail_outbox_dedupe_key_uq').on(t.dedupeKey),
  ],
);

/**
 * One-time signed-out password reset proofs. The code itself is never stored.
 */
export const passwordResetProofs = identity.table(
  'password_reset_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the mailed code. */
    codeHash: text('code_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('password_reset_proofs_code_hash_idx').on(t.codeHash), index('password_reset_proofs_user_open_idx').on(t.userId)],
);

/**
 * One-time email confirmation proofs. The token itself is never stored.
 * `email_hash` binds the proof to the address it was issued for.
 */
export const emailConfirmationProofs = identity.table(
  'email_confirmation_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    emailHash: text('email_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('email_confirmation_proofs_code_hash_idx').on(t.codeHash),
    index('email_confirmation_proofs_user_open_idx').on(t.userId),
  ],
);

export const emailConfirmationAttempts = identity.table(
  'email_confirmation_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('email_confirmation_attempts_user_created_idx').on(t.userId, t.createdAt)],
);

/** Requested, confirmed, or refused. No token, code, or link column. */
export const emailConfirmationAudit = identity.table(
  'email_confirmation_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    reason: text('reason').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('email_confirmation_audit_user_idx').on(t.userId, t.createdAt)],
);

export const apiKeys = identity.table(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** SHA-256 of the key. Shown once at creation, never retrievable. */
    keyHash: text('key_hash').notNull(),
    /** Leading chars, for the UI to show which key is which. */
    keyPrefix: text('key_prefix').notNull(),
    scopes: text('scopes').array().notNull(),
    domainWhitelist: text('domain_whitelist').array().notNull().default([]),
    ipAllowlist: text('ip_allowlist').array().notNull().default([]),
    /**
     * Bound sub-account. Null = legacy unbound (exchange still user-wide).
     * Mint/bind requires this id; auth that names another account refuses.
     */
    accountId: uuid('account_id'),
    /**
     * Product/module list (M05-R06). Empty = unset (full grantor intersection,
     * no default product). Non-empty: exchange/use outside the list refuses.
     */
    productScopes: text('product_scopes').array().notNull().default([]),
    /**
     * `live` | `sandbox` — pay.public-api step 4 (ADR 2026-08-07 §2.5).
     * Minted into the short access token as `key_env`. Default live.
     */
    mode: text('mode').notNull().default('live'),
    /** Opt-in inbound HMAC. Default false: unsigned calls stay accepted. */
    requireSignature: boolean('require_signature').notNull().default(false),
    /** When true, an empty IP allowlist refuses. Default false keeps empty = open. */
    requireNonEmptyIpAllowlist: boolean('require_non_empty_ip_allowlist').notNull().default(false),
    /** HMAC key. Shown once when signature is turned on. Never listed. */
    requestSigningSecret: text('request_signing_secret'),
    lastUsedAt: tstz('last_used_at'),
    expiresAt: tstz('expires_at'),
    revoked: boolean('revoked').notNull().default(false),
    /** When and why the key was revoked (owner, account_freeze, operator, account_closed, support, system); null while live. */
    revokedAt: tstz('revoked_at'),
    revokedCause: text('revoked_cause'),
    /** The person's own words when they revoked it; never an operator's note. */
    revokeReason: text('revoke_reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_idx').on(t.keyHash), index('api_keys_user_idx').on(t.userId, t.revoked)],
);

/**
 * Sub-accounts — strategies, teams, funds (§4.1).
 *
 * Ledger-visible: the ledger's `subaccount` owner type keys on this id, so a
 * sub-account has genuinely separate balances rather than a UI filter.
 *
 * Soft-disable via `revoked` only — never hard-delete. Destroying the row
 * would orphan ledger accounts keyed on this id. Revoke does not move value
 * (identity holds no balances; see bank.spaces.archive for the same rule).
 *
 * `frozen` is the Bybit sub-uid flag: 0 active, 1 paused. Same id both ways.
 * It is not revoke.
 */
export const subAccounts = identity.table(
  'sub_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    purpose: text('purpose'),
    revoked: boolean('revoked').notNull().default(false),
    /** 0 active, 1 paused. Same id. Not revoke. */
    frozen: integer('frozen').notNull().default(0),
    /** standard | managed | derivatives | spot. Set at create, never changes. */
    kind: text('kind').notNull().default('standard'),
    /** 5 to 20 letters or digits, unique per main account, never changes. Null on rows made before it existed. */
    nickname: text('nickname'),
    createdAt: createdAt(),
  },
  (t) => [index('sub_accounts_parent_idx').on(t.parentUserId), index('sub_accounts_parent_revoked_idx').on(t.parentUserId, t.revoked)],
);

/**
 * Drop 0 tease waitlist — email capture + FIFO referral queue.
 * Not the affiliate tree (`referral_edges`). No rewards column on purpose.
 */
export const waitlistEntries = identity.table(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    referralCode: text('referral_code').notNull(),
    referredBy: text('referred_by'),
    position: bigserial('position', { mode: 'number' }).notNull(),
    referredCount: integer('referred_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('waitlist_entries_email_idx').on(t.email),
    uniqueIndex('waitlist_entries_code_idx').on(t.referralCode),
    uniqueIndex('waitlist_entries_position_idx').on(t.position),
    index('waitlist_entries_referred_by_idx').on(t.referredBy),
  ],
);

/**
 * Organizations + membership (M01).
 *
 * Named membership boundary only. No balance, no KYC shortcut.
 * Roles: admin / trader / auditor / risk-manager.
 * Membership in one org cannot act as another. Admin grant is four-eyes.
 */
export const organizations = identity.table(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('organizations_created_by_idx').on(t.createdBy)],
);

export const actionApprovals = identity.table(
  'action_approvals',
  {
    approvalId: text('approval_id').primaryKey(),
    actionType: text('action_type').notNull(),
    targetService: text('target_service').notNull(),
    targetId: text('target_id').notNull(),
    expectedVersion: text('expected_version').notNull(),
    payloadHash: text('payload_hash').notNull(),
    requesterId: text('requester_id').notNull(),
    approverId: text('approver_id'),
    policyVersion: text('policy_version').notNull(),
    operationId: text('operation_id').notNull(),
    status: text('status').notNull(),
    createdAt: tstz('created_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    approvedAt: tstz('approved_at'),
    consumedAt: tstz('consumed_at'),
    /** `four_eyes` (default) or `same_person` money-out step-up (migration 0028). */
    kind: text('kind').notNull().default('four_eyes'),
    /** Session a same_person approval is bound to; null for four_eyes. */
    sessionId: text('session_id'),
    consumedByService: text('consumed_by_service'),
    consumedByPrincipal: text('consumed_by_principal'),
    consumedRequestId: text('consumed_request_id'),
  },
  (t) => [
    uniqueIndex('action_approvals_operation_idx').on(t.operationId),
    index('action_approvals_status_exp_idx').on(t.status, t.expiresAt),
  ],
);

export const organizationMembers = identity.table(
  'organization_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('organization_members_pk').on(t.orgId, t.userId), index('organization_members_user_idx').on(t.userId)],
);

/** Which product tier an account is on (J-ops-console-04 #11); the tiers themselves are the IDENTITY_ACCOUNT_TIERS owner setting. */
export const accountTierAssignments = identity.table('account_tier_assignments', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  tierId: text('tier_id').notNull(),
  version: bigint('version', { mode: 'bigint' }).notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

/**
 * A closure request. The SQL migration owns the one-open partial unique index.
 * Closing does not remove this row, the user, or any ledger history.
 */
export const accountClosures = identity.table('account_closures', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  status: text('status').notNull(),
  requestedAt: tstz('requested_at').notNull(),
  effectiveAt: tstz('effective_at').notNull(),
  finalizedAt: tstz('finalized_at'),
  blockers: jsonb('blockers').notNull(),
  clientRequestId: text('client_request_id').notNull(),
});

/**
 * A customer's staff-edited personal details (J-ops-console-04 #9), one encrypted JSON document under the KYC document
 * key. Protected details change only through `customerDetailReviews`; the migration owns the one-open index.
 */
export const customerDetails = identity.table('customer_details', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  version: bigint('version', { mode: 'bigint' }).notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  keyId: text('key_id').notNull().default('v1'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
});

export const customerDetailReviews = identity.table('customer_detail_reviews', {
  reviewId: uuid('review_id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  fields: text('fields').array().notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  keyId: text('key_id').notNull().default('v1'),
  documentIds: uuid('document_ids').array().notNull(),
  reason: text('reason').notNull(),
  requestedBy: uuid('requested_by').notNull(),
  requestedAt: tstz('requested_at').notNull(),
  decidedBy: uuid('decided_by'),
  decidedAt: tstz('decided_at'),
  decisionNote: text('decision_note'),
});

/** Append-only: every edit or decision attempt, with field names but no values. */
export const customerDetailEvents = identity.table('customer_detail_events', {
  auditId: uuid('audit_id').primaryKey(),
  requestId: uuid('request_id').notNull(),
  actorId: uuid('actor_id'),
  userId: uuid('user_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  result: jsonb('result').notNull(),
  stored: boolean('stored').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

/**
 * A customer's temporary override of one rail's limit figures for one asset (J-ops-console-04 #12), one row per rail and
 * asset, replaced on each set. The base limits stay with the service that enforces them; the migration owns the CHECKs.
 */
export const accountLimitOverrides = identity.table(
  'account_limit_overrides',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rail: text('rail').notNull(),
    assetId: text('asset_id').notNull(),
    version: bigint('version', { mode: 'bigint' }).notNull(),
    perTx: text('per_tx'),
    rolling24h: text('rolling_24h'),
    expiresAt: tstz('expires_at').notNull(),
    setBy: uuid('set_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvalId: text('approval_id'),
    setAt: tstz('set_at').notNull(),
    reason: text('reason').notNull(),
    clearedBy: uuid('cleared_by'),
    clearedAt: tstz('cleared_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.rail, t.assetId] })],
);

/** Append-only: every set or clear attempt on a customer's limit overrides. */
export const accountLimitEvents = identity.table('account_limit_events', {
  auditId: uuid('audit_id').primaryKey(),
  requestId: uuid('request_id').notNull(),
  actorId: uuid('actor_id'),
  userId: uuid('user_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  result: jsonb('result').notNull(),
  stored: boolean('stored').notNull(),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

export const schema = {
  users,
  accountLimitOverrides,
  accountLimitEvents,
  accountClosures,
  customerDetails,
  customerDetailReviews,
  customerDetailEvents,
  profiles,
  kycRecords,
  rankState,
  xpEvents,
  rankThresholds,
  sessions,
  passwordResetProofs,
  authFlows,
  mailOutbox,
  emailConfirmationProofs,
  emailConfirmationAttempts,
  emailConfirmationAudit,
  apiKeys,
  subAccounts,
  waitlistEntries,
  organizations,
  organizationMembers,
  actionApprovals,
};
