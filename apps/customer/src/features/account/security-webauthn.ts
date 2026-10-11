import { z } from 'zod';
import { credentialBytes, credentialId, credentialReference } from './security-guards';

const descriptor = z.object({ id: credentialId, type: z.literal('public-key'), transports: z.array(z.string()).optional() });
export function registrationFor(owner: string) {
  return z
    .object({
      challenge: credentialId,
      rp: z.object({ id: z.string().min(1).optional(), name: z.string().min(1) }),
      user: z.object({ id: credentialId, name: z.string().min(1), displayName: z.string().min(1) }),
      pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number().int().safe() })).min(1),
      timeout: z.number().positive().finite().optional(),
      excludeCredentials: z.array(descriptor).optional(),
      authenticatorSelection: z
        .object({
          authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
          residentKey: z.enum(['discouraged', 'preferred', 'required']).optional(),
          requireResidentKey: z.boolean().optional(),
          userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
        })
        .optional(),
      attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional(),
    })
    .refine((value) => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(credentialBytes(value.user.id)) === owner;
      } catch {
        return false;
      }
    });
}
export function nativeRegistration(options: z.infer<ReturnType<typeof registrationFor>>, signal: AbortSignal): CredentialCreationOptions {
  return {
    signal,
    publicKey: {
      ...options,
      challenge: credentialBytes(options.challenge),
      user: { ...options.user, id: credentialBytes(options.user.id) },
      excludeCredentials: options.excludeCredentials?.map((row) => ({
        ...row,
        id: credentialBytes(row.id),
        transports: row.transports as AuthenticatorTransport[] | undefined,
      })),
    },
  };
}
/** Browser attestation remains in memory; only canonical public references enter the journal. */
export function registrationPayload(credential: Credential | null) {
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) return null;
  const rawId = credentialReference(credential.rawId);
  if (!credentialId.safeParse(rawId).success || credential.id !== rawId || credential.type !== 'public-key') return null;
  return {
    id: rawId,
    rawId,
    type: 'public-key' as const,
    response: {
      clientDataJSON: credentialReference(credential.response.clientDataJSON),
      attestationObject: credentialReference(credential.response.attestationObject),
      transports: credential.response.getTransports(),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}
