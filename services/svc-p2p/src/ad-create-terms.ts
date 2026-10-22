/**
 * Ad create with advertiser terms (P-ads-merchant-01, p2p-ads-merchant-001/-021).
 *
 * Pure rules only. The router procedures (`offers.createWithTerms`,
 * `merchants.acceptAdvertiserTerms`) and the terms tables are not wired yet:
 * a new procedure must first be added to the existing leak sweep, which is an
 * existing-test edit and waits for an exception.
 *
 * Fail-closed throughout: a blank published terms version refuses
 * `p2p.config_unset`; a missing or stale acceptance refuses
 * `p2p.terms_not_accepted`; an unreadable balance refuses rather than passes.
 *
 * The balance check is ADVISORY. It reserves nothing: escrow still locks per
 * trade at take, and a take can still refuse for insufficient balance.
 */

import { compare, parseAmount } from '@intafaced/ledger-client';

export type AdCreateTermsCode =
  | 'p2p.config_unset'
  | 'p2p.terms_not_accepted'
  | 'p2p.insufficient_balance'
  /** A non-string or blank id/version, or a zero/unparseable ad total. */
  | 'p2p.invalid_input';

export class AdCreateTermsError extends Error {
  constructor(
    message: string,
    readonly code: AdCreateTermsCode,
    readonly available?: string,
  ) {
    super(message);
    this.name = 'AdCreateTermsError';
  }
}

/** The published advertiser terms version, or refuse when the owner has not set one. */
export function requirePublishedTermsVersion(published: string | null | undefined): string {
  const v = typeof published === 'string' ? published.trim() : '';
  if (!v) throw new AdCreateTermsError('Advertiser terms are not configured.', 'p2p.config_unset');
  return v;
}

/**
 * The maker must have accepted exactly the current published version, and the
 * request must name that same version (terms are frozen at post).
 */
function invalidInput(): AdCreateTermsError {
  return new AdCreateTermsError('Request input is invalid.', 'p2p.invalid_input');
}

export function assertTermsAccepted(input: {
  published: string | null | undefined;
  requested: string;
  acceptedVersions: readonly string[];
}): string {
  if (typeof input.requested !== 'string' || !Array.isArray(input.acceptedVersions)) throw invalidInput();
  const current = requirePublishedTermsVersion(input.published);
  if (input.requested.trim() !== current || !input.acceptedVersions.includes(current)) {
    throw new AdCreateTermsError('Accept the current advertiser terms first.', 'p2p.terms_not_accepted');
  }
  return current;
}

/** Business idempotency key: a retry after a crash returns the same ad. */
export function offerCreateIdempotencyKey(userId: string, clientRequestId: string): string {
  if (typeof userId !== 'string' || typeof clientRequestId !== 'string') throw invalidInput();
  const u = userId.trim();
  const c = clientRequestId.trim();
  if (!u || !c) throw invalidInput();
  return `p2p:offer-create:${u}:${c}`;
}

/**
 * Advisory: the ad total must not exceed the ledger available balance.
 * Exact decimal strings only; anything unparseable refuses.
 */
export function assertAdvisoryBalance(total: string, available: string | null | undefined): void {
  if (typeof total !== 'string' || !/^\d+(\.\d+)?$/.test(total)) throw invalidInput();
  if (!/[1-9]/.test(total)) throw invalidInput();
  if (typeof available !== 'string' || !/^\d+(\.\d+)?$/.test(available) || !/^\d+(\.\d+)?$/.test(total)) {
    throw new AdCreateTermsError('Available balance could not be read.', 'p2p.insufficient_balance', '0');
  }
  let over: boolean;
  try {
    over = compare(parseAmount(total), parseAmount(available)) > 0;
  } catch {
    throw new AdCreateTermsError('Available balance could not be read.', 'p2p.insufficient_balance', '0');
  }
  if (over) {
    throw new AdCreateTermsError('Total is above your available balance.', 'p2p.insufficient_balance', available);
  }
}
