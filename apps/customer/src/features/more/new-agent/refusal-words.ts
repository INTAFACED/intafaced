import type { ApiResult } from '../../../shared/api';
import type { agentBuilderCopy } from '../agent-builder-copy';

/**
 * The words for svc-agents' own refusals of an agent of the person's own: which code it is, and what it says. Pure
 * logic shared by the builder (`AgentBuilder.tsx`'s `Refusal`) and the New agent room, so both say the same words.
 */

/** Each refusal and finding code the service sends, with the words for it (the reserved name takes the name). */
const CODE_WORDS = {
  'agents.spend.per_call_above_session': 'code_spend_per_call_above_session',
  'agents.own.money_tool': 'code_own_money_tool',
  'agents.tool_shape_missing': 'code_tool_shape_missing',
  'agents.own.tool_unknown': 'code_own_tool_unknown',
  'agents.own.name_too_long': 'code_own_name_too_long',
  'agents.own.instructions_too_long': 'code_own_instructions_too_long',
  'agents.own.cap_invalid': 'code_own_cap_invalid',
  'agents.own.template_unknown': 'code_own_template_unknown',
  'agents.own.not_found': 'code_own_not_found',
  'agents.own.text_invalid': 'code_own_text_invalid',
  'agents.own.too_many': 'code_own_too_many',
  'agents.own.name_unset': 'code_own_name_unset',
  'agents.spend.cap_unset': 'code_spend_cap_unset',
  'agents.spend.cap_exceeded': 'code_spend_cap_exceeded',
  'agents.usage.hard_limit_reached': 'code_usage_hard_limit_reached',
  'agents.usage.limit_invalid': 'code_usage_limit_invalid',
  'agents.usage.alert_above_limit': 'code_usage_alert_above_limit',
  'agents.funds_insufficient': 'code_funds_insufficient',
  'agents.funds_unread': 'code_funds_unread',
  'agents.payment_method.wallet_not_linked': 'code_payment_method_wallet_not_linked',
  'agents.payment_method.account_inactive': 'code_payment_method_account_inactive',
  'agents.payment_method.wallets_unread': 'code_payment_method_wallets_unread',
  'agents.price_unset': 'code_price_unset_unread',
  'agents.spend_limit': 'code_spend_limit',
  'agents.request_id_replay': 'code_request_id_replay',
  'agents.session_closed': 'code_session_closed',
  'agents.session_not_found': 'code_session_not_found',
  'agents.window_unpaid': 'code_window_unpaid',
  'agents.overage_grace_unset': 'code_overage_grace_unset',
  'agents.overage_grace_exceeded': 'code_overage_grace_exceeded',
  'agents.window_sealed': 'code_window_sealed',
  'agents.own.surface_not_reviewed': 'code_own_surface_not_reviewed',
  'agents.own.surface_unknown': 'code_own_surface_unknown',
  'agents.own.co_owner_group': 'code_own_co_owner_group',
  'agents.own.co_owner_invalid': 'code_own_co_owner_invalid',
  'agents.own.co_owner_self': 'code_own_co_owner_self',
  'agents.own.co_owner_unread': 'code_own_co_owner_unread',
  'agents.own.co_owner_inactive': 'code_own_co_owner_inactive',
  'agents.own.delete_unconfirmed': 'code_own_delete_unconfirmed',
  'agents.own.delete_published': 'code_own_delete_published',
  'agents.own.delete_has_sessions': 'code_own_delete_has_sessions',
  'agents.agent.disabled': 'code_agent_disabled',
} as const;
export const wordsKey = (code: string) => (Object.hasOwn(CODE_WORDS, code) ? CODE_WORDS[code as keyof typeof CODE_WORDS] : null);

export type Failed = Extract<ApiResult<unknown>, { ok: false }>;
/**
 * The service's own refusals arrive as an `agents.` code, whatever the status (a run's refusal is 403, a session of
 * someone else's is 404); anything else (a timeout, a gateway answer, a write that may have gone through) is not one.
 */
const REFUSAL_REASONS: ReadonlySet<Failed['reason']> = new Set(['error', 'forbidden', 'not_mounted']);
export const refusalCode = (failed: Failed): string | null =>
  REFUSAL_REASONS.has(failed.reason) && /^agents\.[a-z_.]+$/.test(failed.message) ? failed.message : null;

/** The words' parameters a refused run's row carries (`own.runs`): a funds refusal names its method, figure and source. */
export type RefusalParams = Readonly<Record<string, string | number>>;
type BuilderT = ReturnType<typeof agentBuilderCopy.useCopy>['t'];
/** The test networks a TEST stack's chain stands in for: their figures are labelled TEST. */
const TEST_CHAIN_IDS: ReadonlySet<string> = new Set(['84532', '31337', '11155111']);
const FUNDS_WHY = {
  payment_token_unset: 'fundsWhy_payment_token_unset',
  wallet_unlinked: 'fundsWhy_wallet_unlinked',
  account_inactive: 'fundsWhy_account_inactive',
  identity_unreachable: 'fundsWhy_identity_unreachable',
  chain_unreachable: 'fundsWhy_chain_unreachable',
  chain_mismatch: 'fundsWhy_chain_mismatch',
  method_unread: 'fundsWhy_method_unread',
} as const;
export const shortAddress = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);
const text = (params: RefusalParams, key: string) => (params[key] === undefined ? '' : String(params[key]));

/**
 * A funds refusal of a run paid from a wallet: the wallet, its figure with its source and as-of time, or why its amount
 * could not be read (J-agents-02 #4). Null when the refusal names no wallet, so today's words stand.
 */
function walletFundsWords(t: BuilderT, code: string, params: RefusalParams): string | null {
  if (params.method !== 'wallet' || typeof params.address !== 'string') return null;
  const address = shortAddress(params.address);
  if (code === 'agents.funds_insufficient') {
    const chainId = text(params, 'chainId');
    const block = text(params, 'block');
    const asOf = new Date(text(params, 'asOf'));
    return t('fundsWalletInsufficient', {
      address,
      available: text(params, 'available'),
      token: text(params, 'token'),
      asset: text(params, 'asset'),
      worstCase: text(params, 'worstCase'),
      source: t(TEST_CHAIN_IDS.has(chainId) ? 'fundsSourceTestChain' : 'fundsSourceChain', { chainId, block }),
      asOf: Number.isNaN(asOf.getTime()) ? text(params, 'asOf') : asOf.toLocaleString(),
    });
  }
  if (code === 'agents.funds_unread') {
    const reason = text(params, 'reason');
    const why = Object.hasOwn(FUNDS_WHY, reason) ? FUNDS_WHY[reason as keyof typeof FUNDS_WHY] : 'fundsWhy_method_unread';
    return t('fundsWalletUnread', { address, why: t(why) });
  }
  return null;
}

/** A refusal code as words: a wallet's funds, the reserved name, a cap, a blank rate, or the code's own words. */
export function refusalWords(
  t: BuilderT,
  code: string,
  {
    name = '',
    cap = '',
    asset = '',
    task = '',
    params = {},
  }: { name?: string; cap?: string; asset?: string; task?: string; params?: RefusalParams },
): { words: string; wallet: string | null } {
  const key = wordsKey(code);
  const wallet = walletFundsWords(t, code, params);
  const words =
    wallet !== null
      ? wallet
      : code === 'agents.own.reserved_name'
        ? t('code_own_reserved_name', { name })
        : code === 'agents.spend.above_agent_cap'
          ? t('code_spend_above_agent_cap', { cap, asset })
          : code === 'agents.price_unset'
            ? task
              ? t('code_price_unset', { task })
              : t('code_price_unset_unread')
            : key
              ? t(key)
              : t('code_other');
  return { words, wallet };
}
