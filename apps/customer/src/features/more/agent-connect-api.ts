// hand-declared-ok: svc-trade's /api/v1/venue/agent-accounts routes (src/venue/agent-account-rest.ts) have no schema in packages/contracts; this mirrors their answers, tolerant of extra keys
/**
 * The person's agent accounts and their assistant's connection (J-agents-21, AG-outside-01, AG-outside-02), through
 * svc-trade's user-venue door. The venue is the record for every balance; amounts are decimal strings, never numbers.
 * INTAFACED holds and moves nothing here: each move is the person's own wallet-signed venue transfer.
 */
import { apiKeyCreateOutputSchema, apiKeyCreateRequestId, type ApiKeyCreateOutput, type ApiKeyList } from '@intafaced/contracts/api-keys';
import { IDENTITY_DEVELOPER_KEYS_LIST, IDENTITY_DEVELOPER_KEYS_REVOKE } from '@intafaced/contracts/identity-developer-keys-procedures';
import {
  venueAgentActivitySchema,
  venueAgentKeyExpirySchema,
  venueAgentLimitsSchema,
  venueAgentRevokeSchema,
  type VenueAgentActivity,
  type VenueAgentActivityRow,
  type VenueAgentRevoke,
} from '@intafaced/contracts/trade-venue-door';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { requestPasskeyAssertion } from '../session';
import type { StepUpBegin } from '../account';
import { type TypedDataDocument, withDomainTypes } from '../protocol';

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);

export const agentPermissionSchema = z.object({ venue: z.string(), reach: z.enum(['own_account_only', 'owner_accounts']) }).passthrough();
export type AgentPermission = z.infer<typeof agentPermissionSchema>;

export const agentTermsSchema = z
  .object({
    /** The owner's ceiling for any agent account's cap; null is blank and refuses every create. */
    ceiling: decimal.nullable(),
    asset: z.string().nullable(),
    /** How far the agent permission the wallet signs reaches on the venue (J-agents-21 #3); null when not read. */
    agentPermission: agentPermissionSchema.nullable().optional(),
  })
  .passthrough();
export type AgentTerms = z.infer<typeof agentTermsSchema>;

const typedDataSchema = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export const agentNextSchema = z
  .object({
    actionKey: z.string(),
    step: z.string(),
    signed: z.boolean(),
    prepared: z.object({ digest: z.string(), typedData: typedDataSchema }).passthrough(),
  })
  .passthrough();
export type AgentNext = z.infer<typeof agentNextSchema>;

export const agentAccountSchema = z
  .object({
    accountId: z.string(),
    status: z.string(),
    owner: z.string(),
    subAccount: z.string().nullable(),
    name: z.string(),
    asset: z.string(),
    cap: decimal,
    room: decimal,
    /** The person's own per-order size, leverage and daily-loss caps (J-agents-21 #16); null is not set. */
    limits: venueAgentLimitsSchema.optional(),
    balances: z
      .object({ value: z.array(z.object({ asset: z.string(), total: decimal }).passthrough()) })
      .passthrough()
      .nullable(),
    next: agentNextSchema.nullable(),
    test: z.boolean().optional(),
    agentPermission: agentPermissionSchema.optional(),
  })
  .passthrough();
export type AgentAccount = z.infer<typeof agentAccountSchema>;

export const agentConnectionSchema = z
  .object({
    keyId: z.string(),
    accountId: z.string(),
    subAccount: z.string().nullable(),
    /** The key's end date as identity holds it (J-agents-21 #19): null is none; not known when identity could not be asked. */
    expiry: venueAgentKeyExpirySchema.optional(),
  })
  .passthrough();
export type AgentConnection = z.infer<typeof agentConnectionSchema>;

export type AgentActivityRow = VenueAgentActivityRow;
export type AgentRevoke = VenueAgentRevoke;

/** The EIP-712 domain the wallet reads, every field the venue sent kept as sent (a salt included). */
const walletDomain = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    chainId: z.union([z.number(), z.string()]).optional(),
    verifyingContract: z.string().optional(),
  })
  .passthrough();

/** The venue's payload with its domain types declared, as the wallet signs it; null when its domain is not one. */
export function walletTypedData(typed: AgentNext['prepared']['typedData']): TypedDataDocument | null {
  const withTypes = withDomainTypes(typed);
  const domain = walletDomain.safeParse(withTypes.domain);
  return domain.success ? { ...withTypes, domain: domain.data } : null;
}

const BASE = '/venue/agent-accounts';

export function readAgentTerms(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<AgentTerms>> {
  return api.rest(`${BASE}/terms`, agentTermsSchema, { signal });
}

export function readAgentAccounts(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<{ accounts: AgentAccount[] }>> {
  return api.rest(BASE, z.object({ accounts: z.array(agentAccountSchema) }), { signal });
}

export function readAgentConnections(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<{ connections: AgentConnection[] }>> {
  return api.rest(`${BASE}/connections`, z.object({ connections: z.array(agentConnectionSchema) }), { signal });
}

export function readKeys(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<ApiKeyList>> {
  return api.call(IDENTITY_DEVELOPER_KEYS_LIST, { limit: 200 }, { signal });
}

/** The asset's total in the account as the venue reports it; null before the sub-account exists. */
export function venueTotal(account: AgentAccount): string | null {
  if (!account.balances) return null;
  return account.balances.value.find((b) => b.asset === account.asset)?.total ?? '0';
}

/** A typed amount in the canonical decimal form svc-trade hashes for the step-up (`010.50` → `10.5`); null when not one. */
export function canonical(amount: string): string | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(amount.trim());
  if (!match) return null;
  const whole = BigInt(match[1]!).toString();
  const frac = (match[2] ?? '').replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/** What the create's step-up names, exactly as svc-trade re-hashes it (agent-account.ts `create`). */
export function createStepUp(ask: { accountId: string; owner: string; asset: string; cap: string; fund: string }): StepUpBegin {
  return {
    scope: 'trade.step_up.venue.agentAccount',
    purpose: 'venue.agentAccount',
    target: ask.accountId,
    amount: ask.fund,
    fields: { accountId: ask.accountId, owner: ask.owner, asset: ask.asset, cap: ask.cap, fund: ask.fund },
  };
}

export function createAgentAccount(
  api: ApiClient,
  ask: { accountId: string; owner: string; asset: string; cap: string; fund: string },
  stepUpApprovalId: string | null,
): Promise<ApiResult<AgentAccount>> {
  return api.rest(BASE, agentAccountSchema, { method: 'POST', body: { ...ask, stepUpApprovalId } });
}

export function submitAgentAction(
  api: ApiClient,
  accountId: string,
  actionKey: string,
  signature: { digest: string; signature: string; signedBy: string },
): Promise<ApiResult<AgentAccount>> {
  return api.rest(`${BASE}/${encodeURIComponent(accountId)}/submit`, agentAccountSchema, {
    method: 'POST',
    body: { actionKey, signature },
  });
}

export function abandonAgentAccount(api: ApiClient, accountId: string): Promise<ApiResult<AgentAccount>> {
  return api.rest(`${BASE}/${encodeURIComponent(accountId)}/abandon`, agentAccountSchema, { method: 'POST', body: {} });
}

type Signature = { digest: string; signature: string; signedBy: string };
const accountPost = (api: ApiClient, accountId: string, action: string, body: Record<string, unknown>) =>
  api.rest(`${BASE}/${encodeURIComponent(accountId)}/${action}`, agentAccountSchema, { method: 'POST', body });

/**
 * A move in from the person's main venue account (`fund`) or back to it (`withdraw`), under the id made once for this
 * ask. svc-trade refuses a move in past the cap before anything is prepared; otherwise the answer's `next` is the venue
 * transfer for the wallet to sign.
 */
export function moveAgentFunds(
  api: ApiClient,
  accountId: string,
  direction: 'fund' | 'withdraw',
  moveId: string,
  amount: string,
): Promise<ApiResult<AgentAccount>> {
  return accountPost(api, accountId, direction, { moveId, amount });
}

export function setAgentCap(api: ApiClient, accountId: string, cap: string): Promise<ApiResult<AgentAccount>> {
  return accountPost(api, accountId, 'cap', { cap });
}

/** Only the caps named are changed; one left out stays as it was. */
export function setAgentLimits(
  api: ApiClient,
  accountId: string,
  limits: { maxOrderNotional?: string; maxLeverage?: string; maxDailyLoss?: string },
): Promise<ApiResult<AgentAccount>> {
  return accountPost(api, accountId, 'limits', limits);
}

export function closeAgentAccount(api: ApiClient, accountId: string): Promise<ApiResult<AgentAccount>> {
  return accountPost(api, accountId, 'close', {});
}

export function readAgentActivity(api: ApiClient, keyId: string, signal?: AbortSignal): Promise<ApiResult<VenueAgentActivity>> {
  return api.rest(`${BASE}/connections/${encodeURIComponent(keyId)}/activity`, venueAgentActivitySchema, { signal });
}

/** Identity switches the assistant's API key off: its next call is refused at the door. */
export async function revokeAssistantKey(api: ApiClient, keyId: string): Promise<ApiResult<null>> {
  const off = await api.call(IDENTITY_DEVELOPER_KEYS_REVOKE, { keyId });
  return off.ok ? { ok: true, data: null } : off;
}

/**
 * svc-trade revokes the assistant on its agent account: the connection ends, its resting orders are cancelled once and
 * our copy of the venue agent key is dropped. With the wallet's signature of the answer's `next`, the venue's own revoke
 * is sent. Safe to send again.
 */
export function revokeAssistant(
  api: ApiClient,
  keyId: string,
  signed?: { actionKey: string; signature: Signature },
): Promise<ApiResult<AgentRevoke>> {
  return api.rest(`${BASE}/connections/${encodeURIComponent(keyId)}/revoke`, venueAgentRevokeSchema, {
    method: 'POST',
    body: signed ?? {},
  });
}

/** The trade scopes an assistant's key holds, and the one the form also offers so the person sees it refused (#6). */
export const ASSISTANT_SCOPES = ['trade:read', 'trade:write'] as const;
export const WITHDRAW_SCOPE = 'trade:withdraw';

/**
 * Makes the person's agent key with a passkey answer: tagged Agent, the scopes asked. Identity decides; an agent key
 * asking for a withdraw scope is refused `auth.agent_scope_forbidden` with nothing made. The request id comes from the
 * keys this page read and what was asked, so a press again after a lost reply returns the key that request made.
 */
export async function createAssistantKey(
  api: ApiClient,
  userId: string,
  listed: ApiKeyList['keys'],
  asked: { name: string; scopes: string[]; expiresAt?: string },
  signal?: AbortSignal,
): Promise<ApiResult<ApiKeyCreateOutput>> {
  const assertion = await requestPasskeyAssertion(api, signal);
  if (!assertion.ok) return assertion;
  const input = { ...asked, kind: 'agent' as const };
  return api.mutate(
    'identity',
    'developerKeys.create',
    { ...input, requestId: apiKeyCreateRequestId(userId, listed, input), factorProof: { webauthn: assertion.data } },
    apiKeyCreateOutputSchema,
    { signal, keepSessionFor: ['auth.mfa_invalid', 'auth.webauthn_invalid'] },
  );
}

/** What the connect's step-up names, exactly as svc-trade re-hashes it (agent-orders.ts `connect`). */
export function connectStepUp(keyId: string, accountId: string): StepUpBegin {
  return {
    scope: 'trade.step_up.venue.agentConnect',
    purpose: 'venue.agentConnect',
    target: keyId,
    fields: { keyId, accountId },
  };
}

export function connectAssistant(
  api: ApiClient,
  accountId: string,
  keyId: string,
  stepUpApprovalId: string | null,
): Promise<ApiResult<AgentConnection>> {
  return api.rest(`${BASE}/${encodeURIComponent(accountId)}/connections`, agentConnectionSchema, {
    method: 'POST',
    body: { keyId, stepUpApprovalId },
  });
}

/**
 * The MCP setup for the person's own assistant (packages/assistant-mcp): the server it runs over stdio and the three
 * values it needs. Built in the browser from the reply and never stored.
 */
export function mcpSetup(apiUrl: string, key: string, signingSecret: string | null): string {
  const env: Record<string, string> = { INTAFACED_API_URL: apiUrl, INTAFACED_AGENT_KEY: key };
  if (signingSecret) env.INTAFACED_AGENT_SIGNING_SECRET = signingSecret;
  return JSON.stringify({ mcpServers: { intafaced: { command: 'node', args: ['packages/assistant-mcp/src/server.ts'], env } } }, null, 2);
}
