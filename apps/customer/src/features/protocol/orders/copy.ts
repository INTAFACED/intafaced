import { defineCopy } from '../../../shared/i18n';

/**
 * Authored copy for /dex/orders: the person's own limit, take-profit, stop and trailing orders, held in their order vault
 * (D-limit-dca-01 to -04). English only for now. Nothing here claims an audit, INTACHAIN or mainnet, and no amount is
 * invented: every figure comes from the service or the chain.
 */
const en = {
  title: 'Orders',
  description:
    'Limit, take-profit, stop and trailing orders from your own wallet. Your tokens wait in the order vault under your own credit and only ever go back to you or to the pool for a fill.',
  eyebrow: 'Your wallet · self-custody',
  connectTitle: 'Connect a wallet to see your orders',
  connectBody: 'Orders here belong to a wallet you control. Connect it on the Wallet page, then come back.',
  connectAction: 'Open Wallet',

  sessionTitle: 'Order session',
  sessionIntro: 'One signature lets this page place, change and cancel your orders. Read what it grants before your wallet asks.',
  sessionScope: 'Scope',
  sessionExpires: 'Expires',
  sessionCap: 'Cap',
  sessionCapRow: '{max} {symbol} open at once',
  sessionLoading: 'Writing your order session…',
  sessionSign: 'Sign the order session',
  sessionSigning: 'Waiting for your wallet…',
  sessionSigned: 'Order session signed. It lasts until {time}.',
  sessionRejected: 'You cancelled in your wallet. Nothing was signed.',
  sessionWallet: 'Your wallet could not sign: {message}',
  sessionReplay: 'Send the last signature again',
  sessionReplayHint: 'Checks that a signature already used cannot open a second session.',
  sessionSignOut: 'Sign out of the order session',
  sessionSignedOut: 'The order session ended. Your orders stay as they are.',

  refused: '{words} Code: {code}.',
  refused_dex_auth_challenge_replayed: 'That signature was already used, so it opened nothing.',
  refused_dex_auth_challenge_invalid: 'That request has expired or was changed. Sign a new order session.',
  refused_dex_auth_signature_not_owner: 'That signature is not from this wallet.',
  refused_dex_auth_unauthenticated: 'Your order session ended. Sign a new one.',
  refused_dex_auth_session_unset: 'Order sessions are not set up in this build, so no order can be placed.',
  refused_dex_auth_lifetime_unset: 'How long an order session lasts is not published, so none can be signed.',
  refused_dex_order_cap_unset: 'The order cap schedule is not published, so no order session can be signed.',
  refusedOther: 'The order service refused this.',
  unreachable: 'The order service did not answer. Nothing was signed or changed.',

  listTitle: 'Your orders',
  listEmpty: 'No orders yet.',
  hdrId: 'Order',
  hdrType: 'Type',
  hdrSide: 'Side',
  hdrAmount: 'Amount',
  hdrTrigger: 'Trigger',
  hdrState: 'State',
  hdrActions: 'Actions',
  listNeedsSession: 'Sign the order session to see your orders.',
} as const;

export const ordersCopy = defineCopy('customer.protocol.orders', en);
export type OrdersTranslate = ReturnType<typeof ordersCopy.forLocale>['t'];
