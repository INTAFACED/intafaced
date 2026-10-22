import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
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
    status: userStatusEnum('status').notNull().default('active'),
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
  /** ISO-3166 alpha-2. Drives JURISDICTION_MATRIX lookups. */
  region: text('region'),
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
    /** True once this session has passed a second factor. */
    mfa: boolean('mfa').notNull().default(false),
    expiresAt: tstz('expires_at').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    /**
     * Set when a rotated token is reused — the signal that a refresh token was
     * stolen. Reuse detection is the entire point of rotating them.
     */
    reuseDetectedAt: tstz('reuse_detected_at'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_refresh_idx').on(t.refreshHash), index('sessions_user_idx').on(t.userId, t.revoked)],
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
     * `live` | `sandbox` — pay.public-api step 4 (ADR 2026-08-07 §2.5).
     * Minted into the short access token as `key_env`. Default live.
     */
    mode: text('mode').notNull().default('live'),
    lastUsedAt: tstz('last_used_at'),
    expiresAt: tstz('expires_at'),
    revoked: boolean('revoked').notNull().default(false),
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

export const schema = { users, profiles, kycRecords, rankState, xpEvents, rankThresholds, sessions, apiKeys, subAccounts, waitlistEntries };
