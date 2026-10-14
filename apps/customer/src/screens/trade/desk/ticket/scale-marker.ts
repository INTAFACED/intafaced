/**
 * The saved list of orders in a scale batch whose outcome is not yet known.
 *
 * It sits beside the desk's one-order marker (`../pending.ts`), which is what actually blocks new orders in every tab
 * and in the old desk: that marker is taken first, under the id `scale:<batch>`. This file adds the part the one-order
 * marker cannot hold, the exact orders that were sent, so after a lost answer or a reload the desk can look each one up
 * by its `clientOrderId` and, on the person's click, send the missing ones again under the same ids.
 *
 * Written AFTER the slot is taken and BEFORE anything is sent; removed only when every order's outcome is known.
 */
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { draftSchema } from '../../../../features/trade/trade-api';

export const scaleMarkerSchema = z.object({
  batchId: z.string().min(1),
  symbol: z.string(),
  startedAt: z.number(),
  /** The orders whose outcome is still unknown, exactly as they were sent. */
  drafts: z.array(draftSchema).min(1).max(100),
});
export type ScaleMarker = z.infer<typeof scaleMarkerSchema>;

export const scaleMarkerKey = (userId: string) => `trade-scale:${userId}`;
const CHANGE = 'trade-scale-change';

export type ScaleMarkerState = { state: 'none' } | { state: 'pending'; value: ScaleMarker } | { state: 'unreadable' };

export function readScaleMarker(userId: string, storage: Pick<Storage, 'getItem'> = localStorage): ScaleMarkerState {
  try {
    const raw = storage.getItem(scaleMarkerKey(userId));
    if (raw === null) return { state: 'none' };
    const parsed = scaleMarkerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { state: 'pending', value: parsed.data } : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

/** Save the marker. False when this browser cannot store it: the batch must then not be sent. */
export function writeScaleMarker(userId: string, value: ScaleMarker, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(scaleMarkerKey(userId), JSON.stringify(scaleMarkerSchema.parse(value)));
  } catch {
    return false;
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE));
  return true;
}

export function clearScaleMarker(userId: string, storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(scaleMarkerKey(userId));
  } catch {
    /* The marker stays; the person is asked to check, which is the safe side. */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE));
}

/** The marker for this user, live across tabs. */
export function useScaleMarker(userId: string | null): ScaleMarkerState {
  const read = useCallback((): ScaleMarkerState => (userId ? readScaleMarker(userId) : { state: 'none' }), [userId]);
  const [state, setState] = useState<ScaleMarkerState>(read);
  useEffect(() => {
    const update = () => setState(read());
    update();
    window.addEventListener('storage', update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(CHANGE, update);
    };
  }, [read]);
  return state;
}
