import { bigint, bigserial, integer, jsonb, text, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { amount, createdAt, tstz } from '@intafaced/db';
import { pay, merchants, settlements } from './schema.js';
/** Pay-owned control/intent declarations; SQL enforces append-only records. Amount is an original instruction, never a balance. */
export const accountControlAudit = pay.table(
  'account_control_audit',
  {
    id: uuid('id').primaryKey(),
    sequence: bigserial('sequence', { mode: 'bigint' }).notNull().unique(),
    requestId: uuid('request_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    merchantId: uuid('merchant_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    result: jsonb('result').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('pay_account_control_history').on(t.merchantId, t.sequence)],
);
export const accountControlRequests = pay.table('account_control_requests', {
  requestId: uuid('request_id').primaryKey(),
  actorKey: text('actor_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  result: jsonb('result').notNull(),
});
export const payoutAdmissions = pay.table(
  'payout_admissions',
  {
    id: uuid('id').primaryKey(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    merchantUserId: uuid('merchant_user_id').notNull(),
    attempt: integer('attempt').notNull(),
    businessId: text('business_id').notNull().unique(),
    net: amount('net').notNull(),
    assetId: text('asset_id').notNull(),
    railId: text('rail_id').notNull(),
    destinationKind: text('destination_kind').notNull(),
    destinationRef: text('destination_ref').notNull(),
    window: text('window').notNull(),
    admittedAt: tstz('admitted_at').notNull().defaultNow(),
    merchantControlVersion: bigint('merchant_control_version', { mode: 'bigint' }).notNull(),
    identityIntent: jsonb('identity_intent'),
  },
  (t) => [uniqueIndex('payout_admissions_settlement_attempt').on(t.settlementId, t.attempt)],
);
export const payoutOutcomes = pay.table(
  'payout_outcomes',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => payoutAdmissions.id),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payout_outcomes_admission_kind').on(t.admissionId, t.kind),
    uniqueIndex('pay_payout_identity_terminal')
      .on(t.admissionId)
      .where(sql`${t.kind} IN('identity_granted','identity_cancelled')`),
    uniqueIndex('pay_payout_rail_terminal')
      .on(t.admissionId)
      .where(sql`${t.kind} IN('rail_accepted','rail_refused')`),
  ],
);
export const paymentAdmissions = pay.table('payment_admissions', {
  businessId: text('business_id').primaryKey(),
  paymentId: uuid('payment_id').notNull(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id),
  merchantControlVersion: bigint('merchant_control_version', { mode: 'bigint' }).notNull(),
  intent: jsonb('intent').notNull(),
  payload: jsonb('payload').notNull(),
  preparedAt: tstz('prepared_at').notNull().defaultNow(),
});
export const paymentAdmissionOutcomes = pay.table(
  'payment_admission_outcomes',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    businessId: text('business_id')
      .notNull()
      .references(() => paymentAdmissions.businessId),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_admission_outcomes_business_kind').on(t.businessId, t.kind),
    uniqueIndex('pay_payment_identity_terminal')
      .on(t.businessId)
      .where(sql`${t.kind} IN('identity_granted','identity_cancelled')`),
  ],
);
