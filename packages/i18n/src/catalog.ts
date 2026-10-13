/**
 * The message catalog — §9: "all surfaces keyed from day one; 100+ languages =
 * translation files, not refactors".
 *
 * English is the source of truth, and as of 2026-08-03 it is the ONLY language
 * in this repo: there is no second catalog file, and no surface in `apps/web`
 * renders through this one. §9 is the target this file is shaped for, not a
 * description of where we are. `catalogs.ts` holds the measured version.
 *
 * Every other language is a `Catalog` derived from English, and the type system
 * enforces that derivation: a translation missing a key is a COMPILE error, not
 * a `undefined` that reaches a user as a blank button. That is the entire reason
 * this package exists before the surfaces do.
 *
 * Conventions:
 *  - Keys are dot-namespaced by surface: `<surface>.<area>.<thing>`.
 *  - Placeholders are `{name}` and are extracted into the type of `t()`, so a
 *    forgotten interpolation param is also a compile error.
 *  - A message that varies with a count is a `PluralMessage`, never a hand-rolled
 *    `n === 1 ? a : b` — see `t.ts`.
 *  - Copy obeys Doctrine §0.7: no third-party system names, ever.
 */

/** CLDR plural categories. Which of these a language uses is `Intl`'s business, not ours. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * A count-dependent message. `other` is mandatory because CLDR guarantees every
 * language has it; the rest are supplied per language as that language requires.
 */
export type PluralMessage = { readonly [C in PluralCategory]?: string } & { readonly other: string };

export type Message = string | PluralMessage;

// ── English — the source of truth ───────────────────────────────────────────

export const en = {
  // ── common · actions, states, labels ──────────────────────────────────────
  'common.action.confirm': 'Confirm',
  'common.action.cancel': 'Cancel',
  'common.action.save': 'Save',
  'common.action.continue': 'Continue',
  'common.action.back': 'Back',
  'common.action.close': 'Close',
  'common.action.retry': 'Try again',
  'common.action.copy': 'Copy',
  'common.action.copied': 'Copied',
  'common.action.search': 'Search',
  'common.state.loading': 'Loading…',
  'common.state.empty': 'Nothing here yet',
  'common.label.amount': 'Amount',
  'common.label.total': 'Total',
  'common.label.fee': 'Fee',
  'common.label.status': 'Status',
  'common.label.date': 'Date',
  'common.results': { one: '{count} result', other: '{count} results' },

  // ── auth ──────────────────────────────────────────────────────────────────
  'auth.login.title': 'Sign in',
  'auth.login.subtitle': 'Sovereign access to your account.',
  'auth.login.emailLabel': 'Email',
  'auth.login.emailPlaceholder': 'you@example.com',
  'auth.login.passwordLabel': 'Password',
  'auth.login.submit': 'Sign in',
  'auth.login.forgotPassword': 'Forgot your password?',
  'auth.login.noAccount': 'Create an account',
  'auth.register.title': 'Create your account',
  'auth.register.submit': 'Create account',
  'auth.twofa.title': 'Two-factor verification',
  'auth.twofa.prompt': 'Enter the {digits}-digit code from your authenticator app.',
  'auth.webauthn.prompt': 'Confirm with your security key.',
  'auth.logout': 'Sign out',
  'auth.session.expired': 'Your session has expired. Sign in again.',
  'auth.email_taken': 'An account with that email already exists.',
  'auth.handle_taken': 'That handle is already taken.',
  'auth.kyc.upgrade': 'Raise your limits',

  // ── trade ─────────────────────────────────────────────────────────────────
  'trade.order.submit': 'Place order',
  'trade.order.buy': 'Buy',
  'trade.order.sell': 'Sell',
  'trade.order.typeLimit': 'Limit',
  'trade.order.typeMarket': 'Market',
  'trade.order.price': 'Price',
  'trade.order.quantity': 'Quantity',
  'trade.order.total': 'Order total',
  'trade.order.confirmTitle': 'Confirm order',
  'trade.order.confirmBody': '{side} {qty} {symbol} at {price}.',
  'trade.order.cancelled': 'Order cancelled',
  'trade.filled': 'Filled {qty} {symbol}',
  'trade.openOrders': { one: '{count} open order', other: '{count} open orders' },
  'trade.book.bids': 'Bids',
  'trade.book.asks': 'Asks',
  'trade.positions.title': 'Positions',
  'trade.positions.empty': 'No open positions',
  'trade.pair.change24h': '24h change',
  'trade.convert.title': 'Convert',
  'trade.convert.rate': '1 {from} = {rate} {to}',

  // ── wallet · balances ─────────────────────────────────────────────────────
  'wallet.title': 'Wallet',
  'wallet.balance.available': 'Available',
  'wallet.balance.locked': 'On hold',
  'wallet.balance.total': 'Total balance',
  'wallet.deposit': 'Deposit',
  'wallet.withdraw': 'Withdraw',
  'wallet.transfer': 'Transfer',
  'wallet.address.label': 'Deposit address',
  'wallet.address.warning': 'Send only {asset} on {network} to this address.',
  'wallet.withdraw.addressLabel': 'Destination address',
  'wallet.withdraw.allowlistOnly': 'Withdrawals go to allow-listed addresses only.',
  'wallet.withdraw.holdNotice': { one: 'Held for {count} hour', other: 'Held for {count} hours' },
  'wallet.history.title': 'Activity',
  'wallet.assets': { one: '{count} asset', other: '{count} assets' },
  'wallet.confirmations': { one: '{count} confirmation', other: '{count} confirmations' },

  // ── p2p ───────────────────────────────────────────────────────────────────
  'p2p.title': 'P2P',
  'p2p.offer.buy': 'Buy {asset}',
  'p2p.offer.sell': 'Sell {asset}',
  'p2p.offer.create': 'Post an offer',
  'p2p.offer.paymentMethods': 'Payment methods',
  'p2p.offer.priceLabel': 'Price per {asset}',
  'p2p.trade.escrowLocked': 'Escrow locked',
  'p2p.trade.markPaid': 'I have paid',
  'p2p.trade.releaseFunds': 'Release funds',
  'p2p.trade.dispute': 'Open a dispute',
  'p2p.trade.timeRemaining': 'Time remaining',
  'p2p.merchant.badge': 'Verified merchant',
  'p2p.merchant.trades': { one: '{count} trade', other: '{count} trades' },

  // ── notify · in-app inbox (title + body per kind; keys stored on the row) ──
  'notify.trade.fill.title': 'Order filled',
  'notify.outreach.enquiry_acknowledgement.title': 'Your INTAFACED enquiry',
  'notify.outreach.enquiry_acknowledgement.body':
    'Thanks for your interest in INTAFACED. We’ve received your contact details. The team reviews enquiries before arranging calls.',
  'notify.outreach.information_request.title': 'A question about your INTAFACED enquiry',
  'notify.outreach.information_request.body': 'The INTAFACED team has a question about your enquiry.\n\n{staffText}',
  'notify.outreach.call_invitation.title': 'A conversation about your INTAFACED enquiry',
  'notify.outreach.call_invitation.body':
    'The INTAFACED team has reviewed your enquiry and would like to arrange a conversation.\n\n{staffText}',
  'notify.outreach.follow_up.title': 'Following up on your INTAFACED enquiry',
  'notify.outreach.follow_up.body': 'The INTAFACED team is following up on your enquiry.\n\n{staffText}',
  'notify.trade.fill.body': '{side} {qty} on {marketId} at {price}.',
  'notify.trade.order.terminal.title': 'Order {status}',
  'notify.trade.order.terminal.body': '{side} {qty} on {marketId} is {status}.',
  // Liquidation copy names only fields the payload guarantees are present.
  // Realised loss, mark price and liquidation price are all nullable on
  // `trade.position.updated`, so none of them appears here: a notification that
  // interpolated a missing number would print an empty gap on the one message
  // where a number is what the reader came for.
  'notify.trade.position.liquidated.title': 'Position liquidated',
  'notify.trade.position.liquidated.body': 'Your {side} position on {symbol} was liquidated. Size {contracts}, entry {entryPrice}.',
  'notify.p2p.escrow.locked.title': 'Escrow locked',
  'notify.p2p.escrow.locked.body': '{amount} {asset} locked for {fiatAmount} {fiatCurrency}.',
  'notify.p2p.escrow.released.title': 'Trade completed',
  'notify.p2p.escrow.released.body': '{amount} {asset} released. Fee {fee}.',
  'notify.p2p.escrow.refunded.title': 'Escrow refunded',
  'notify.p2p.escrow.refunded.body': '{amount} {asset} returned to the seller ({reason}).',
  'notify.p2p.trade.disputed.title': 'Trade disputed',
  'notify.p2p.trade.disputed.body': 'Dispute opened on trade {tradeId}. Reason: {reason}.',
  'notify.identity.kyc.approved.title': 'Verification approved',
  'notify.identity.kyc.approved.body': 'You are verified at the {tier} tier.',
  'notify.identity.rank.updated.title': 'Rank updated',
  'notify.identity.rank.updated.body': 'You moved from rank {previousRank} to rank {rank}.',
  'notify.token.stake.created.title': 'Stake locked',
  'notify.token.stake.created.body': '{amount} staked on the {tier} tier.',
  'notify.agents.action.rejected.title': 'Agent action refused',
  'notify.agents.action.rejected.body': 'A guardrail blocked {tool} ({refusalCode}).',
  'notify.agents.action.completed.title': 'Agent action finished',
  'notify.agents.action.completed.body': 'Your agent finished ({kind}).',
  'notify.bank.margin_call.title': 'Margin call on your loan',
  'notify.bank.margin_call.body':
    'Add {cureCollateralAmount} {collateralAssetId} before {graceExpiresAt} or part of your collateral may be sold.',

  // ── notify · out-of-app channels ──────────────────────────────────────────
  // Rendered server-side by svc-notify for email / SMS / push, from this same
  // catalog — so an out-of-app message can never carry copy that a screen could
  // not (§9), and never a provider's name (§0.7).
  'notify.channel.verify.title': 'Confirm this address',
  'notify.channel.verify.body': 'Your confirmation code is {code}. It expires in {minutes} minutes.',
  'notify.channel.footer': 'You are receiving this because you confirmed this address for account alerts.',
  // v22.alerts — fire path uses these keys; missing catalog fell back to the key string.
  'notify.alert.price.crossed.title': 'Price alert',
  'notify.alert.price.crossed.body': '{marketId} crossed {direction} {targetPrice} (mark {markPrice}).',
  'notify.alert.funding.crossed.title': 'Funding watch',
  'notify.alert.funding.crossed.body': 'Funding watch on {marketId} crossed {direction} {targetPrice} (mark {markPrice}).',
  'notify.alert.liquidation_proximity.crossed.title': 'Liquidation-proximity watch',
  'notify.alert.liquidation_proximity.crossed.body':
    'Liquidation-proximity watch on {marketId} crossed {direction} {targetPrice} (mark {markPrice}).',
  'notify.alert.whale.crossed.title': 'Whale-flow watch',
  'notify.alert.whale.crossed.body': 'Whale-flow watch on {marketId} crossed {direction} {targetPrice} (flow {markPrice}).',

  // ── errors ────────────────────────────────────────────────────────────────
  'error.insufficientFunds': 'Insufficient balance.',
  'error.generic': 'Something went wrong. Try again.',
  'error.network': 'No connection. Check your network.',
  'error.notFound': 'We could not find that.',
  'error.unauthorized': 'Sign in to continue.',
  'error.forbidden': 'You do not have access to this.',
  'error.rateLimited': 'Too many requests. Wait a moment.',
  'error.validation.required': 'This field is required.',
  'error.validation.invalidAmount': 'Enter a valid amount.',
  'error.validation.invalidAddress': 'That address is not valid for {network}.',
  'error.validation.minLength': { one: 'Use at least {count} character', other: 'Use at least {count} characters' },
  'error.order.belowMinimum': 'Minimum order size is {min} {asset}.',
  'error.withdrawal.limitReached': 'You have reached your withdrawal limit for {period}.',
  'error.kyc.required': 'Verification is required for this action.',
  'error.region.blocked': 'This is not available in your region.',

  // ── support · KB spine (keys only — svc-support listKb) ───────────────────
  // No third-party product names (§0.7). Bodies stay general platform help.
  'support.kb.account_access.title': 'Sign-in and account access',
  'support.kb.account_access.body':
    'If you cannot sign in, use account recovery from the sign-in screen. Support never asks for your password or recovery codes in chat.',
  'support.kb.security_basics.title': 'Security basics',
  'support.kb.security_basics.body':
    'Enable two-factor verification, review sessions, and treat unexpected withdrawal prompts as urgent. We never ask you to move funds to “verify” an account.',
  'support.kb.orders_status.title': 'Order status',
  'support.kb.orders_status.body':
    'Open, partial, and filled orders show in your order history. Support can confirm status; it cannot invent fills that the trade service did not record.',
  'support.kb.deposit_withdraw.title': 'Deposits and withdrawals',
  'support.kb.deposit_withdraw.body':
    'Deposits credit when the network confirms; withdrawals follow your account limits. Support cannot invent balances or speed up the chain.',
  'support.kb.paper_vs_live.title': 'Paper vs live trading',
  'support.kb.paper_vs_live.body':
    'Paper drills never move real funds. Live orders do. Labels must stay honest — paper progress is never withdrawable balance.',

  // ── agents · grounded refuse copy ─────────────────────────────────────────
  'agents.session.opened': 'Sovereign Intelligence session opened for {agent}.',
  'agents.session.closed': 'Session closed. {steps} action(s) recorded.',
  'agents.action.completed': 'The Neural Engine answered for “{task}”.',
  'agents.action.executed': 'Ran {tool} inside your guardrails.',
  'agents.usage.settled': 'Metered usage for this session settled: {amount} {asset}.',
  'agents.usage.free': 'This session is on your included allowance — nothing was charged.',
  'agents.refused.tool_not_declared': 'Refused: {tool} is not in this agent’s declared toolset, so it was not run.',
  'agents.refused.task_not_allowed': 'Refused: “{task}” is not among this agent’s allowed tasks.',
  'agents.refused.tool_call_limit': 'Refused: {tool} has already been used {limit} time(s) this session, which is its limit.',
  'agents.refused.module_not_allowed': 'Refused: this agent is not permitted to act in {module}.',
  'agents.refused.step_limit': 'Refused: this session has reached its limit of {limit} action(s).',
  'agents.refused.spend_limit': 'Refused: this session has reached its spend limit of {limit} {asset}.',
  'agents.refused.output_limit': 'Refused: the request asked for more output than this agent is allowed to produce.',
  'agents.refused.approval_required': 'Held for your approval: {tool} needs you to confirm before it runs.',
  'agents.refused.session_closed': 'Refused: this session is closed. Start a new one to continue.',
  'agents.refused.mode_unknown': 'Refused: this session has no recognised trading mode, so {tool} was not run.',
  'agents.refused.mode_forbids_write': 'Refused: {mode} sessions cannot place, amend, cancel, or withdraw — {tool} was not run.',
  'agents.refused.withdraw_scope_required': 'Refused: agent credentials do not include withdrawal, so {tool} was not run.',
  'agents.refused.place_idempotency_required':
    'Refused: placing an order needs a stable intent key so a repeated message cannot duplicate it.',
  'agents.refused.log_mine_limit_unset': 'Refused: a page size is required for your activity log — none was given.',
  'agents.refused.kb_search_limit_unset': 'Refused: a page size is required to search support knowledge — none was given.',
  'agents.error.route_not_found': 'No Sovereign Intelligence route is configured for “{task}”.',
  'agents.error.capability_unavailable': 'The Neural Engine cannot serve this kind of request right now.',
  'agents.error.engine_unavailable': 'The Neural Engine is unavailable. Nothing was run and nothing was charged.',
  'agents.error.window_sealed': 'This usage period is already settled.',
  'agents.error.request_id_replay':
    'That request was already processed for this session — start a new request rather than reusing the same id.',
  'agents.scanner.empty': 'No markets were provided to rank.',
  'agents.scanner.unavailable': 'Market signals are unavailable right now — quotes are missing or too old to trust.',
  'agents.scanner.tier_closed':
    'This Sovereign Intelligence scanner action is closed until product tier rules are published — nothing was invented or ranked.',
  'agents.scanner.signal_inputs_closed':
    'This Sovereign Intelligence scanner action is closed until market signal input rules are published — nothing was invented or ranked.',
  'agents.scanner.rank_limit_unset': 'Refused: a page size is required to rank markets — none was given.',
  'agents.scanner.tickers_limit_unset': 'Refused: a page size is required to list market quotes — none was given.',
  'agents.merchant.empty': 'No approval-rate samples were provided to watch.',
  'agents.merchant.unavailable': 'Approval-rate metrics are unavailable right now — samples are missing or too old to trust.',
  'agents.copy_intel.empty': 'No leader performance samples were provided.',
  'agents.copy_intel.unavailable': 'Leader stats are unavailable — samples are incomplete or the window is invalid.',
  'agents.navigator.empty': 'Nothing was asked, so nothing was looked up and nothing was charged.',
  'agents.navigator.unavailable': 'Market data is unavailable right now — the navigator will not invent quotes or routes.',
  'agents.navigator.tier_closed':
    'This Sovereign Intelligence navigator action is closed until product tier rules are published — nothing was invented or run.',
  'agents.navigator.markets_limit_unset': 'Refused: a page size is required to list markets — none was given.',
  'agents.support.empty': 'Nothing was asked, so nothing was looked up and nothing was charged.',
  'agents.support.unavailable': 'Support knowledge is unavailable right now — the desk will not invent an answer.',
  'agents.support.comment_refused': 'That comment cannot be posted — missing ticket, empty body, or forbidden invent language.',
  'agents.support.tier_closed':
    'This Sovereign Intelligence support action is closed until product tier rules are published — nothing was read or answered.',
  'agents.support.escalated': 'This one goes to a person — a support ticket has the answer, and nothing was guessed here.',

  // ── admin · operator console (status / kill-switch / banner) ──────────────
  'admin.console.reach.module': 'halt a module (stop new commitments on one market)',
  'admin.console.reach.treasury': 'freeze the ledger (stop ALL value movement platform-wide)',
  'admin.console.unconfigured.one': 'This console cannot {reach} — {name} is not set on this app.',
  'admin.console.unconfigured.many': 'This console cannot {reach} — {names} are not set on this app.',
  'admin.console.banner.chip.none': 'Cannot halt anything',
  'admin.console.banner.chip.partial': 'Partly unconfigured',
  'admin.console.banner.title.none': 'This console cannot halt anything. Every switch below is inert.',
  'admin.console.banner.title.partial': 'This console cannot reach every platform switch.',
  'admin.console.banner.item.lead': 'Cannot {reach} — set',
  'admin.console.banner.disclaimer':
    'Nothing here is a value: these are variable names on the admin container. See docs/OWNER-OPS-CHECKLIST-2026-07-31.md §7.',
  'admin.console.plane.reachable': 'Control plane: reachable',
  'admin.console.plane.unconfigured': 'Control plane: not configured',
  'admin.console.plane.unreachable': 'Control plane: unreachable',
} as const;

/** The English catalog's exact shape — the thing every other language is measured against. */
export type EnCatalog = typeof en;

/** Every key that exists. Adding one here is what makes it usable in `t()`. */
export type MessageKey = keyof EnCatalog;

/**
 * A complete translation. Every key is required and must keep English's shape
 * (a plural message stays plural), so `defineCatalog` fails to compile the
 * moment a key is added to English and not to a translation.
 */
export type Catalog = {
  readonly [K in MessageKey]: EnCatalog[K] extends string ? string : PluralMessage;
};

/**
 * A translation in progress. Real language files land incomplete and catch up —
 * that is normal, and `createTranslator` falls back to English per key. What is
 * NOT allowed is a key nobody ever wrote in English.
 */
export type PartialCatalog = {
  readonly [K in MessageKey]?: EnCatalog[K] extends string ? string : PluralMessage;
};

/**
 * Declare a complete catalog. Use this in every language file: it is the line
 * of defence that turns "we forgot to translate the withdraw button" into a
 * build failure instead of a support ticket.
 */
export function defineCatalog(messages: Catalog): Catalog {
  return messages;
}

/** Declare a translation that is still being filled in. Missing keys fall back to English. */
export function definePartialCatalog(messages: PartialCatalog): PartialCatalog {
  return messages;
}

/** Runtime view of the key list — for scanners, coverage reports, and tests. */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(en) as MessageKey[];

/** True when the key exists in the English source of truth. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/** True when the message varies by count. */
export function isPluralMessage(message: Message | undefined): message is PluralMessage {
  return typeof message === 'object' && message !== null && typeof message.other === 'string';
}

/**
 * Translation coverage for ONE language, as a fraction of the English key set.
 *
 * For the whole picture use `localeCoverage()` in `catalogs.ts` — it reports a
 * row per declared locale including the 27 that have no catalog at all, which is
 * the part a dashboard built on this function alone would silently omit. "We
 * support 100+ languages" is a §9 target; what these two functions return is the
 * measurement, and today it is one.
 */
export function coverage(catalog: PartialCatalog): { translated: number; total: number; missing: MessageKey[] } {
  const missing = MESSAGE_KEYS.filter((key) => catalog[key] === undefined);
  return { translated: MESSAGE_KEYS.length - missing.length, total: MESSAGE_KEYS.length, missing };
}

// ── Placeholder types ───────────────────────────────────────────────────────

/** Pull `{name}` placeholders out of a literal message at the type level. */
type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;

/**
 * The params a message requires. Plural messages always require `count`; the
 * rest come from the placeholders in the message itself.
 */
export type ParamsOf<M> = M extends string ? Placeholders<M> : M extends PluralMessage ? Placeholders<M['other']> | 'count' : never;

/** The params `t(key, …)` demands for a given key. */
export type ParamsFor<K extends MessageKey> = ParamsOf<EnCatalog[K]>;
