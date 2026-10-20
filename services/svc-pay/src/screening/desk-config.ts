/**
 * `PAY_SCREENING_RELEASE_TTL_SECONDS`: how long a compliance release stays spendable. The owner sets it; there is no
 * default. Blank or unset means a release is refused (`screening.release_ttl_unset`). A value that is set but is not a
 * positive whole number FAILS BOOT: a typo must not quietly turn a release into "never expires" or "refused".
 */
export const PAY_SCREENING_RELEASE_TTL_ENV = 'PAY_SCREENING_RELEASE_TTL_SECONDS';

export function loadScreeningReleaseTtl(env: Record<string, string | undefined>): number | null {
  const raw = env[PAY_SCREENING_RELEASE_TTL_ENV]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) {
    throw new Error(
      `${PAY_SCREENING_RELEASE_TTL_ENV} must be a positive whole number of seconds (got ${JSON.stringify(raw)}); refusing to boot`,
    );
  }
  return Number(raw);
}
