import { z } from 'zod';

export const passkeyKind = z.enum(['platform', 'cross_device', 'security_key', 'unknown']);
export type PasskeyKind = z.infer<typeof passkeyKind>;
/** What a passkey can be kept for (I-signin-sessions-10); none set means every action. */
export const passkeyPurpose = z.enum(['signin', 'money_out', 'security_change']);
export type PasskeyPurpose = z.infer<typeof passkeyPurpose>;
export const PASSKEY_PURPOSES = passkeyPurpose.options;

export const passkeyList = z.object({
  passkeys: z.array(
    z.object({
      credentialId: z.string().min(1),
      label: z.string().nullable(),
      kind: passkeyKind,
      createdAt: z.string(),
      lastUsedAt: z.string().nullable(),
      purposes: z.array(passkeyPurpose).default([]),
    }),
  ),
  maxPerAccount: z.number().int().nullable(),
  secondStep: z.boolean().default(false),
});
export type PasskeyList = z.infer<typeof passkeyList>;
export const renamed = z.object({ credentialId: z.string(), label: z.string().nullable() }).passthrough();

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** The service trims, then needs 1 to 64 characters without control characters. Returns the trimmed name or null. */
export function cleanName(raw: string): string | null {
  const name = raw.trim();
  return name.length >= 1 && name.length <= 64 && !CONTROL.test(name) ? name : null;
}

/** The body of `stepUp.begin` for a rename: the same three fields the service re-hashes, the passkey id as target. */
export function renameStepUp(credentialId: string, label: string, clientRequestId: string) {
  return {
    scope: 'identity.step_up.passkey_rename',
    purpose: 'account.passkey.rename',
    target: credentialId,
    fields: { credentialId, label, clientRequestId },
  };
}

/** The purposes as the service hashes them: sorted by name and comma-joined, '' for every action. */
export function encodePurposes(purposes: readonly PasskeyPurpose[]): string {
  return [...new Set(purposes)].sort().join(',');
}

/** The body of `stepUp.begin` for binding one passkey to its purposes. */
export function purposesStepUp(credentialId: string, purposes: string, clientRequestId: string) {
  return {
    scope: 'identity.step_up.passkey_purposes',
    purpose: 'account.passkey.purposes',
    target: credentialId,
    fields: { credentialId, purposes, clientRequestId },
  };
}

/** The body of `stepUp.begin` for asking, or no longer asking, for a passkey after the password. */
export function secondStepStepUp(on: boolean, clientRequestId: string) {
  return {
    scope: 'identity.step_up.passkey_second_step',
    purpose: 'account.passkey.secondStep',
    target: clientRequestId,
    fields: { on: on ? 'on' : 'off', clientRequestId },
  };
}
