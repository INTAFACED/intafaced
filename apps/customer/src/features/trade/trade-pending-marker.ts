import { z } from 'zod';

/**
 * The one trading write this browser sent and has not yet seen settled, kept in local storage under the person's key so
 * a reload or another tab reads it back rather than sending it again. Not a service answer: only this browser writes it.
 */
const markerSchema = z.object({
  kind: z.string(),
  id: z.string(),
  symbol: z.string(),
  operation: z.string().optional(),
  clientCloseId: z.string().optional(),
  startedAt: z.number(),
});
export type Marker = z.infer<typeof markerSchema>;
export function readMarker(key: string) {
  try {
    const wire = localStorage.getItem(key);
    if (!wire) return { pending: null, blocked: false, available: true };
    const parsed = markerSchema.safeParse(JSON.parse(wire));
    return { pending: parsed.success ? parsed.data : null, blocked: true, available: true };
  } catch {
    return { pending: null, blocked: true, available: false };
  }
}
