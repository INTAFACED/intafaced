/**
 * Per-address window for `certVerify`.
 *
 * The limit and the window both come from named config. Either one blank
 * is unpublished: the caller refuses `academy.verify_rate_unset` and this
 * limiter is not asked. No default count and no default window.
 */

export type VerifyRate = {
  readonly max: number;
  readonly windowSeconds: number;
};

export class VerifyRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `ok` records the call. `limited` does not add another hit past the cap. */
  take(address: string, rate: VerifyRate): 'ok' | 'limited' {
    const windowMs = rate.windowSeconds * 1000;
    const at = this.now();
    const kept = (this.hits.get(address) ?? []).filter((ts) => at - ts < windowMs);
    if (kept.length >= rate.max) {
      this.hits.set(address, kept);
      return 'limited';
    }
    kept.push(at);
    this.hits.set(address, kept);
    return 'ok';
  }
}
