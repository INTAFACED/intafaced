import { z } from 'zod';

/**
 * The private stream's short-lived token (J-developer-09 #2): what `POST /api/v1/stream/token` answers, and the
 * audience it is minted for.
 *
 * svc-identity cuts the token from an API key's own exchanged principal; svc-ws's private stream is the only door that
 * accepts it. It carries its own audience, so svc-edge (which verifies the platform audience) never takes it as a
 * bearer, and svc-ws can tell it from an access token cut without a signed request.
 */
export function streamTokenAudience(audience: string): string {
  return `${audience}.stream`;
}

export const streamTokenSchema = z.object({
  token: z.string().min(20),
  /** ISO time the token stops opening the stream. */
  expiresAt: z.string().datetime(),
  lifetimeSeconds: z.number().int().positive(),
});
export type StreamTokenReply = z.infer<typeof streamTokenSchema>;
