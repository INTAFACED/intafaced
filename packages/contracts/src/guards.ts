/**
 * Shared guards. One home, so a module imports the guard instead of copying a neighbour's.
 *
 * `isRecord` is the body most copies in the repo already use: a non-null, non-array object. It does not check the
 * prototype, so a `Date` or a class instance passes, as it does in every copy today.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
