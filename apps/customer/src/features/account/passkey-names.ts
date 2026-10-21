import { z } from 'zod';

export const passkeyKind = z.enum(['platform', 'cross_device', 'security_key', 'unknown']);
export type PasskeyKind = z.infer<typeof passkeyKind>;

export const passkeyList = z.object({
  passkeys: z.array(
    z.object({
      credentialId: z.string().min(1),
      label: z.string().nullable(),
      kind: passkeyKind,
      createdAt: z.string(),
      lastUsedAt: z.string().nullable(),
    }),
  ),
  maxPerAccount: z.number().int().nullable(),
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
