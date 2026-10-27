/**
 * What a look baseline is, for the two gates that guard them: test-diff-guard.mjs (the room must be named on a
 * `Baseline-change:` line) and review-marker.mjs (the independent review is required). One definition, so they agree.
 *
 * A baseline is any file under a `look-baselines/<room>/` folder anywhere in the repo, for example
 * `apps/customer/look-baselines/home/390x844.png` (room `home`) or `packages/ui/look-baselines/kit-buttons/phone/a.png`.
 */
export const BASELINE = /(?:^|\/)look-baselines\/([^/]+)\/.+$/;

/** The room a baseline belongs to, or null when the path is not a baseline. */
export function roomOf(path) {
  return BASELINE.exec(path)?.[1] ?? null;
}
