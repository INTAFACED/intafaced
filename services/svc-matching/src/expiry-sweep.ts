/**
 * The GTD/GTT expiry clock, on its own.
 *
 * The book also expires due rests when the next submit or amend reaches it,
 * but a quiet market gets no next command: a good-till-date order then stayed
 * on the book, with its hold, long past its expiry (J-cex-spot-03 #7). This
 * pass runs the engine's own `sweepExpiry()` on a timer so an order leaves at
 * its expiry whether or not anyone else trades. Each cancellation is the
 * engine's ordinary one: journalled with reason `expired` and published on
 * `matching.order.cancelled`, which svc-trade turns into `expired` and a hold
 * release.
 *
 * A disabled engine (the kill switch, or the shutdown drain) is not swept, so
 * nothing is journalled while the journal closes. One pass at a time: a slow
 * pass is never overlapped by the next tick.
 */
export const EXPIRY_SWEEP_EVERY_MS = 1000;

export interface ExpirySweepEngine {
  readonly isEnabled: boolean;
  sweepExpiry(): Promise<unknown>;
}

export function startExpirySweep(input: { engine: ExpirySweepEngine; everyMs?: number; onError?: (err: unknown) => void }): {
  stop(): void;
  tick(): Promise<void>;
} {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running || !input.engine.isEnabled) return;
    running = true;
    try {
      await input.engine.sweepExpiry();
    } catch (err) {
      input.onError?.(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), input.everyMs ?? EXPIRY_SWEEP_EVERY_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
