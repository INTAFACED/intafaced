/**
 * The owner's own freeze at the agent doors (J-wallet-13 #2): while it is on, nothing that gives an agent permission to
 * act for the person is made or changed here (an agent account, its funding, cap or limits, an assistant connection, an
 * own-agent allowance), and the person is told why. The freeze is svc-identity's: it is read on each call through its
 * own door (`GET /internal/self-freeze/:userId`), never from a copy here. A freeze that can't be read refuses too (fail
 * closed), and so does a deployment where it can't be read at all.
 */
import type { Principal } from '@intafaced/auth';
import { AccountFreezeUnavailable, type AccountFreezeRead } from '../quant/live-run/ports.js';
import { AgentAccountError } from './agent-account.js';

const SELF_FROZEN_CODE = 'trade.account_frozen_self';
const SELF_FREEZE_UNAVAILABLE_CODE = 'trade.freeze_unavailable';

/** The freeze reason, as the person reads it at each refused door. */
function selfFrozenMessage(action: string): string {
  return `you froze this account, so ${action} is refused: INTAFACED gives no agent permission to act for you while the freeze is on. Your funds stay in your own wallet and venue account, which only your wallet controls.`;
}

export async function assertNotSelfFrozen(freeze: AccountFreezeRead | null, userId: string, action: string): Promise<void> {
  if (!freeze) {
    throw new AgentAccountError(
      SELF_FREEZE_UNAVAILABLE_CODE,
      `the account freeze can't be read on this deployment, so ${action} is refused; nothing changed`,
      503,
    );
  }
  let frozen: boolean;
  try {
    frozen = await freeze.frozen(userId);
  } catch (error) {
    if (!(error instanceof AccountFreezeUnavailable)) throw error;
    throw new AgentAccountError(
      SELF_FREEZE_UNAVAILABLE_CODE,
      `the account freeze could not be read just now, so ${action} is refused; nothing changed`,
      503,
    );
  }
  if (frozen) throw new AgentAccountError(SELF_FROZEN_CODE, selfFrozenMessage(action), 423);
}

/**
 * The person, as the door knows them, for what the freeze event does with no request in hand, the way the live-run
 * supervisor acts (quant/live-run/live-runs.ts `ownerPrincipal`): the tier is the caller's to pass, and every caller here
 * passes `none`, since revoking, cancelling and reading take risk off and ask no trading level.
 */
export function freezePrincipal(userId: string, tier: Principal['tier']): Principal {
  return {
    sub: userId,
    userId,
    sid: `self-freeze:${userId}`,
    scopes: ['trade:read', 'trade:write'],
    tier,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}
