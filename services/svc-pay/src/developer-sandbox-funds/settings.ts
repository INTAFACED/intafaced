/**
 * The owner's two sandbox settings (DV-sandbox-02). Both are TEST magnitudes for a store that holds no money, and both
 * stay blank until set: a blank fund amount refuses Fund, a blank cap refuses Reset. Nothing here has a default.
 *
 *   PAY_SANDBOX_FUND_AMOUNT       the TEST USDT one press of Fund adds, a positive decimal (at most 6 places)
 *   PAY_SANDBOX_RESETS_PER_DAY    how many times a sandbox's balances may be reset in one UTC day, a positive integer
 *
 * A value that is set but malformed stops the service at boot rather than reading as blank.
 */
export interface SandboxFundSettings {
  readonly fundAmount: string | null;
  readonly resetsPerDay: number | null;
}

const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;

export function loadSandboxFundSettings(env: Record<string, string | undefined>): SandboxFundSettings {
  const amount = env.PAY_SANDBOX_FUND_AMOUNT?.trim() ?? '';
  const resets = env.PAY_SANDBOX_RESETS_PER_DAY?.trim() ?? '';
  if (amount && (!AMOUNT.test(amount) || !/[1-9]/.test(amount))) {
    throw new Error('PAY_SANDBOX_FUND_AMOUNT must be a positive decimal with at most 6 places, or blank');
  }
  if (resets && !/^[1-9]\d{0,3}$/.test(resets)) {
    throw new Error('PAY_SANDBOX_RESETS_PER_DAY must be a positive whole number, or blank');
  }
  return { fundAmount: amount || null, resetsPerDay: resets ? Number(resets) : null };
}
