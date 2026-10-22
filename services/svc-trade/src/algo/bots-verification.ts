import { TIER_ORDER, type Principal } from '@intafaced/auth';
import { TradeError } from '../spot/types.js';

/**
 * Identity-verification gate for bots (CB-bots-10, copy-bots-otc-bots-021). Every bot create (today: TWAP, VWAP and POV
 * through `createTwap`) runs it first inside `gateAlgoCreate`, before any read or write, so a refusal leaves no parent row.
 *
 * The verification level is the caller's KYC tier carried on the identity-signed principal (`principal.tier`), the same
 * read every svc-trade order gate uses; no second identity call is made.
 *
 * OWNER LEVEL, BLANK REFUSES. `TRADE_BOTS_VERIFICATION_LEVEL` is the lowest tier allowed to create a bot
 * (`basic`, `full` or `institutional`). Unset or blank refuses every bot create (`trade.bots_verification_level_not_set`);
 * any other value stops the boot. `none` is not accepted as a level: it would mean "no verification", which is the
 * `off` switch below, never a default.
 *
 * SWITCH. `TRADE_BOTS_VERIFICATION=required|off`, unset means `required`. `off` must be written explicitly; any other value
 * stops the boot.
 */
export const TRADE_BOTS_VERIFICATION_ENV = 'TRADE_BOTS_VERIFICATION';
export const TRADE_BOTS_VERIFICATION_LEVEL_ENV = 'TRADE_BOTS_VERIFICATION_LEVEL';

export type BotVerificationLevel = Exclude<Principal['tier'], 'none'>;
const LEVELS: readonly BotVerificationLevel[] = ['basic', 'full', 'institutional'];

export type BotVerificationPolicy = { readonly mode: 'off' } | { readonly mode: 'required'; readonly level: BotVerificationLevel | null };

export function loadBotVerificationPolicy(env: Record<string, string | undefined>): BotVerificationPolicy {
  const mode = env[TRADE_BOTS_VERIFICATION_ENV];
  if (mode === 'off') return { mode: 'off' };
  if (mode !== undefined && mode !== 'required') {
    throw new Error(`${TRADE_BOTS_VERIFICATION_ENV} must be "required" or "off" (got ${JSON.stringify(mode)}); refusing to boot`);
  }
  const raw = env[TRADE_BOTS_VERIFICATION_LEVEL_ENV]?.trim() ?? '';
  if (raw === '') return { mode: 'required', level: null };
  if (!(LEVELS as readonly string[]).includes(raw)) {
    throw new Error(
      `${TRADE_BOTS_VERIFICATION_LEVEL_ENV} must be one of ${LEVELS.join(', ')} (got ${JSON.stringify(raw)}); refusing to boot`,
    );
  }
  return { mode: 'required', level: raw as BotVerificationLevel };
}

/** Refuse a bot create below the owner's level. Pure: reads nothing but its arguments. */
export function assertBotVerification(policy: BotVerificationPolicy, tier: Principal['tier']): void {
  if (policy.mode === 'off') return;
  if (policy.level === null) {
    throw new TradeError('The verification level required for bots is not set', 'trade.bots_verification_level_not_set');
  }
  const have = TIER_ORDER[tier];
  if (typeof have !== 'number' || have < TIER_ORDER[policy.level]) {
    throw new TradeError(`Verification "${policy.level}" is required to create a bot`, 'trade.bots_verification_insufficient', {
      required: policy.level,
    });
  }
}
