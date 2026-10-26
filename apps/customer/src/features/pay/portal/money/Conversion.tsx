import { useMemo, useState } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState, Field } from '../../ui-kit';
import { useResource } from '../../../../shared/resource';
import { parseAmount } from '../../../../shared/money';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import { Facts, Gate, HaltBanner, PortalFailure, PortalLoading, SelectField, TestTag } from '../components';
import type { PortalApi } from '../api';
import { useNow, useReadAt, useUrlParam } from '../hooks';
import { isUuid } from '../model';
import { useUnsavedForm } from '../useUnsavedForm';
import type { Settlement } from '../schemas';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { formatMoney } from '../ui/format';
import { MoneyText } from '../ui/MoneyText';
import { PortalReview } from '../ui/PortalReview';
import { useRequestId } from '../payments/invoice-model';
import { RelatedLinks } from '../ui/RelatedLinks';
import { ToneChip, type StatusTone } from '../ui/StatusChip';
import { Timeline } from '../ui/Timeline';
import { uiCopy } from '../ui/copy';
import { ListBody, LinkButton, localRefusal, NamedBlocker, shortDay } from './common';
import { mc } from './copy';
import { useMoneyReason } from '../access/MoneyAction';
import { conversionStatuses, type ConversionOrder, type ConversionQuote } from './schemas';
import { settlementName } from './Settlements';
import { isConversionOff } from './refusals';

const TONE: Record<string, StatusTone> = {
  quoted: 'progress',
  intent_committed: 'progress',
  placing: 'progress',
  placed: 'progress',
  partially_filled: 'action',
  filled: 'done',
  failed: 'failed',
  reversed: 'failed',
  expired: 'progress',
};
export function ConversionChip({ status }: { status: string }) {
  const { t } = mc.useCopy();
  return status in TONE ? (
    <ToneChip tone={TONE[status]!} label={t(`cvStatus_${status}` as 'cvStatus_filled')} tip={t(`cvTip_${status}` as 'cvTip_filled')} />
  ) : (
    <ToneChip tone="progress" label={t('cvStatus_other')} />
  );
}
/** The tab-kept request id is named by the settlement alone: no amount, address or quote in the key. */
export const conversionRequestScope = (settlementId: string | null) => `conversion:${settlementId ?? 'none'}`;
const orderHref = (id: string) => `/pay/conversion/${encodeURIComponent(id)}`;

/** Conversion is a sandbox. This says so on every conversion page, before anything else. */
function TestNotice() {
  const { t } = mc.useCopy();
  return (
    <p className="pp-callout pp-callout--warn" role="note">
      <TestTag /> <strong>{t('cvTestTitle')}</strong> {t('cvTestBody')}
    </p>
  );
}

function Off() {
  const { t } = mc.useCopy();
  return (
    <NamedBlocker title={t('cvOffTitle')} why="reasonService" needs="conversion switched on (PAY_CONVERSION_MODE=sandbox)">
      {t('cvOffBody')}
    </NamedBlocker>
  );
}

/** `/pay/conversion`: your test conversions from US dollars to USDT. */
export function Conversion({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const [status, setStatus] = useUrlParam('status', '');
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const orders = useResource((s) => portal.conversionList(merchantId, s), `money:conversions:${merchantId}`);
  const readAt = useReadAt(orders.resource.status === 'ready', orders.resource);
  const r = orders.resource;
  const all = r.status === 'ready' ? r.data : [];
  const shown = status ? all.filter((o) => o.status === status) : all;
  const inFlight = all.filter((o) => ['quoted', 'intent_committed', 'placing', 'placed', 'partially_filled'].includes(o.status)).length;
  const count = (n: number) => (all.length >= 50 ? t('mnCountNewest', { n }) : String(n));
  return (
    <div className="stack">
      <TestNotice />
      <HaltBanner resource={halts.resource} scopes={['conversion']} />
      <Freshness asOf={readAt} />
      {r.status === 'failed' && isConversionOff(r.failure) ? (
        <Off />
      ) : (
        <>
          <KpiStrip
            label={t('cvTiles')}
            tiles={[
              {
                label: t('cvTotal'),
                period: t('mnPeriodNewest'),
                href: '/pay/conversion',
                value: r.status === 'ready' ? count(all.length) : '—',
              },
              {
                label: t('cvFilled'),
                period: t('mnPeriodNewest'),
                href: '/pay/conversion?status=filled',
                value: r.status === 'ready' ? count(all.filter((o) => o.status === 'filled').length) : '—',
              },
              {
                label: t('cvInFlight'),
                period: t('mnPeriodNow'),
                href: '/pay/conversion?status=placing',
                value: r.status === 'ready' ? String(inFlight) : '—',
              },
              {
                label: t('cvFailed'),
                period: t('mnPeriodNewest'),
                href: '/pay/conversion?status=failed',
                value: r.status === 'ready' ? count(all.filter((o) => o.status === 'failed' || o.status === 'reversed').length) : '—',
              },
            ]}
          />
          <div className="pp-filter-row">
            <SelectField
              label={t('colStatus')}
              value={status}
              onChange={setStatus}
              options={[['', t('cvAllStatuses')], ...conversionStatuses.map((s) => [s, t(`cvStatus_${s}` as 'cvStatus_filled')] as const)]}
            />
            <p className="muted pp-count" role="status">
              {t('mnCountNewest', { n: shown.length })}
            </p>
          </div>
          {r.status === 'loading' ? (
            <PortalLoading rows={3} />
          ) : r.status === 'failed' ? (
            <PortalFailure result={r.failure} retry={orders.reload} />
          ) : (
            <ListBody
              state={{ status: 'ready', items: shown, hasMore: false, more: 'idle' }}
              retry={orders.reload}
              onMore={() => undefined}
              filtered={{ active: Boolean(status), clear: () => setStatus('') }}
              empty={{
                title: t('cvEmptyTitle'),
                body: t('cvEmptyBody'),
                action: <LinkButton href="/pay/conversion/new">{t('cvNew')}</LinkButton>,
              }}
              label={t('cvTable')}
              rowKey={(o) => o.conversionId}
              href={(o) => orderHref(o.conversionId)}
              columns={[
                {
                  header: t('mnColConversion'),
                  cell: (o) => t('cvName', { from: o.fromAsset, to: o.toAsset, when: shortDay(o.createdAt, locale) }),
                },
                { header: t('cvFrom'), cell: (o) => <MoneyText value={o.fromAmount} asset={o.fromAsset} test /> },
                { header: t('cvGot'), cell: (o) => <MoneyText value={o.filledToAmount} asset={o.toAsset} test /> },
                { header: t('colStatus'), cell: (o) => <ConversionChip status={o.status} /> },
              ]}
              card={(o) => ({
                title: t('cvName', { from: o.fromAsset, to: o.toAsset, when: shortDay(o.createdAt, locale) }),
                time: <DateTime value={o.createdAt} />,
                amount: <MoneyText value={o.fromAmount} asset={o.fromAsset} test />,
                status: <ConversionChip status={o.status} />,
              })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** `/pay/conversion/new`: pick a settlement and an amount, read the quote, then convert. A quote is good for a short time. */
export function ConversionNew({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const { can } = useMerchantAccess();
  const now = useNow(1000);
  const [picked, setPicked] = useUrlParam('settlement', '');
  const [amount, setAmount] = useState('');
  const [tried, setTried] = useState(false);
  const [quote, setQuote] = useState<{ q: ConversionQuote } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ off: boolean; message: string } | null>(null);
  const settlements = useResource(
    (s) => portal.settlementPage(merchantId, { status: 'posted' }, undefined, s),
    `money:conv-settlements:${merchantId}`,
  );
  useUnsavedForm(amount.trim() !== '' && quote === null, t('mnUnsaved'));
  const usd: Settlement[] =
    settlements.resource.status === 'ready' ? settlements.resource.data.items.filter((s) => s.assetId === 'USD') : [];
  const settlement = usd.find((s) => s.id === picked) ?? null;
  // The id of the conversion being sent, kept in this tab for the settlement (no amount or address in its key). If the
  // answer is lost and the page reloads, the next press sends the same id and the service replays the first outcome.
  const request = useRequestId(conversionRequestScope(settlement?.id ?? null));
  const valid = /^\d+(\.\d{1,18})?$/.test(amount.trim()) && /[1-9]/.test(amount);
  const over = settlement && valid ? parseAmount(amount.trim()) > parseAmount(settlement.net) : false;
  const problem = !settlement ? t('cvPickSettlement') : !valid ? t('cvAmountInvalid') : over ? t('cvAmountOver') : null;
  const expired = quote ? Date.parse(quote.q.expiresAt) <= now : false;
  const may = can('payout.approve');
  // Getting a quote is an ordinary write; converting moves money and carries the payout scope.
  const stepReason = useMoneyReason('payout', 'convert');
  return (
    <div className="stack">
      <TestNotice />
      {refusal?.off ? (
        <Off />
      ) : (
        <>
          <Gate resource={settlements.resource} retry={settlements.reload} rows={2}>
            {() =>
              usd.length === 0 ? (
                <EmptyState title={t('cvNoUsdTitle')} action={<LinkButton href="/pay/settlements">{t('pnNoneAction')}</LinkButton>}>
                  {t('cvNoUsdBody')}
                </EmptyState>
              ) : (
                <PaySection title={t('cvStep1')} description={t('cvStep1Body')}>
                  <form data-testid="form-stack" className="form-stack pp-form" noValidate onSubmit={(e) => e.preventDefault()}>
                    <SelectField
                      label={t('pnSettlement')}
                      value={settlement?.id ?? ''}
                      onChange={(v) => {
                        setPicked(v);
                        setQuote(null);
                      }}
                      options={[
                        ['', t('pnChoose')],
                        ...usd.map(
                          (s) => [s.id, `${settlementName(t, locale, s)} · ${formatMoney(s.net, s.assetId)} ${s.assetId}`] as const,
                        ),
                      ]}
                    />
                    <Field
                      label={`${t('cvAmount')} (USD) *`}
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        setQuote(null);
                      }}
                      onBlur={() => setTried(true)}
                      error={tried && amount.trim() && (!valid || over) ? (over ? t('cvAmountOver') : t('cvAmountInvalid')) : undefined}
                      hint={settlement ? t('cvAmountMax', { max: settlement.net }) : undefined}
                    />
                    <p className="muted pp-note">{t('cvPair')}</p>
                    <Button
                      variant="secondary"
                      disabled={problem !== null || busy || !may}
                      title={!may ? t('cvNotAllowed') : (problem ?? undefined)}
                      onClick={async () => {
                        if (!settlement) return;
                        setBusy(true);
                        setRefusal(null);
                        const res = await portal.conversionQuote({
                          merchantId,
                          settlementId: settlement.id,
                          fromAsset: 'USD',
                          toAsset: 'USDT',
                          fromAmount: amount.trim(),
                        });
                        setBusy(false);
                        if (res.ok) setQuote({ q: res.data });
                        else setRefusal({ off: isConversionOff(res), message: isConversionOff(res) ? '' : (res.message ?? '') });
                      }}
                    >
                      {busy ? t('cvQuoting') : t('cvGetQuote')}
                    </Button>
                    {!may && <p className="muted pp-note">{t('cvNotAllowed')}</p>}
                    {problem && <p className="muted pp-note">{problem}</p>}
                    {refusal && !refusal.off && refusal.message && (
                      <p role="alert" className="error-text">
                        {refusal.message}
                      </p>
                    )}
                  </form>
                </PaySection>
              )
            }
          </Gate>
          {quote && (
            <PaySection title={t('cvStep2')} description={expired ? t('cvExpired') : t('cvStep2Body')}>
              <Facts
                items={[
                  [t('cvYouConvert'), <MoneyText value={quote.q.fromAmount} asset={quote.q.fromAsset} test />],
                  [t('cvRate'), <span className="numeric">{quote.q.rate}</span>],
                  [t('cvFee'), <MoneyText value={quote.q.feeAmount} asset={quote.q.toAsset} test sign="minus" />],
                  [t('cvSpread'), <MoneyText value={quote.q.spreadAmount} asset={quote.q.toAsset} test sign="minus" />],
                  [t('cvExpected'), <MoneyText value={quote.q.expectedOutput} asset={quote.q.toAsset} test />],
                  [t('cvMinimum'), <MoneyText value={quote.q.minimumOutput} asset={quote.q.toAsset} test />],
                  [t('cvQuoteExpires'), <DateTime value={quote.q.expiresAt} />],
                ]}
              />
              <PortalReview<ConversionOrder>
                stepUp="payout"
                title={t('cvConvert')}
                variant="primary"
                description={t('cvReviewBody')}
                disabled={expired || !may || stepReason !== null}
                disabledReason={expired ? t('cvExpired') : !may ? t('cvNotAllowed') : (stepReason ?? undefined)}
                review={
                  <dl data-testid="pp-facts" className="pp-facts">
                    <div>
                      <dt>{t('cvYouConvert')}</dt>
                      <dd>
                        <MoneyText value={quote.q.fromAmount} asset={quote.q.fromAsset} test />
                      </dd>
                    </div>
                    <div>
                      <dt>{t('cvExpected')}</dt>
                      <dd>
                        <MoneyText value={quote.q.expectedOutput} asset={quote.q.toAsset} test />
                      </dd>
                    </div>
                    <div>
                      <dt>{t('cvMinimum')}</dt>
                      <dd>
                        <MoneyText value={quote.q.minimumOutput} asset={quote.q.toAsset} test />
                      </dd>
                    </div>
                    <div>
                      <dt>{t('cvFee')}</dt>
                      <dd>
                        <MoneyText value={quote.q.feeAmount} asset={quote.q.toAsset} test sign="minus" />
                      </dd>
                    </div>
                    <div>
                      <dt>{t('cvSpread')}</dt>
                      <dd>
                        <MoneyText value={quote.q.spreadAmount} asset={quote.q.toAsset} test sign="minus" />
                      </dd>
                    </div>
                  </dl>
                }
                perform={async () => {
                  const sent = await portal.conversionExecute({ requestId: request.id, quoteId: quote.q.quoteId });
                  // A confirmed order or a plain refusal ends this request; a lost or unreadable answer keeps the id.
                  if (sent.ok || sent.reason === 'error' || sent.reason === 'forbidden') request.renew();
                  return sent;
                }}
                onConfirmed={(o) => window.location.assign(orderHref(o.conversionId))}
              />
            </PaySection>
          )}
        </>
      )}
    </div>
  );
}

/** `/pay/conversion/:id`: one test conversion, from quote to fill. */
export function ConversionDetail({ portal, orderId }: { portal: PortalApi; orderId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const valid = isUuid(orderId);
  const order = useResource(
    (s) => (valid ? portal.conversionGet(orderId, s) : Promise.resolve(localRefusal(t('rConversionNotFound')))),
    `money:conversion:${orderId}`,
  );
  const readAt = useReadAt(order.resource.status === 'ready', order.resource);
  const r = order.resource;
  const off = useMemo(() => r.status === 'failed' && isConversionOff(r.failure), [r]);
  return (
    <div className="stack">
      <TestNotice />
      {off ? (
        <Off />
      ) : (
        <Gate resource={r} retry={order.reload} rows={4}>
          {(o) => (
            <>
              <DetailHeader
                back={{ href: '/pay/conversion', label: t('mnBackConversion') }}
                title={<MoneyText value={o.fromAmount} asset={o.fromAsset} test />}
                status={<ConversionChip status={o.status} />}
                subtitle={t('cvName', { from: o.fromAsset, to: o.toAsset, when: shortDay(o.createdAt, locale) })}
                action={
                  <Button variant="secondary" onClick={order.reload}>
                    {t('cvRefresh')}
                  </Button>
                }
              />
              <Freshness asOf={readAt} />
              <PaySection title={t('cvFactsTitle')}>
                <Facts
                  items={[
                    [t('cvFrom'), <MoneyText value={o.fromAmount} asset={o.fromAsset} test />],
                    [t('cvFilledFrom'), <MoneyText value={o.filledFromAmount} asset={o.fromAsset} test />],
                    [t('cvGot'), <MoneyText value={o.filledToAmount} asset={o.toAsset} test />],
                    ...(o.failureCode ? ([[t('cvFailure'), t('cvFailureBody')]] as const) : []),
                    [t('stlId'), <CopyReference value={o.conversionId} what={t('stlId')} />],
                  ]}
                />
              </PaySection>
              <PaySection title={t('cvTimelineTitle')}>
                <Timeline
                  label={t('cvTimelineTitle')}
                  items={[
                    { at: o.createdAt, title: t('cvEvCreated') },
                    ...(o.updatedAt !== o.createdAt ? [{ at: o.updatedAt, title: t(`cvStatus_${o.status}` as 'cvStatus_filled') }] : []),
                  ]}
                />
              </PaySection>
              <RelatedLinks links={[{ href: `/pay/settlements/${encodeURIComponent(o.settlementId)}`, label: t('mnRelSettlement') }]} />
            </>
          )}
        </Gate>
      )}
    </div>
  );
}
