import { z } from 'zod';

/**
 * The one price-alert action this browser sent and has not yet seen confirmed, kept in local storage so a reload reads
 * it back rather than sending it again. Not a service answer: only this browser writes it.
 */
const markerSchema = z.object({
  requestId: z.string().guid(),
  action: z.enum(['create', 'cancel', 'check']),
  marketId: z.string().min(1).max(64),
  alertId: z.string().guid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type Marker = z.infer<typeof markerSchema>;
export type Stored = { marker: Marker | null; failed: boolean };
export const storageKey = (userId: string) => 'intafaced.customer.alert-unconfirmed.v1:' + userId;
export function readMarker(key: string): Stored {
  try {
    const raw = localStorage.getItem(key);
    return { marker: raw === null ? null : markerSchema.parse(JSON.parse(raw)), failed: false };
  } catch {
    return { marker: null, failed: true };
  }
}
