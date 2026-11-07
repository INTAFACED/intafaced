import { useEffect, useId, useMemo, useState } from 'react';
import {
  protocolIntentCreateOutputSchema,
  protocolIntentListOutputSchema,
  protocolIntentRowSchema,
  protocolIntentSettingsSchema,
  type ProtocolIntentCreateOutput,
  type ProtocolIntentList,
  type ProtocolIntentRow,
} from '@intafaced/contracts/protocol-intent';
import type { ProtocolSwapToken } from '@intafaced/contracts/protocol-swap';
import { encodeFunctionData, parseAbi } from 'viem';
import { Button, Dialog, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi, type RepresentationStatus } from '../api';
import { REGION_BLOCKED_CODE } from '../region';
import { RepresentationPanel } from '../wallet/RepresentationPanel';
import { tokenLabel, toBaseUnits } from '../wallet/transfer';
import { useWallet } from '../wallet/WalletProvider';
import { swapCopy } from './copy';
import { formatUnits } from './swap-math';
import { dateTime } from './v2-flow';

const CANCEL_ABI = parseAbi(['function cancel(uint256 nonce)']);
/** How often the orders table is read again while an order is open. */
const REFRESH_MS = 2_000;

/**
 * Signed intent orders with a Dutch-auction decay (D-swap-09): the person names what they pay, the floor they accept and
 * how long the price decays; the order starts at the best price the pools quote now. Their wallet signs the order (and
 * the token's own permit for the reactor), and sends nothing: no gas. A filler fills it on chain at the decayed price of
 * that second; the table reads what the chain shows. A cancel is an on-chain transaction the person sends.
 */
export function IntentOrderPanel({ tokens }: { tokens: readonly ProtocolSwapToken[] }) {
  const { language } = usePreferences();
  const { t } = swapCopy.forLocale(language);
  const wallet = useWallet();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const settings = useResource(
    (signal) => transport.query('protocol', 'intent.settings', undefined, protocolIntentSettingsSchema, { signal }),
    'intent:settings',
  );
  const [tokenIn, setTokenIn] = useState('');
  const [tokenOut, setTokenOut] = useState('');
  const [amount, setAmount] = useState('');
  const [floor, setFloor] = useState('');
  const [minutes, setMinutes] = useState('');
  const [review, setReview] = useState<{ startOut: bigint; floor: bigint; amountIn: bigint; minutes: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [representation, setRepresentation] = useState<{ address: string; status: RepresentationStatus } | null>(null);
  const [orders, setOrders] = useState<ProtocolIntentList | null>(null);
  const [refresh, setRefresh] = useState(0);
  const ids = { pay: useId(), receive: useId() };

  const find = (address: string) => tokens.find((token) => token.address.toLowerCase() === address.toLowerCase()) ?? null;
  const inToken = find(tokenIn);
  const outToken = find(tokenOut);
  const amountIn = inToken ? toBaseUnits(amount, inToken.decimals) : null;
  const floorOut = outToken ? toBaseUnits(floor, outToken.decimals) : null;
  const decayMinutes = /^[1-9][0-9]{0,4}$/.test(minutes.trim()) ? Number(minutes.trim()) : null;
  const owner = wallet.status === 'connected' && wallet.guard?.ok ? wallet.address : null;

  // The person's orders, read again while any is open, so a fill shows within seconds of being mined.
  useEffect(() => {
    if (!owner) return setOrders(null);
    const controller = new AbortController();
    void transport
      .query('protocol', 'intent.list', { swapper: owner }, protocolIntentListOutputSchema, { signal: controller.signal })
      .then((read) => {
        if (!controller.signal.aborted && read.ok) setOrders(read.data);
      });
    const timer = setTimeout(() => setRefresh((value) => value + 1), REFRESH_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [transport, owner, refresh]);

  const reason = !owner
    ? t('needsWallet')
    : settings.resource.status === 'failed'
      ? settings.resource.failure.code === 'dex.intent.reactor_unset'
        ? t('intentUnset')
        : t('intentUnread')
      : !inToken || !outToken
        ? t('needsTokens')
        : inToken.address === outToken.address
          ? t('sameToken')
          : amountIn === null
            ? t('needsAmount', { decimals: String(inToken.decimals) })
            : floorOut === null
              ? t('intentFloorNeeded')
              : decayMinutes === null
                ? t('intentDecayNeeded')
                : null;

  /** The start: the best price the pools quote for this amount now. A floor above it is no decay and is refused. */
  const startReview = async () => {
    if (reason || !inToken || !outToken || amountIn === null || floorOut === null || decayMinutes === null) return;
    setProblem(null);
    const ranked = await api.routes({ tokenIn: inToken.address, tokenOut: outToken.address, amountIn: amountIn.toString(), exclude: [] });
    const best = ranked.ok ? ranked.data.legs.find((leg) => leg.status === 'best')?.quote : undefined;
    if (!best) return setProblem(t('quoteRefused'));
    const startOut = BigInt(best.amountOut);
    if (floorOut > startOut) return setProblem(t('intentFloorAboveStart'));
    setReview({ startOut, floor: floorOut, amountIn, minutes: decayMinutes });
  };

  /** The representation gate, then the order and the token's permit signed on one wallet sheet, then kept. */
  const sign = async () => {
    if (!review || !inToken || !outToken || !owner) return;
    setBusy(true);
    setProblem(null);
    try {
      const gate = await api.representationStatus(owner);
      if (!gate.ok) return setProblem(gate.code === REGION_BLOCKED_CODE ? t('regionBlocked') : t('representationUnread'));
      if (!gate.data.accepted) return setRepresentation({ address: owner, status: gate.data });
      const created = await transport.query(
        'protocol',
        'intent.create',
        {
          swapper: owner,
          tokenIn: inToken.address,
          amountIn: review.amountIn.toString(),
          tokenOut: outToken.address,
          startOut: review.startOut.toString(),
          endOut: review.floor.toString(),
          decaySeconds: review.minutes * 60,
          gasless: true,
        },
        protocolIntentCreateOutputSchema,
      );
      if (!created.ok) return setProblem(intentRefusal(created.code));
      const plan: ProtocolIntentCreateOutput = created.data;
      const amountText = formatUnits(review.amountIn, inToken.decimals, inToken.decimals);
      const result = await wallet.sendSequence({
        title: t('intentSteps'),
        steps: [
          ...(plan.permit ? [{ label: t('intentStepPermit', { amount: amountText, token: inToken.name }), sign: plan.permit }] : []),
          { label: t('intentStepOrder', { amount: amountText, token: inToken.name }), sign: plan.typedData },
        ],
        facts: [
          { label: t('intentStartsAt'), value: `${formatUnits(review.startOut, outToken.decimals)} ${outToken.name}` },
          { label: t('intentFloorFact'), value: `${formatUnits(review.floor, outToken.decimals)} ${outToken.name}` },
          { label: t('intentDecayFact'), value: `${dateTime(BigInt(plan.order.decayStart))} to ${dateTime(BigInt(plan.order.decayEnd))}` },
        ],
      });
      if (result.status !== 'sent') return setProblem(result.status === 'rejected' ? t('signRejected') : result.message);
      const signatures = result.signatures ?? [];
      const orderSignature = signatures[signatures.length - 1]!;
      const posted = await transport.mutate(
        'protocol',
        'intent.post',
        {
          order: plan.order,
          signature: orderSignature,
          permit: plan.permit ? { value: plan.order.amountIn, deadline: plan.order.deadline, signature: signatures[0]! } : null,
        },
        protocolIntentRowSchema,
      );
      if (!posted.ok) return setProblem(intentRefusal(posted.code));
      setReview(null);
      setRefresh((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  const intentRefusal = (code: string | undefined) =>
    code === 'dex.intent.decay_bounds_unset'
      ? t('intentBoundsUnset')
      : code === 'dex.intent.decay_out_of_bounds'
        ? t('intentOutOfBounds')
        : code === 'dex.intent.bad_decay'
          ? t('intentBadDecay')
          : code === 'dex.intent.permit_unsupported'
            ? t('intentNoPermit')
            : t('intentRefused');

  /** Cancel: an on-chain transaction the person sends; the order reads cancelled once the chain shows it. */
  const cancel = async (row: ProtocolIntentRow) => {
    if (!settings.resource.status || settings.resource.status !== 'ready') return;
    const result = await wallet.sendSequence({
      title: t('intentCancelSteps'),
      steps: [
        {
          label: t('intentCancelStep'),
          request: {
            kind: 'transaction',
            to: settings.resource.data.reactor,
            data: encodeFunctionData({ abi: CANCEL_ABI, functionName: 'cancel', args: [BigInt(row.order.nonce)] }),
          },
        },
      ],
    });
    if (result.status === 'failed') setProblem(result.message);
  };

  const select = (id: string, label: string, value: string, set: (value: string) => void) => (
    <label className="field">
      <span id={id}>{label}</span>
      <select value={value} onChange={(event) => set(event.target.value)} aria-labelledby={id}>
        <option value="">{t('chooseToken')}</option>
        {tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {tokenLabel(token, tokens)}
          </option>
        ))}
      </select>
    </label>
  );
  const nameOf = (address: string) => find(address)?.name ?? address;
  const units = (value: string | null, address: string) => {
    const token = find(address);
    return value === null ? '' : token ? formatUnits(BigInt(value), token.decimals) : value;
  };

  return (
    <>
      {representation && (
        <RepresentationPanel
          address={representation.address}
          status={representation.status}
          api={api}
          onEnd={(end) => {
            setRepresentation(null);
            if (end.kind === 'accepted') void sign();
            else setProblem(end.kind === 'region' ? t('regionBlocked') : t('rejected'));
          }}
        />
      )}
      <Panel title={t('intentTitle')}>
        <p className="muted">{t('intentNote')}</p>
        <form
          aria-label={t('intentTitle')}
          className="protocol-quote"
          onSubmit={(event) => {
            event.preventDefault();
            void startReview();
          }}
        >
          {select(ids.pay, t('youPay'), tokenIn, setTokenIn)}
          {select(ids.receive, t('youReceive'), tokenOut, setTokenOut)}
          <Field label={t('amountIn')} inputMode="decimal" value={amount} autoComplete="off" onChange={(e) => setAmount(e.target.value)} />
          <Field
            label={t('intentFloor', { token: outToken?.name ?? t('intentTokenOut') })}
            inputMode="decimal"
            value={floor}
            autoComplete="off"
            onChange={(e) => setFloor(e.target.value)}
          />
          <Field
            label={t('intentDecay')}
            inputMode="numeric"
            value={minutes}
            autoComplete="off"
            onChange={(e) => setMinutes(e.target.value)}
          />
          <Button type="submit" disabled={reason !== null || busy}>
            {t('intentReview')}
          </Button>
          {reason && <p className="protocol-actions__reason">{reason}</p>}
          {problem && <p role="alert">{problem}</p>}
        </form>
      </Panel>
      {review && inToken && outToken && (
        <Dialog title={t('intentReviewTitle')} onClose={() => setReview(null)}>
          <p>{t('intentStartsLine', { amount: formatUnits(review.startOut, outToken.decimals), token: outToken.name })}</p>
          <p>
            {t('intentDecaysLine', {
              amount: formatUnits(review.floor, outToken.decimals),
              token: outToken.name,
              minutes: String(review.minutes),
            })}
          </p>
          <p className="muted">{t('intentGasless')}</p>
          <Button onClick={() => void sign()} disabled={busy}>
            {t('intentSign')}
          </Button>{' '}
          <Button variant="secondary" onClick={() => setReview(null)}>
            {t('sheetCancelShort')}
          </Button>
        </Dialog>
      )}
      <Panel title={t('intentOrders')}>
        <section aria-label={t('intentOrders')}>
          {!orders || orders.orders.length === 0 ? (
            <p className="muted">{t('intentNone')}</p>
          ) : (
            <table aria-label={t('intentOrders')}>
              <thead>
                <tr>
                  <th scope="col">{t('intentColPay')}</th>
                  <th scope="col">{t('intentColDecay')}</th>
                  <th scope="col">{t('intentColState')}</th>
                  <th scope="col">{t('intentColFill')}</th>
                  <th scope="col">{t('intentColAction')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.orders.map((row) => (
                  <tr key={row.id}>
                    <td className="numeric">
                      {units(row.order.amountIn, row.order.tokenIn)} {nameOf(row.order.tokenIn)}
                    </td>
                    <td className="numeric">
                      {t('intentDecayCell', {
                        start: units(row.order.startOut, row.order.tokenOut),
                        end: units(row.order.endOut, row.order.tokenOut),
                        token: nameOf(row.order.tokenOut),
                        from: dateTime(BigInt(row.order.decayStart)),
                        to: dateTime(BigInt(row.order.decayEnd)),
                      })}
                    </td>
                    <td>{t(`intentState_${row.state}`)}</td>
                    <td className="numeric">
                      {row.state === 'filled'
                        ? t('intentFillCell', {
                            price: units(row.priceAtFill, row.order.tokenOut),
                            received: units(row.amountOut, row.order.tokenOut),
                            token: nameOf(row.order.tokenOut),
                            time: row.filledAt ? dateTime(BigInt(row.filledAt)) : '',
                          })
                        : row.state === 'expired'
                          ? t('intentNotFilled')
                          : ''}
                    </td>
                    <td>
                      {row.state === 'open' && (
                        <Button variant="secondary" onClick={() => void cancel(row)}>
                          {t('intentCancel')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </Panel>
    </>
  );
}
