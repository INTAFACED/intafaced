/**
 * The dormancy period for archive proposals (J-ops-console-04 #10), from the owner setting `IDENTITY_DORMANCY_DAYS`: whole
 * days, 1 to 36500. NO DEFAULT. Blank is null: no customer is proposed and the console says the period is not set. Anything
 * else malformed stops the service at start, so a typo is never read as "not set".
 */
export function parseDormancyDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 36_500)
    throw new Error('IDENTITY_DORMANCY_DAYS must be whole days from 1 to 36500, or blank');
  return Number(value);
}
