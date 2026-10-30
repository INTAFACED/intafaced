/**
 * The customer app's calls to the identity service's developer sandboxes (`identity.developerSandboxes.*`, tRPC through
 * the edge). The shapes are the contract's, so a reply that does not match is refused, never shown.
 */
import {
  sandboxCreateOutputSchema,
  sandboxCreateRequestId,
  sandboxGetOutputSchema,
  sandboxKeyCreateOutputSchema,
  sandboxKeyCreateRequestId,
  sandboxListOutputSchema,
  type SandboxDetail,
  type SandboxKeyCreateInput,
  type SandboxList,
} from '@intafaced/contracts/developer-sandboxes';
import type { ApiClient } from '../../../shared/api';
import { requestPasskeyAssertion } from '../../session/webauthn';

export const readSandboxes = (api: ApiClient, signal?: AbortSignal) =>
  api.query('identity', 'developerSandboxes.list', undefined, sandboxListOutputSchema, { signal });

export const readSandbox = (api: ApiClient, sandboxId: string, signal?: AbortSignal) =>
  api.query('identity', 'developerSandboxes.get', { sandboxId }, sandboxGetOutputSchema, { signal });

/** The request id comes from the list this page read and the name asked for, so a retry after a lost reply returns that sandbox. */
export const createSandbox = (api: ApiClient, userId: string, listed: SandboxList['sandboxes'], name: string) =>
  api.mutate(
    'identity',
    'developerSandboxes.create',
    { name, requestId: sandboxCreateRequestId(userId, listed, name) },
    sandboxCreateOutputSchema,
  );

/** What a key may do, as the form offers it. Trade is offered so the service can refuse it by name. */
export const KEY_PRESETS = {
  payments: ['pay:read', 'pay:write'],
  read: ['pay:read'],
  trade: ['trade:read', 'trade:write'],
} as const satisfies Record<string, readonly string[]>;
export type KeyPreset = keyof typeof KEY_PRESETS;

/** One sandbox key create, confirmed with a passkey. With no factor the service answers `auth.step_up_required`. */
export async function createSandboxKey(
  api: ApiClient,
  userId: string,
  sandbox: SandboxDetail,
  asked: Omit<SandboxKeyCreateInput, 'requestId' | 'sandboxId'>,
  signal?: AbortSignal,
) {
  const assertion = await requestPasskeyAssertion(api, signal);
  if (!assertion.ok) return assertion;
  const sandboxId = sandbox.sandbox.id;
  return api.mutate(
    'identity',
    'developerSandboxes.createKey',
    {
      ...asked,
      sandboxId,
      requestId: sandboxKeyCreateRequestId(userId, sandboxId, sandbox.keys, asked),
      factorProof: { webauthn: assertion.data },
    },
    sandboxKeyCreateOutputSchema,
    { signal, keepSessionFor: ['auth.webauthn_invalid'] },
  );
}

/** What the address under /developers/sandbox names. */
export function sandboxRoute(
  path: string,
): { kind: 'list' } | { kind: 'sandbox'; id: string } | { kind: 'new-key'; id: string } | { kind: 'unknown' } {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, '');
  if (clean === '/developers/sandbox') return { kind: 'list' };
  const match = /^\/developers\/sandbox\/([0-9a-f-]{36})(\/keys\/new)?$/i.exec(clean);
  if (!match) return { kind: 'unknown' };
  return match[2] ? { kind: 'new-key', id: match[1]!.toLowerCase() } : { kind: 'sandbox', id: match[1]!.toLowerCase() };
}
