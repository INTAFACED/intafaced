import {
  NAVIGATOR_TRADE_REFUSALS,
  navigatorOrdersSchema,
  navigatorTradingSchema,
  type NavigatorOrder,
  type NavigatorTrading,
} from '@intafaced/contracts/agents-onchain';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Failure } from '../../shared/ui';
import { useApi } from '../session/session';
import { formatUnits } from '../protocol/swap/swap-math';
import { utcTime } from '../protocol/wallet/SessionKeysPanel';
import { navigatorOnchainCopy } from './navigator-onchain-copy';

type T = ReturnType<typeof navigatorOnchainCopy.forLocale>['t'];
/** The copy keys these maps pick from: every one is a sentence with no placeholder. */
type PlainKey =
  | 'order_sending'
  | 'order_sent'
  | 'order_filled'
  | 'order_reverted'
  | 'order_failed'
  | 'refused_money_out'
  | 'refused_over_cap'
  | 'refused_no_live_key'
  | 'refused_unparsed'
  | 'refused_cap_unit'
  | 'refused_out_of_scope'
  | 'refused_market_unset'
  | 'refused_unquoted'
  | 'refused_rail_crypto'
  | 'refused_other';
const eth = (wei: string) => formatUnits(BigInt(wei), 18, 18);

/**
 * The Navigator's trades inside the cap the person signed for its session key (J-agents-19 #4): inside the cap an order
 * is sent once, with no approval asked, and tagged as placed by the assistant; above it the order is refused naming the
 * cap, before anything is signed; and the Navigator never moves money out.
 */
export function useNavigatorTrading(revision: number) {
  const api = useApi();
  return useResource(
    (signal) => api.query('agents', 'navigator.trading', undefined, navigatorTradingSchema, { signal }),
    `navigator-trading:${revision}`,
  );
}

/** The cap the person signed, as the chain holds it, and what the Navigator's orders hold of it. */
export function NavigatorCapLine({ trading }: { trading: NavigatorTrading | null }) {
  const { t } = navigatorOnchainCopy.useCopy();
  if (!trading) return null;
  if (!trading.key) return <p className="muted">{t('capNoKey')}</p>;
  return (
    <p role="note" data-testid="navigator-cap">
      {t('capLine', { cap: eth(trading.key.capWei), spent: eth(trading.key.spentWei), left: eth(trading.key.leftWei) })}
    </p>
  );
}

const STATUS_WORDS: Record<NavigatorOrder['status'], PlainKey> = {
  sending: 'order_sending',
  sent: 'order_sent',
  filled: 'order_filled',
  reverted: 'order_reverted',
  failed: 'order_failed',
};

function OrderFacts({ order, t }: { order: NavigatorOrder; t: T }) {
  return (
    <dl>
      <dt>{t('orderAsk')}</dt>
      <dd lang="und">{order.text}</dd>
      <dt>{t('orderTrade')}</dt>
      <dd className="numeric">
        {t('orderTradeValue', {
          amount: eth(order.amountInWei),
          from: order.tokenInSymbol,
          to: order.tokenOutSymbol,
          min: eth(order.minOutWei),
        })}
      </dd>
      <dt>{t('orderStatus')}</dt>
      <dd data-order-status={order.status}>{t(STATUS_WORDS[order.status])}</dd>
      <dt>{t('orderTx')}</dt>
      <dd className="numeric">{order.txHash ? <code lang="zxx">{order.txHash}</code> : t('orderNoTx')}</dd>
      <dt>{t('orderPlaced')}</dt>
      <dd className="numeric">{utcTime(order.createdAt)}</dd>
    </dl>
  );
}

/** The order the Navigator just placed: tagged as placed by the assistant, and nothing was asked of the person. */
export function NavigatorOrderView({ order }: { order: NavigatorOrder }) {
  const { t } = navigatorOnchainCopy.useCopy();
  return (
    <section aria-label={t('orderTitle')} className="navigator-order">
      <h4>{t('orderTitle')}</h4>
      <p>
        <span className="pill" data-placed-by={order.placedBy}>
          {t('byAssistant')}
        </span>
      </p>
      <OrderFacts order={order} t={t} />
      <p className="muted">{t('orderInsideCap')}</p>
    </section>
  );
}

const REFUSAL_WORDS: Record<string, PlainKey> = {
  'agents.navigator_money_out_forbidden': 'refused_money_out',
  'agents.navigator_trade_over_cap': 'refused_over_cap',
  'agents.navigator_no_live_key': 'refused_no_live_key',
  'agents.navigator_trade_unparsed': 'refused_unparsed',
  'agents.navigator_trade_cap_unit': 'refused_cap_unit',
  'agents.navigator_trade_out_of_scope': 'refused_out_of_scope',
  'agents.navigator_market_unset': 'refused_market_unset',
  'agents.navigator_trade_unquoted': 'refused_unquoted',
  'rail.crypto': 'refused_rail_crypto',
};
const TRADE_CODES: ReadonlySet<string> = new Set([...NAVIGATOR_TRADE_REFUSALS, 'rail.crypto']);
/** True for a refusal the Navigator's trade rule gives, which this room words itself. */
export const isNavigatorTradeRefusal = (failure: Extract<ApiResult<unknown>, { ok: false }>) =>
  TRADE_CODES.has(failure.message) || (failure.code !== undefined && TRADE_CODES.has(failure.code));

/** A trade ask refused by name, before anything was signed. Above the cap, it names the cap the person signed. */
export function NavigatorTradeRefusalView({
  failure,
  trading,
}: {
  failure: Extract<ApiResult<unknown>, { ok: false }>;
  trading: NavigatorTrading | null;
}) {
  const { t } = navigatorOnchainCopy.useCopy();
  if (!isNavigatorTradeRefusal(failure)) return <Failure result={failure} />;
  const code = TRADE_CODES.has(failure.message) ? failure.message : failure.code!;
  const key = trading?.key ?? null;
  return (
    <section aria-label={t('refusalTitle')} className="navigator-refusal">
      <h4>{t('refusalTitle')}</h4>
      <p role="alert" data-refusal-code={code}>
        {code === 'agents.navigator_trade_over_cap' && key
          ? t('refused_over_cap_named', { cap: eth(key.capWei), left: eth(key.leftWei) })
          : t(REFUSAL_WORDS[code] ?? 'refused_other')}{' '}
        <code lang="zxx">({code})</code>
      </p>
      <p className="muted">{t('refusalNothingSigned')}</p>
    </section>
  );
}

/** The orders the Navigator placed in a session, as the service keeps them, so they survive a reload. */
export function NavigatorOrders({ sessionId, revision = 0 }: { sessionId: string; revision?: number }) {
  const { t } = navigatorOnchainCopy.useCopy();
  const api = useApi();
  const { resource, reload } = useResource(
    (signal) => api.query('agents', 'navigator.orders', { sessionId }, navigatorOrdersSchema, { signal }),
    `navigator-orders:${sessionId}:${revision}`,
  );
  return (
    <div className="navigator-orders" data-testid="navigator-orders">
      <h4>{t('ordersTitle')}</h4>
      {resource.status === 'loading' ? (
        <p role="status">{t('reading')}</p>
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : resource.data.orders.length === 0 ? (
        <p className="muted">{t('ordersEmpty')}</p>
      ) : (
        <ul>
          {resource.data.orders.map((order) => (
            <li key={order.id} data-order-key={order.orderKey}>
              <span className="pill" data-placed-by={order.placedBy}>
                {t('byAssistant')}
              </span>
              <OrderFacts order={order} t={t} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
