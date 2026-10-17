import type { Sql } from 'postgres';
import { changeHashesEqual, founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { payActionPayloadHash } from './action-approval-consume.js';
import type { MerchantAddress } from './merchant-portal/fields.js';

/**
 * Canonical payload for a KYB approval.
 *
 * `merchant.decideKyb` and `kyb.decide` consume with this hash. The proposal
 * filed with identity is the same hash: `kybDecisionPayloadHash` of these
 * fields. They are the decision and a hash of legal name, address, statement
 * descriptor, and industry. Profile version is not part of the binding:
 * identity cannot change while KYB is pending, and a website or support-email
 * edit must not invalidate an approval. An approval reviewed against an older
 * identity does not match, so it is not consumed.
 */
export const PAY_MERCHANT_DECIDE_KYB = 'pay.merchant_decide_kyb';
export const PAY_KYB_DECIDE = 'pay.kyb_decide';

export interface KybIdentity {
  legalName: string | null;
  address: MerchantAddress | null;
  statementDescriptor: string | null;
  industry: string | null;
}

export interface KybDecisionBinding {
  merchantId: string;
  identity: KybIdentity;
  identityHash: string;
  fields(decision: 'approved' | 'rejected'): Record<string, string>;
}

interface IdentityRow {
  legal_name: string | null;
  statement_descriptor: string | null;
  industry: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country: string | null;
}

/** Same empty-address rule as the business profile read: no line1 means no address. */
function addressOf(row: IdentityRow): MerchantAddress | null {
  if (row.address_line1 === null) return null;
  return {
    line1: row.address_line1,
    line2: row.address_line2,
    city: row.address_city ?? '',
    region: row.address_region,
    postalCode: row.address_postal_code ?? '',
    country: row.address_country ?? '',
  };
}

export function kybIdentityOf(row: IdentityRow): KybIdentity {
  return {
    legalName: row.legal_name,
    address: addressOf(row),
    statementDescriptor: row.statement_descriptor,
    industry: row.industry,
  };
}

/** Hash of the identity a KYB reviewer was shown. Not a profile version. */
export function kybIdentityHash(identity: KybIdentity): string {
  return founderChangeHash(
    {
      kind: 'merchant_kyb_identity',
      legalName: identity.legalName,
      address: identity.address,
      statementDescriptor: identity.statementDescriptor,
      industry: identity.industry,
    },
    '1',
  );
}

/**
 * Field order is part of the hash. Proposal and consume both call this, so a
 * hand-built object with different key order cannot approve a different identity.
 */
export function kybDecisionFields(input: {
  merchantId: string;
  decision: 'approved' | 'rejected';
  identityHash: string;
}): Record<string, string> {
  return {
    decision: input.decision,
    identityHash: input.identityHash,
    merchantId: input.merchantId,
  };
}

/**
 * What a proposer files with identity, and what consume hashes.
 *
 * `merchant.decideKyb` omits `reason`. `kyb.decide` appends it, so a different
 * reason is a different approval. Both routers call this; a hand-built object
 * is not a second proposal shape.
 */
export function kybApprovalFields(input: {
  merchantId: string;
  decision: 'approved' | 'rejected';
  identityHash: string;
  reason?: string;
}): Record<string, string> {
  const fields = kybDecisionFields(input);
  if (input.reason === undefined) return fields;
  return { ...fields, reason: input.reason };
}

export function kybDecisionPayloadHash(actionType: string, fields: Record<string, string>): string {
  return payActionPayloadHash(actionType, fields);
}

export function kybBindingMatches(live: { identityHash: string }, expected: { identityHash: string }): boolean {
  return changeHashesEqual(live.identityHash, expected.identityHash);
}

/** Wire view of a binding: the identity fields the hash covers, and the hash. */
export function kybDecisionBindingView(binding: KybDecisionBinding): {
  merchantId: string;
  legalName: string | null;
  address: KybIdentity['address'];
  statementDescriptor: string | null;
  industry: string | null;
  identityHash: string;
} {
  return {
    merchantId: binding.merchantId,
    legalName: binding.identity.legalName,
    address: binding.identity.address,
    statementDescriptor: binding.identity.statementDescriptor,
    industry: binding.identity.industry,
    identityHash: binding.identityHash,
  };
}

export async function loadKybDecisionBinding(sql: Sql, merchantId: string): Promise<KybDecisionBinding | null> {
  const rows = await sql<IdentityRow[]>`
    SELECT legal_name, statement_descriptor, industry,
           address_line1, address_line2, address_city, address_region,
           address_postal_code, address_country
      FROM pay.merchants
     WHERE id = ${merchantId}`;
  const row = rows[0];
  if (!row) return null;
  const identity = kybIdentityOf(row);
  const identityHash = kybIdentityHash(identity);
  return {
    merchantId,
    identity,
    identityHash,
    fields(decision) {
      return kybApprovalFields({ merchantId, decision, identityHash });
    },
  };
}
