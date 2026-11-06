import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AmountInput, Button, CoinIcon, fmtAmount, refusalCopy, type MarketRow } from '../buy/deps';
import { dec } from '../buy/trade-math';
import type { LimitConvert as LimitRow, createToolApi } from '../../../features/trade/tool-api';
import { convertCopy } from './copy';

type Tools = ReturnType<typeof createToolApi>;

/** "99512.340" -> "99512.34": the exact decimal, no grouping, so the rate reads as the customer typed it. */
const plain = (value: string) => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);
const LIVE = new Set(['placing', 'waiting', 'triggered', 'cancelling']);

/**
 * Limit convert (J-cex-spot-11 #8): the amount is set aside on the ledger until a firm price, our spread included,
 * reaches the target, then it converts once and anything unused is free again. The service does the holding and the
 * watching; this form only asks for it and lists what is waiting.
 */
export function LimitConvert({
  tools,
  market,
  side,
  from,
  to,
  available,
  price,
  paused,
}: {
  tools: Tools;
  market: MarketRow;
  side: 'buy' | 'sell';
  from: string;
  to: string;
  available: string | null;
  price: string | null;
  paused: boolean;
}) {
  const { t } = convertCopy.useCopy();
  const [amount, setAmount] = useState('');
  const [target, setTarget] = useState('');
  const [placing, setPlacing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rows, setRows] = useState<LimitRow[] | null>(null);
  const [unread, setUnread] = useState(false);
  const requestId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await tools.convertLimits();
    if (result.ok) {
      setRows(result.data);
      setUnread(false);
    } else setUnread(true);
  }, [tools]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const typed = dec(amount);
  const have = dec(available);
  const short = typed !== null && have !== null && typed > have;
  const ready = typed !== null && typed > 0n && (dec(target) ?? 0n) > 0n && !short && !paused && !placing;

  async function place() {
    if (!ready) return;
    // One request id per attempt: a retry of the same click places the same limit, never a second hold.
    requestId.current ??= `limit:${crypto.randomUUID()}`;
    setPlacing(true);
    setMessage(null);
    const result = await tools.convertLimitPlace({
      symbol: market.symbol,
      side,
      amount,
      targetRate: target,
      clientLimitId: requestId.current,
    });
    setPlacing(false);
    if (result.ok) {
      requestId.current = null;
      setAmount('');
      setMessage(t('Limit held', { amount: plain(result.data.amount), asset: result.data.fromAsset }));
      void refresh();
    } else if (result.reason !== 'uncertain') {
      requestId.current = null;
      const copy = refusalCopy(result.code ?? '', { asset: from, available: available ?? '' });
      setMessage(`${copy.title}. ${copy.body}${result.code ? ` (Ref ${result.code})` : ''}`);
    }
  }

  async function cancel(id: string) {
    await tools.convertLimitCancel(id);
    void refresh();
  }

  const mine = useMemo(() => (rows ?? []).filter((r) => r.symbol === market.symbol), [rows, market.symbol]);
  const waiting = mine.filter((r) => LIVE.has(r.status));
  const recent = mine.filter((r) => !LIVE.has(r.status)).slice(0, 5);
  const rule = (r: LimitRow) =>
    t(r.side === 'buy' ? 'Limit row buy' : 'Limit row sell', {
      amount: plain(r.amount),
      from: r.fromAsset,
      to: r.toAsset,
      base: market.base,
      target: plain(r.targetRate),
    });

  return (
    <div className="cvt-limit" data-testid="cvt-limit">
      <div className="cvt-fields">
        <div className="cvt-field" data-testid="limit-from-field">
          <span className="cvt-field__label">{t('From')}</span>
          <div className="cvt-field__main">
            <span className="cvt-asset">
              <CoinIcon asset={from} size={28} />
              <span>{from}</span>
            </span>
            <AmountInput
              size="hero"
              aria-label={t('Amount to convert')}
              value={amount}
              onValueChange={setAmount}
              precision={side === 'buy' ? 6 : 8}
              placeholder="0"
              className="cvt-amount"
            />
          </div>
          <div className="cvt-field__foot">
            <span>
              {available === null
                ? t('Available loading')
                : t('Available {value}', { value: `${fmtAmount(available, { places: 8, round: 'down' })} ${from}` })}
            </span>
          </div>
        </div>
        <div className="cvt-field" data-testid="limit-target-field">
          <span className="cvt-field__label">{t('Target rate')}</span>
          <div className="cvt-field__main">
            <span className="cvt-asset">
              <CoinIcon asset={to} size={28} />
              <span>{to}</span>
            </span>
            <AmountInput
              size="hero"
              aria-label={t('Target rate')}
              value={target}
              onValueChange={setTarget}
              precision={18}
              placeholder="0"
              className="cvt-amount"
            />
          </div>
          <div className="cvt-field__foot">
            <span>{t('Target rate hint', { base: market.base, quote: market.quote })}</span>
            {price ? <span>{t('Now about', { price: plain(price), quote: market.quote })}</span> : null}
          </div>
        </div>
      </div>

      {short ? (
        <div className="cvt-note" role="alert">
          <p>{refusalCopy('ledger.insufficient_funds', { asset: from, available: available ?? '' }).title}.</p>
          <a className="text-link" href={`/uc/recharge?asset=${encodeURIComponent(from)}`}>
            {t('Deposit {asset}', { asset: from })}
          </a>
        </div>
      ) : null}
      {message ? (
        <p className="cvt-note" role="status" data-testid="limit-message">
          {message}
        </p>
      ) : null}

      <Button variant="primary" size={56} fullWidth disabled={!ready} loading={placing} onClick={place}>
        {placing ? t('Placing') : (dec(target) ?? 0n) > 0n ? t('Place limit convert') : t('Enter a target')}
      </Button>

      <section className="cvt-limit__list" aria-label={t('Waiting limit converts')} data-testid="limit-waiting">
        <h3>{t('Waiting limit converts')}</h3>
        {unread ? <p role="alert">{t('Limit unread')}</p> : null}
        {rows !== null && waiting.length === 0 ? <p>{t('Limit none')}</p> : null}
        <ul>
          {waiting.map((r) => (
            <li key={r.id} data-testid="limit-row">
              <span>{rule(r)}</span>
              {r.status === 'waiting' ? (
                <Button variant="ghost" size={32} onClick={() => void cancel(r.id)}>
                  {t('Cancel limit')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      {recent.length > 0 ? (
        <section className="cvt-limit__list" aria-label={t('Recent limit converts')}>
          <h3>{t('Recent limit converts')}</h3>
          <ul>
            {recent.map((r) => (
              <li key={r.id}>
                <span>{rule(r)}</span>{' '}
                <span>
                  {r.status === 'filled' && r.paid && r.received
                    ? t('Limit filled', { paid: plain(r.paid), from: r.fromAsset, received: plain(r.received), to: r.toAsset })
                    : r.status === 'cancelled'
                      ? t('Limit cancelled', { asset: r.fromAsset })
                      : t('Limit ended', { asset: r.fromAsset })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
