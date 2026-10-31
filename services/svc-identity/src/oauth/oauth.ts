/**
 * Our own OAuth provider (DV-oauth-01): app registration, operator approval, the authorise decision and the
 * authorisation-code exchange with PKCE.
 *
 * Rules held here:
 * - PKCE with S256 is required for every client and `state` is required (the contract refuses anything else).
 * - A client secret, a code and a token are random, shown once and kept only as sha256 hashes.
 * - A code gets one attempt: it is marked used and its challenge cleared before the verifier is compared, and a
 *   second use revokes every token issued from it.
 * - Lifetimes come from the owner. Blank refuses with `oauth.lifetime_unset`; there is no default.
 * - An unapproved app reaches only its developer's own account.
 * - No money moves and no ledger recipe is used. The account freeze lives in this service, so a frozen
 *   account authorises nothing and exchanges nothing.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { assertDelegatableScopes, isScope } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import {
  OAUTH_VERIFIER_PATTERN,
  oauthAppRequestId,
  oauthRedirectUrlProblem,
  type OAuthApp,
  type OAuthAppStatus,
  type OAuthAuthorizeRequest,
  type OAuthErrorCode,
  type OAuthRegisterAppInput,
} from '@intafaced/contracts/oauth';

export class OAuthError extends Error {
  constructor(readonly code: OAuthErrorCode) {
    super(code);
    this.name = 'OAuthError';
  }
}

export type OAuthSettings = {
  /** Lifetime of an authorisation code. Undefined while the owner has not published one. */
  readonly codeTtlSeconds?: number | undefined;
  /** Lifetime of an access token. Undefined while the owner has not published one. */
  readonly accessTokenTtlSeconds?: number | undefined;
};

type AppRow = {
  id: string;
  client_id: string;
  developer_user_id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  redirect_urls: string[];
  scopes: string[];
  confidential: boolean;
  secret_hash: string | null;
  secret_rolled_at: Date | null;
  last_roll_request_id: string | null;
  status: OAuthAppStatus;
  fingerprint: string;
  created_at: Date;
};

const APP_COLUMNS = `id, client_id, developer_user_id, name, description, logo_url, redirect_urls, scopes, confidential, secret_hash,
  secret_rolled_at, last_roll_request_id, status, fingerprint, created_at`;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const token = (prefix: string, bytes: number): string => `${prefix}${randomBytes(bytes).toString('base64url')}`;

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function toApp(row: AppRow): OAuthApp {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    description: row.description,
    logoUrl: row.logo_url,
    redirectUrls: row.redirect_urls,
    scopes: row.scopes,
    confidential: row.confidential,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    secretRolledAt: row.secret_rolled_at?.toISOString() ?? null,
  };
}

/** A signed-in person: not a service, not an API key, not a sub-account credential. */
function sessionUser(context: Context): string {
  const principal = context.principal;
  if (!principal || context.service !== null || !principal.userId) throw new OAuthError('oauth.operator_denied');
  if (principal.kid || principal.sub_account) throw new OAuthError('oauth.key_principal_refused');
  return principal.userId.toLowerCase();
}

function operator(context: Context, options: { mfa?: boolean } = {}): string {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes('admin:compliance')) {
    throw new OAuthError('oauth.operator_denied');
  }
  // `admin:compliance` is not in SESSION_MFA_SCOPES, so the scope guard does not ask for two-factor. A decision that
  // opens an app to every user does, as the other desk decisions do.
  if (options.mfa && !principal.mfa) throw new OAuthError('oauth.operator_denied');
  return principal.userId.toLowerCase();
}

/** The scopes the signed-in session itself holds: the most it can declare for an app or consent to for one. */
function sessionScopes(context: Context): readonly string[] {
  return context.principal?.scopes ?? [];
}

function normaliseScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()))].sort();
}

/**
 * Every declared scope must be a known, delegable scope the grantor holds: never an interactive-only or desk scope,
 * and never one the registering session does not have itself (an app is a delegation, not a way to gain authority).
 */
function assertDeclarable(scopes: readonly string[], grantorScopes: readonly string[]): void {
  if (scopes.length === 0) throw new OAuthError('oauth.scope_empty');
  if (scopes.some((scope) => !isScope(scope))) throw new OAuthError('oauth.invalid_scope');
  try {
    assertDelegatableScopes(scopes, grantorScopes);
  } catch {
    throw new OAuthError('oauth.scope_not_delegable');
  }
}

/** The consenting person can only hand an app scopes they hold. */
function assertConsentable(scopes: readonly string[], grantorScopes: readonly string[]): void {
  try {
    assertDelegatableScopes(scopes, grantorScopes);
  } catch {
    throw new OAuthError('oauth.invalid_scope');
  }
}

function fingerprintOf(input: {
  name: string;
  description?: string | undefined;
  logoUrl?: string | undefined;
  redirectUrls: string[];
  scopes: string[];
  confidential: boolean;
}): string {
  return sha256(
    JSON.stringify([
      input.name.trim().toLowerCase(),
      input.description ?? null,
      input.logoUrl ?? null,
      [...input.redirectUrls].sort(),
      normaliseScopes(input.scopes),
      input.confidential,
    ]),
  );
}

/** The challenge a verifier produces: unpadded base64url of its SHA-256 (RFC 7636 S256). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function redirectWith(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export type ExchangeResult = { accessToken: string; tokenType: 'Bearer'; expiresIn: number; scope: string[] };

export class OAuthService {
  constructor(
    private readonly sql: Sql,
    private readonly settings: OAuthSettings = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async activeUser(userId: string): Promise<void> {
    const [row] = await this.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId}`;
    if (row?.status !== 'active') throw new OAuthError('oauth.account_not_active');
  }

  async registerApp(context: Context, input: OAuthRegisterAppInput): Promise<{ app: OAuthApp; clientSecret: string | null }> {
    const developerId = sessionUser(context);
    const redirectUrls = [...new Set(input.redirectUrls)];
    if (redirectUrls.some((url) => oauthRedirectUrlProblem(url) !== null)) throw new OAuthError('oauth.redirect_url_invalid');
    if (input.logoUrl !== undefined && oauthRedirectUrlProblem(input.logoUrl) !== null) throw new OAuthError('oauth.redirect_url_invalid');
    const scopes = normaliseScopes(input.scopes);
    assertDeclarable(scopes, sessionScopes(context));
    if (input.requestId !== oauthAppRequestId(developerId, input.name)) throw new OAuthError('oauth.idempotency_conflict');
    await this.activeUser(developerId);
    const fingerprint = fingerprintOf({ ...input, redirectUrls, scopes });
    const clientId = token('ifc_', 12);
    const secret = input.confidential ? token('ifcs_', 32) : null;
    const nameKey = input.name.trim().toLowerCase().replace(/\s+/g, ' ');
    const inserted = await this.sql<AppRow[]>`
      INSERT INTO oauth_apps (client_id, developer_user_id, name, name_key, description, logo_url, redirect_urls, scopes,
                              confidential, secret_hash, request_id, fingerprint)
      VALUES (${clientId}, ${developerId}, ${input.name.trim()}, ${nameKey}, ${input.description ?? null}, ${input.logoUrl ?? null},
              ${redirectUrls}, ${scopes}, ${input.confidential}, ${secret ? sha256(secret) : null}, ${input.requestId}, ${fingerprint})
      ON CONFLICT DO NOTHING
      RETURNING ${this.sql.unsafe(APP_COLUMNS)}
    `;
    if (inserted[0]) return { app: toApp(inserted[0]), clientSecret: secret };
    // A replay (same request id) returns the first app with no secret; the same name from another request is a conflict.
    const [prior] = await this.sql<AppRow[]>`
      SELECT ${this.sql.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE developer_user_id = ${developerId} AND request_id = ${input.requestId}
    `;
    if (!prior || prior.fingerprint !== fingerprint) throw new OAuthError('oauth.idempotency_conflict');
    return { app: toApp(prior), clientSecret: null };
  }

  async listApps(context: Context, limit: number): Promise<OAuthApp[]> {
    const developerId = sessionUser(context);
    const rows = await this.sql<AppRow[]>`
      SELECT ${this.sql.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE developer_user_id = ${developerId}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(toApp);
  }

  /** The new secret is returned once. A repeat of the same roll request returns the app with no secret. */
  async rollSecret(context: Context, input: { appId: string; requestId: string }): Promise<{ app: OAuthApp; clientSecret: string | null }> {
    const developerId = sessionUser(context);
    const [own] = await this.sql<AppRow[]>`
      SELECT ${this.sql.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE id = ${input.appId} AND developer_user_id = ${developerId}
    `;
    if (!own) throw new OAuthError('oauth.app_not_found');
    if (!own.confidential) throw new OAuthError('oauth.invalid_request');
    if (own.last_roll_request_id === input.requestId) return { app: toApp(own), clientSecret: null };
    await this.activeUser(developerId);
    const secret = token('ifcs_', 32);
    const [updated] = await this.sql<AppRow[]>`
      UPDATE oauth_apps SET secret_hash = ${sha256(secret)}, secret_rolled_at = ${this.now()}, last_roll_request_id = ${input.requestId}
      WHERE id = ${input.appId} AND developer_user_id = ${developerId} AND last_roll_request_id IS DISTINCT FROM ${input.requestId}
      RETURNING ${this.sql.unsafe(APP_COLUMNS)}
    `;
    if (!updated) {
      // A concurrent roll with the same id won: that call holds the secret, this one gets none.
      const [again] = await this.sql<AppRow[]>`SELECT ${this.sql.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE id = ${input.appId}`;
      return { app: toApp(again as AppRow), clientSecret: null };
    }
    return { app: toApp(updated), clientSecret: secret };
  }

  /** Operator queue: apps waiting for a decision, oldest first. */
  async reviewQueue(context: Context, status: OAuthAppStatus, limit: number): Promise<Array<OAuthApp & { developerUserId: string }>> {
    operator(context);
    const rows = await this.sql<AppRow[]>`
      SELECT ${this.sql.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE status = ${status} ORDER BY created_at ASC LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...toApp(row), developerUserId: row.developer_user_id }));
  }

  /** Approve or suspend. Repeating the same decision changes nothing. Suspending also ends every live token of the app. */
  async reviewApp(
    context: Context,
    input: { appId: string; decision: 'approve' | 'suspend'; reason?: string | undefined },
  ): Promise<OAuthApp> {
    const reviewerId = operator(context, { mfa: true });
    const status: OAuthAppStatus = input.decision === 'approve' ? 'approved' : 'suspended';
    return transaction(this.sql, async (tx) => {
      const [current] = await tx<AppRow[]>`SELECT ${tx.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE id = ${input.appId} FOR UPDATE`;
      if (!current) throw new OAuthError('oauth.app_not_found');
      // Approving your own app is self-approval: someone else on the desk decides it. Suspending your own is harmless.
      if (status === 'approved' && current.developer_user_id === reviewerId) throw new OAuthError('oauth.operator_denied');
      if (current.status === status) return toApp(current);
      const [updated] = await tx<AppRow[]>`
        UPDATE oauth_apps SET status = ${status}, reviewed_by = ${reviewerId}, reviewed_at = ${this.now()}, review_reason = ${input.reason ?? null}
        WHERE id = ${input.appId}
        RETURNING ${tx.unsafe(APP_COLUMNS)}
      `;
      if (status === 'suspended') {
        await tx`UPDATE oauth_tokens SET revoked_at = ${this.now()} WHERE app_id = ${input.appId} AND revoked_at IS NULL`;
      }
      return toApp(updated as AppRow);
    });
  }

  /** The owner's lifetimes as published; `null` for one that is not. */
  lifetimes(): { codeTtlSeconds: number | null; accessTokenTtlSeconds: number | null } {
    return { codeTtlSeconds: this.settings.codeTtlSeconds ?? null, accessTokenTtlSeconds: this.settings.accessTokenTtlSeconds ?? null };
  }

  private requireLifetimes(): { codeTtl: number; accessTtl: number } {
    const { codeTtlSeconds, accessTokenTtlSeconds } = this.settings;
    if (codeTtlSeconds === undefined || accessTokenTtlSeconds === undefined) throw new OAuthError('oauth.lifetime_unset');
    return { codeTtl: codeTtlSeconds, accessTtl: accessTokenTtlSeconds };
  }

  /** Checks client, redirect URL and scopes. An unapproved app is open only to its own developer. */
  private async resolveRequest(
    userId: string,
    grantorScopes: readonly string[],
    request: OAuthAuthorizeRequest,
  ): Promise<{ app: AppRow; scopes: string[] }> {
    const [app] = await this.sql<AppRow[]>`
      SELECT ${this.sql.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE client_id = ${request.clientId}
    `;
    if (!app) throw new OAuthError('oauth.app_not_found');
    if (!app.redirect_urls.includes(request.redirectUri)) throw new OAuthError('oauth.redirect_uri_mismatch');
    if (app.status === 'suspended') throw new OAuthError('oauth.app_not_approved');
    if (app.status === 'pending' && app.developer_user_id !== userId) throw new OAuthError('oauth.app_not_approved');
    const scopes = normaliseScopes(request.scope);
    if (scopes.some((scope) => !app.scopes.includes(scope))) throw new OAuthError('oauth.invalid_scope');
    assertConsentable(scopes, grantorScopes);
    return { app, scopes };
  }

  /** What the consent page shows. Nothing is issued here. */
  async preview(
    context: Context,
    request: OAuthAuthorizeRequest,
  ): Promise<{ appName: string; appDescription: string | null; logoUrl: string | null; developerOwnAccount: boolean; scopes: string[] }> {
    const userId = sessionUser(context);
    this.requireLifetimes();
    await this.activeUser(userId);
    const { app, scopes } = await this.resolveRequest(userId, sessionScopes(context), request);
    return {
      appName: app.name,
      appDescription: app.description,
      logoUrl: app.logo_url,
      developerOwnAccount: app.developer_user_id === userId,
      scopes,
    };
  }

  /** The person's explicit answer. `allow` issues a single-use code; `deny` issues nothing. */
  async decide(context: Context, request: OAuthAuthorizeRequest & { decision: 'allow' | 'deny' }): Promise<{ redirectTo: string }> {
    const userId = sessionUser(context);
    const { codeTtl } = this.requireLifetimes();
    await this.activeUser(userId);
    const { app, scopes } = await this.resolveRequest(userId, sessionScopes(context), request);
    if (request.decision === 'deny') {
      return { redirectTo: redirectWith(request.redirectUri, { error: 'access_denied', state: request.state }) };
    }
    const code = token('ifcc_', 32);
    const expiresAt = new Date(this.now().getTime() + codeTtl * 1000);
    await this.sql`
      INSERT INTO oauth_codes (code_hash, app_id, user_id, redirect_url, scopes, code_challenge, expires_at)
      VALUES (${sha256(code)}, ${app.id}, ${userId}, ${request.redirectUri}, ${scopes}, ${request.codeChallenge}, ${expiresAt})
    `;
    return { redirectTo: redirectWith(request.redirectUri, { code, state: request.state }) };
  }

  /**
   * The code exchange. The code is consumed before the verifier is compared, so a wrong verifier still spends it.
   * A code that is already used revokes the tokens it produced. Every failure after the code is found is committed
   * before it is raised.
   */
  async exchange(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
    clientSecret?: string | undefined;
  }): Promise<ExchangeResult> {
    const { accessTtl } = this.requireLifetimes();
    const [app] = await this.sql<AppRow[]>`SELECT ${this.sql.unsafe(APP_COLUMNS)} FROM oauth_apps WHERE client_id = ${input.clientId}`;
    if (!app) throw new OAuthError('oauth.invalid_client');
    if (app.confidential) {
      if (!input.clientSecret || !app.secret_hash || !sameHash(sha256(input.clientSecret), app.secret_hash)) {
        throw new OAuthError('oauth.invalid_client');
      }
    } else if (input.clientSecret !== undefined) {
      throw new OAuthError('oauth.invalid_client');
    }
    if (app.status === 'suspended') throw new OAuthError('oauth.app_not_approved');

    const now = this.now();
    const codeHash = sha256(input.code);
    const outcome = await transaction(this.sql, async (tx): Promise<{ failure: OAuthErrorCode } | { result: ExchangeResult }> => {
      const [row] = await tx<
        Array<{
          app_id: string;
          user_id: string;
          redirect_url: string;
          scopes: string[];
          code_challenge: string | null;
          expires_at: Date;
          used_at: Date | null;
        }>
      >`
        SELECT app_id, user_id, redirect_url, scopes, code_challenge, expires_at, used_at
        FROM oauth_codes WHERE code_hash = ${codeHash} FOR UPDATE
      `;
      // A code issued to another app is not this client's to spend or to learn about.
      if (!row || row.app_id !== app.id) return { failure: 'oauth.invalid_grant' };
      // Read the status again under a share lock: a suspension that commits first is seen here, and one that comes
      // after waits for this transaction and then revokes the token it issues.
      const [live] = await tx<Array<{ status: OAuthAppStatus }>>`SELECT status FROM oauth_apps WHERE id = ${app.id} FOR SHARE`;
      if (!live || live.status === 'suspended') return { failure: 'oauth.app_not_approved' };
      if (row.used_at !== null || row.code_challenge === null) {
        await tx`UPDATE oauth_tokens SET revoked_at = ${now} WHERE code_hash = ${codeHash} AND revoked_at IS NULL`;
        return { failure: 'oauth.invalid_grant' };
      }
      await tx`UPDATE oauth_codes SET used_at = ${now}, code_challenge = NULL WHERE code_hash = ${codeHash}`;
      if (row.expires_at.getTime() <= now.getTime()) return { failure: 'oauth.invalid_grant' };
      if (row.redirect_url !== input.redirectUri) return { failure: 'oauth.invalid_grant' };
      if (!OAUTH_VERIFIER_PATTERN.test(input.codeVerifier)) return { failure: 'oauth.invalid_grant' };
      const expected = Buffer.from(row.code_challenge);
      const actual = Buffer.from(s256(input.codeVerifier));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { failure: 'oauth.invalid_grant' };
      const [user] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${row.user_id}`;
      if (user?.status !== 'active') return { failure: 'oauth.account_not_active' };
      const accessToken = token('ifct_', 32);
      await tx`
        INSERT INTO oauth_tokens (token_hash, app_id, user_id, code_hash, scopes, expires_at)
        VALUES (${sha256(accessToken)}, ${app.id}, ${row.user_id}, ${codeHash}, ${row.scopes}, ${new Date(now.getTime() + accessTtl * 1000)})
      `;
      return { result: { accessToken, tokenType: 'Bearer', expiresIn: accessTtl, scope: row.scopes } };
    });
    if ('failure' in outcome) throw new OAuthError(outcome.failure);
    return outcome.result;
  }
}
