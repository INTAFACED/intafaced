import { z } from 'zod';

/**
 * What the page holds about a signed-in customer. There is NO refresh token here on purpose: it lives
 * in an HttpOnly cookie the edge sets (services/svc-edge/src/session-cookie.ts), so page script, an
 * injected script and a copied state dump can never read it. The access token stays in memory.
 */
export const sessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  userId: z.string().uuid(),
});
export type Session = z.infer<typeof sessionSchema>;
