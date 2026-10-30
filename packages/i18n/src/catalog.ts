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
  'auth.too_many_attempts': 'Too many attempts. Wait before trying again, or sign in with a passkey.',
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
  'notify.trade.market_halted.title': 'Market halted',
  'notify.trade.market_halted.body': 'New submits on {marketId} are refused. Cancels remain available.',
  // Posting freeze notices are platform-wide and say nothing about why: the internal reason and actor never reach a customer.
  'notify.ledger.freeze.set.title': 'Postings paused',
  'notify.ledger.freeze.set.body':
    'New postings are paused across the platform. Existing balances are unchanged. We will post here when the pause ends.',
  'notify.ledger.freeze.cleared.title': 'Postings resumed',
  'notify.ledger.freeze.cleared.body': 'Postings are running again. The earlier pause notice stays in your history.',
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
  'notify.p2p.trade.fiat_sent.title': 'The buyer marked the order paid',
  'notify.p2p.trade.fiat_sent.body': 'Check that the payment for trade {tradeId} arrived in your account before you release.',
  'notify.p2p.offer.paused.title': { one: 'Ad paused: payment method removed', other: 'Ads paused: payment method removed' },
  'notify.p2p.offer.paused.body': {
    one: 'You removed the last payment method for {count} of your ads, so it is paused. Add a payment method it can be paid with, then resume it from My offers.',
    other:
      'You removed the last payment method for {count} of your ads, so they are paused. Add a payment method they can be paid with, then resume them from My offers.',
  },
  'notify.p2p.remark_case.opened.title': 'A payment-note remark was reported',
  'notify.p2p.remark_case.opened.body':
    'The other person on this order reported a remark in a payment note. A case is open for staff to decide.',
  'notify.identity.kyc.approved.title': 'Verification approved',
  'notify.identity.kyc.approved.body': 'You are verified at the {tier} tier.',
  'notify.identity.security.totp_added.title': 'Authenticator app turned on',
  'notify.identity.security.totp_removed.title': 'Authenticator app turned off',
  'notify.identity.security.totp_replaced.title': 'Authenticator app replaced',
  'notify.identity.security.passkey_added.title': 'Passkey added',
  'notify.identity.security.passkey_removed.title': 'Passkey removed',
  'notify.identity.security.factor_changed.body':
    'A way to sign in to your account changed. If this was not you, open Security, sign out everywhere and contact Support.',
  'notify.identity.rank.updated.title': 'Rank updated',
  'notify.identity.rank.updated.body': 'You moved from rank {previousRank} to rank {rank}.',
  'notify.token.stake.created.title': 'Stake locked',
  'notify.token.stake.created.body': '{amount} staked on the {tier} tier.',
  'notify.agents.action.rejected.title': 'Agent action refused',
  'notify.agents.action.rejected.body': 'A guardrail blocked {tool} ({refusalCode}).',
  'notify.agents.action.completed.title': 'Agent action finished',
  'notify.agents.action.completed.body': 'Your agent finished ({kind}).',
  'notify.pay.request_created.title': 'Payment request',
  'notify.pay.request_created.body': '{payeeHandle} asked you for {amount} {assetId}.',
  'notify.pay.request_paid.title': 'Request paid',
  'notify.pay.request_paid.body': '{payerHandle} paid your request for {amount} {assetId}.',
  'notify.pay.transfer_received.title': 'Money received',
  'notify.pay.transfer_received.body': 'You received {amount} {assetId}.',
  'notify.pay.transfer_sent.title': 'Payment sent',
  'notify.pay.transfer_sent.body': 'You sent {amount} {assetId}.',
  // Copy trading (J-copy-bots-otc-03 #6): why a follow skipped a copy or stopped, and what the person can do. No raw code.
  'notify.trade.copy_skipped.title': 'A follow skipped a copy',
  'notify.trade.copy_skipped.body.lead_stopped':
    'The leader was suspended, so their trade was not copied for you. You can stop this follow or choose another leader.',
  'notify.trade.copy_skipped.body.risk_control':
    'One of your limits held back a copy of the leader’s trade. You can check your limits on the follow.',
  'notify.trade.copy_skipped.body.insufficient_funds':
    'Your balance did not cover a copy of the leader’s trade. You can add funds or lower the copy size.',
  'notify.trade.copy_skipped.body.max_copy_total':
    'A copy would have gone past your per-order or total limit, so it was skipped. You can raise the limit on the follow.',
  'notify.trade.copy_skipped.body.copy_slippage_exceeded':
    'The price had moved past your slippage limit, so a copy was skipped. You can widen the limit on the follow.',
  'notify.trade.copy_skipped.body.position_closed':
    'The leader closed a trade you no longer hold, so nothing was sold for you. You can see your positions on the follow.',
  'notify.trade.copy_skipped.body.refused': 'A copy of the leader’s trade could not be placed. You can see why in the follow’s skip log.',
  'notify.trade.copy_stopped.title': 'Your follow stopped copying',
  'notify.trade.copy_stopped.body.follower': 'You stopped this follow. No new trades are copied for you. You can follow again any time.',
  'notify.trade.copy_stopped.body.follower_close_only':
    'You stopped this follow. Only the leader’s closes of what you hold are still copied. You can leave the leader any time.',
  'notify.trade.copy_stopped.body.lead_stopped': 'The leader was suspended, so this follow stopped copying. You can choose another leader.',
  'notify.trade.copy_stopped.body.risk_control': 'One of your risk limits stopped this follow. You can check your limits and follow again.',
  'notify.trade.copy_stopped.body.permission_ended': 'The copy permission for this follow ended. You can grant it again on the follow.',
  'notify.bank.scheduled_reminder.title': 'Standing order coming up',
  'notify.bank.scheduled_reminder.body': 'Your standing order of {amount} {assetId} runs on {dueDate} (UTC). Make sure the money is there.',
  'notify.bank.scheduled_failed.title': 'Standing order did not go through',
  'notify.bank.scheduled_failed.body':
    'Your standing order of {amount} {assetId} could not run, and nothing was taken. Transfers shows why. Reference: {reasonCode}.',
  'notify.support.rate_request.title': 'How did we do?',
  'notify.support.rate_request.body': 'Your support request was resolved. Tell us how it went.',
  'notify.merchant.email_provider_unset.title': 'email not set up yet',
  'notify.merchant.email_provider_unset.body': 'This notice stayed in the portal. Email is not set up yet.',
  'notify.merchant.payment_refunded.title': 'Refund outcome',
  'notify.merchant.payment_refunded.body': 'Refund {outcome} for {amount} {assetId}.',
  'notify.merchant.rail_refused.title': 'Payout failed',
  'notify.merchant.rail_refused.body': 'A payout was refused ({failureCode}).',
  'notify.merchant.dispute_due.title': 'Dispute deadline',
  'notify.merchant.dispute_due.body': 'Respond to dispute {disputeId} by {responseDueAt}.',
  'notify.merchant.invited.title': 'Team invite',
  'notify.merchant.invited.body': 'You were invited to a merchant team as {role}. The invite ends {expiresAt}.',
  'notify.bank.deposit.credited.title': 'Deposit credited',
  'notify.bank.deposit.credited.body': '{amount} {asset} is in your available balance.',
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
  // An alert the person named or wrote a message for shows their own words; the service renders placeholders before it sends.
  'notify.alert.price.crossed.named.title': '{name}',
  'notify.alert.price.crossed.message.body': '{message}',
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
    'If you cannot sign in, choose “Recover account access” on the sign-in screen. It opens the password reset page, which shows the steps: ask for a code, enter it, then choose a new password. If that page says reset is not switched on, write to support and a person will help. Support never asks for your password or recovery codes in chat.',
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
  'support.kb.scam_tactics.title': 'How scams work',
  'support.kb.scam_tactics.body':
    'Scammers create urgency, promise returns that are too good to be true, and ask you to move funds, share a code or install software. A real message from us never asks for your password, a verification code, a recovery phrase or a transfer to “secure” your account. If a message pushes you to act within minutes, stop, leave the message, and open the product yourself. If you are unsure whether a message is genuine, write to support from inside the product.',
  'support.kb.spoofed_sms.title': 'Spoofed text messages',
  'support.kb.spoofed_sms.body':
    'A text message can show a sender name that is not real, and it can appear inside a thread of genuine messages. Do not tap links in a text that asks you to sign in, verify or unlock an account. Open the product yourself instead. We never ask for a verification code by text or phone. Anyone who asks for one is not us.',
  'support.kb.dusting.title': 'Unknown tokens and dust in your wallet',
  'support.kb.dusting.body':
    'Small unrequested token deposits can arrive at any address. Some exist to lure you to a look-alike site or to link your addresses together. Do not swap, approve or send them, and do not visit links in their names. Leave them untouched. If you are unsure about a deposit, write to support from inside the product.',
  'support.kb.email_compromise.title': 'If your email may be compromised',
  'support.kb.email_compromise.body':
    'Someone with access to your email can try to reset your sign-in. If you think your email was taken over, secure the email account first, then change your password, review your devices and sessions, and check your two-factor settings. Turn on two-factor verification that does not rely on email alone. If you see activity you did not start, write to support from a different channel.',

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
  'agents.refused.spend_limit_unset': 'Refused: set a spend limit before this run. No limit was given, and none was assumed.',
  'agents.refused.price_unset': 'Refused: no rate is published for “{task}”, so it does not run. No price was assumed.',
  'agents.refused.funds_insufficient': 'Refused: your available balance is below this run’s worst case, so it did not start.',
  'agents.refused.funds_unread': 'Refused: your available balance could not be read, so this run did not start. Nothing was charged.',
  'agents.refused.spend_limit_invalid': 'Refused: that spend limit is blank or not a valid amount, so it was not saved.',
  'agents.refused.spend_cap': 'Refused: this would pass your {scope} spend limit of {limit} {asset}.',
  'agents.refused.hard_limit_reached':
    'Refused: this agent reached your hard limit of {limit} {asset} for {month}. It runs again next month, or when you raise the limit.',
  'agents.refused.spend_idempotency_conflict': 'Refused: this request key was already used for a different spend change.',
  'agents.refused.spend_reservation_conflict': 'Refused: this reservation key is already in use for a different amount or session.',
  'agents.refused.spend_reservation_missing': 'Refused: that spend reservation does not exist.',
  'agents.refused.spend_reservation_closed': 'Refused: this reservation is already finished, so it was not changed.',
  'agents.refused.spend_hold_max_age_unset': 'Refused: a maximum age for unfinished spend holds was not set, so none were released.',
  'agents.refused.output_limit': 'Refused: the request asked for more output than this agent is allowed to produce.',
  'agents.refused.approval_required': 'Held for your approval: {tool} needs you to confirm before it runs.',
  'agents.refused.session_closed': 'Refused: this session is closed. Start a new one to continue.',
  'agents.refused.mode_unknown': 'Refused: this session has no recognised trading mode, so {tool} was not run.',
  'agents.refused.mode_forbids_write': 'Refused: {mode} sessions cannot place, amend, cancel, or withdraw — {tool} was not run.',
  'agents.refused.withdraw_scope_required': 'Refused: agent credentials do not include withdrawal, so {tool} was not run.',
  'agents.refused.place_idempotency_required':
    'Refused: placing an order needs a stable intent key so a repeated message cannot duplicate it.',
  'agents.refused.place_key_conflict': 'Refused: this intent key is already in use for a place on this session, so {tool} was not run.',
  'agents.refused.log_mine_limit_unset': 'Refused: a page size is required for your activity log — none was given.',
  'agents.refused.cursor_invalid': 'Refused: that page cursor is not valid — ask for the list again from the start.',
  'agents.refused.fee_asset_unset': 'Refused: the fee asset for settled usage is unset, so spend cannot be labelled.',
  'agents.refused.kb_search_limit_unset': 'Refused: a page size is required to search support knowledge — none was given.',
  'agents.refused.overage_grace_exceeded':
    'Refused: {owed} {asset} of earlier usage is still unpaid, more than the {grace} {asset} allowed unpaid, so this run did not start. It is retried on its same charge before each run; add funds if your balance is short.',
  'agents.refused.overage_grace_unset':
    'Refused: {owed} {asset} of earlier usage is still unpaid, and no allowance for unpaid usage is set, so this run did not start. It is retried on its same charge before each run; add funds if your balance is short.',
  'agents.refused.window_sealed':
    'Refused: this session’s usage period is sealed, so it takes no more runs and nothing was called. Open a new session; usage still unpaid is retried on its same charge.',
  'agents.refused.copy_intel.returns_board_refused':
    'Refused: Copy intelligence never ranks leaders by returns. It shows each leader’s disclosed stats from fills. Nothing was run or charged.',
  'agents.error.route_not_found': 'No Sovereign Intelligence route is configured for “{task}”.',
  'agents.error.capability_unavailable': 'The Neural Engine cannot serve this kind of request right now.',
  'agents.error.engine_unavailable': 'The Neural Engine is unavailable. Nothing was run and nothing was charged.',
  'agents.error.window_sealed': 'This usage period is already settled.',
  'agents.error.window_unpaid':
    'A usage window could not be paid, so the session stays open. Add funds: the window is retried on its same charge when you close the session or start a run.',
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
