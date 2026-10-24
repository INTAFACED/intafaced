import type { Sql } from 'postgres';
import type { MerchantTermsState } from '@intafaced/contracts';
import { merchantNotFound } from '../merchant-ownership.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { SHUT } from '../owner-pay-grant-recheck.js';
import { PayError, type PayService } from '../payment-service.js';
import { PortalError } from './errors.js';

/**
 * The merchant terms of service a business accepts before it goes live (J-merchant-02, M-plat-org-13).
 *
 * The version and where to read it are owner settings with NO DEFAULT: `PAY_MERCHANT_TERMS_VERSION` and
 * `PAY_MERCHANT_TERMS_URL`. Blank, both of them, means no terms are published: progress says `not_configured` and an
 * acceptance is refused with `pay.merchant_terms_unset`. Setting only one of them, or a malformed one, refuses to boot.
 * Never invent a version: the text is a legal document the owner publishes. A version labelled TEST (the local test
 * stack's) is honoured only when APP_ENV is exactly `dev` or `test`, so a TEST placeholder never reaches a merchant.
 */
export const TERMS_VERSION_ENV = 'PAY_MERCHANT_TERMS_VERSION';
export const TERMS_URL_ENV = 'PAY_MERCHANT_TERMS_URL';

export interface MerchantTermsConfig {
  readonly version: string;
  readonly url: string;
}

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

export function readMerchantTerms(env: Record<string, string | undefined>): MerchantTermsConfig | null {
  const version = env[TERMS_VERSION_ENV]?.trim() ?? '';
  const url = env[TERMS_URL_ENV]?.trim() ?? '';
  if (!version && !url) return null;
  if (!version || !url) throw new Error(`${TERMS_VERSION_ENV} and ${TERMS_URL_ENV} are set together or not at all. Refusing to boot.`);
  if (!VERSION.test(version))
    throw new Error(`${TERMS_VERSION_ENV} must be 1 to 64 letters, digits, dots, dashes or underscores. Refusing to boot.`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${TERMS_URL_ENV} must be an absolute URL. Refusing to boot.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${TERMS_URL_ENV} must be an https URL. Refusing to boot.`);
  if (/^test/i.test(version) && env.APP_ENV !== 'dev' && env.APP_ENV !== 'test')
    throw new Error(
      `${TERMS_VERSION_ENV} is a TEST version but APP_ENV=${env.APP_ENV ?? '(unset)'} is not the local test stack (APP_ENV must be exactly "dev" or "test"). Refusing to boot.`,
    );
  return { version, url };
}

interface AcceptedRow {
  version: string;
  terms_url: string;
  accepted_at: Date;
}

/** Where this business stands on the published terms. Callers fence the read first. */
export async function readTermsState(sql: Sql, config: MerchantTermsConfig | null, merchantId: string): Promise<MerchantTermsState> {
  if (!config) return { state: 'not_configured' };
  const rows = await sql<AcceptedRow[]>`
    SELECT version, terms_url, accepted_at FROM pay.merchant_terms_acceptances
     WHERE merchant_id = ${merchantId} AND version = ${config.version}`;
  const row = rows[0];
  if (!row) return { state: 'not_accepted', version: config.version, url: config.url };
  // The address recorded with the acceptance, so the record points at the document that was read, even if the setting moves.
  return { state: 'accepted', version: row.version, url: row.terms_url, acceptedAt: row.accepted_at.toISOString() };
}

/**
 * The owner accepts the published version they were shown. Only the owner signs for the business: a team member is
 * refused by role, anyone else as not found. A suspended or closed business accepts nothing. Accepting the same
 * version again answers the first acceptance, so a retry never writes a second row.
 */
export async function acceptTerms(
  deps: { sql: Sql; pay: Pick<PayService, 'getMerchant'>; team: MerchantTeamRead; config: MerchantTermsConfig | null },
  writer: { userId: string; scope: 'pay:write' | 'pay:onboard' },
  input: { merchantId: string; version: string },
): Promise<{ merchantId: string; version: string; acceptedAt: string }> {
  const merchant = await deps.pay.getMerchant(input.merchantId).catch((err: unknown) => {
    if (err instanceof PayError && err.code === 'pay.merchant_not_found') return null;
    throw err;
  });
  if (!merchant) throw merchantNotFound(input.merchantId);
  if (merchant.userId !== writer.userId) {
    if (await deps.team.activeRole(writer.userId, input.merchantId)) throw new PortalError('pay.team_role_forbidden', 'forbidden');
    throw merchantNotFound(input.merchantId);
  }
  if (SHUT.has(merchant.status)) throw new PortalError('pay.owner_grant_withdrawn', 'forbidden');
  if (!deps.config) throw new PortalError('pay.merchant_terms_unset', 'precondition');
  if (input.version !== deps.config.version) throw new PortalError('pay.merchant_terms_version_stale', 'conflict');
  await deps.sql`
    INSERT INTO pay.merchant_terms_acceptances (merchant_id, version, terms_url, accepted_by, actor_scope)
    VALUES (${input.merchantId}, ${input.version}, ${deps.config.url}, ${writer.userId}, ${writer.scope})
    ON CONFLICT (merchant_id, version) DO NOTHING`;
  const state = await readTermsState(deps.sql, deps.config, input.merchantId);
  if (state.state !== 'accepted') throw new Error('merchant terms acceptance was not recorded');
  return { merchantId: input.merchantId, version: state.version, acceptedAt: state.acceptedAt };
}
