import { boolean, integer, numeric, pgSchema, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * PROTOCOL — a read model, and nothing else (§17.5).
 *
 * Everything in this schema is derived from chain state. The chain is the
 * record; these tables exist so `apps/web` can render "your account" without a
 * dozen RPC round trips, and so a user id can be resolved to an address.
 *
 * What is deliberately NOT here, and must never be added:
 *
 *   · any balance, or anything that could be read as one. A user's holdings are
 *     in their account on chain, at an address anyone can query. This service
 *     does not know what they own and has no reason to
 *   · `spent_wei` for a session key. It is a running total and it lives on
 *     chain, where it is enforced. Caching it here would create a number that
 *     could disagree with the one that matters
 *   · any key material, of any kind
 *
 * Doctrine §0.6 and §16.9: no module holds its own balance, and on this plane
 * no module holds anything at all.
 */
export const protocol = pgSchema('protocol');

export const smartAccounts = protocol.table(
  'smart_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** svc-identity's user id. The mapping is the whole point of this table. */
    userId: uuid('user_id').notNull(),
    chainId: integer('chain_id').notNull(),
    /** Checksummed EVM address. Known before deployment (CREATE2). */
    address: text('address').notNull(),
    /** The user's key. An EOA, or a P-256 verifier contract for a passkey. */
    owner: text('owner').notNull(),
    /** 32-byte hex. Lets one owner hold several named accounts (§23). */
    userSalt: text('user_salt').notNull(),
    /** False for a predicted address that has not been deployed yet. */
    deployed: boolean('deployed').notNull().default(false),
    deployedAt: tstz('deployed_at'),
    /**
     * The user proved control of `owner` by signing this service's binding
     * message. Without it the row is a claim, not a fact.
     */
    verifiedAt: tstz('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('smart_accounts_chain_address_idx').on(t.chainId, t.address),
    uniqueIndex('smart_accounts_owner_salt_idx').on(t.chainId, t.owner, t.userSalt),
  ],
);

export const sessionKeys = protocol.table(
  'session_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => smartAccounts.id, { onDelete: 'cascade' }),
    /** The delegated signer. Held by an agent or a device — never by us. */
    sessionKey: text('session_key').notNull(),
    /** keccak256 of the full scope. The commitment the account stores. */
    specHash: text('spec_hash').notNull(),
    validAfter: tstz('valid_after').notNull(),
    validUntil: tstz('valid_until').notNull(),
    /**
     * A CAP, not a balance: the most this session may ever move, in wei,
     * as a decimal string. Enforced on chain, mirrored here for display.
     */
    spendLimitWei: numeric('spend_limit_wei', { precision: 78, scale: 0 }).notNull(),
    targets: text('targets').array().notNull().default([]),
    selectors: text('selectors').array().notNull().default([]),
    /** Mirrors the on-chain flag. The chain decides; this catches up. */
    revoked: boolean('revoked').notNull().default(false),
    revokedAt: tstz('revoked_at'),
    grantedTxHash: text('granted_tx_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('session_keys_account_key_hash_idx').on(t.accountId, t.sessionKey, t.specHash)],
);

/**
 * Which pool or market INTAFACED does not list, and the signed decisions behind it (D-order-controls-04). A LISTING
 * decision, not an on-chain pause. No balance and no key lives here.
 */
export const listingOverrides = protocol.table(
  'listing_overrides',
  {
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    state: text('state').notNull(),
    reasonCode: text('reason_code'),
    reason: text('reason'),
    approvalId: text('approval_id').notNull(),
    policyVersion: text('policy_version').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.targetId] })],
);

export const listingDecisions = protocol.table('listing_decisions', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  action: text('action').notNull(),
  kind: text('kind').notNull(),
  targetId: text('target_id').notNull(),
  outcome: text('outcome').notNull(),
  note: text('note'),
  reasonCode: text('reason_code'),
  reason: text('reason'),
  approvalId: text('approval_id').notNull(),
  requesterId: text('requester_id').notNull(),
  approverId: text('approver_id').notNull(),
  policyVersion: text('policy_version').notNull(),
  decidedAt: tstz('decided_at').notNull().defaultNow(),
});

export type SmartAccountRow = typeof smartAccounts.$inferSelect;
export type SessionKeyRow = typeof sessionKeys.$inferSelect;
