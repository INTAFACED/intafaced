// volt-room: /pay/conversion/new
// volt-room: portal:conversion-new
import { useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { useResource } from '../../../../shared/resource';
import { parseAmount } from '../../../../shared/money';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { PortalApi } from '../api';
import { useNow, useUrlParam } from '../hooks';
import { useUnsavedForm } from '../useUnsavedForm';
import type { Settlement } from '../schemas';
import { DateTime } from '../ui/DateTime';
import { formatMoney } from '../ui/format';
import { useRequestId } from '../payments/invoice-model';
import { uiCopy } from '../ui/copy';
import { FlowRoom } from '../volt/FlowRoom';
import { Empty, Facts, Gate, LinkButton, MoneyText, Section, SelectField, TestTag } from '../volt/parts';
import { Review } from '../volt/Review';
import { NamedBlocker } from './kit-parts';
import { mc } from './copy';
import { useMoneyReason } from '../access/MoneyAction';
import type { ConversionOrder, ConversionQuote } from '@intafaced/contracts/conversion';
import { settlementName } from './Settlements';
import { isConversionOff } from './refusals';
import { leaveTo } from '../../../../app/location';

// The list and each order's own page are on the record-list template (`./ConversionOrders`); this file keeps the
// quote-and-convert flow, which is on its own template.
export { ConversionChip } from './ConversionOrders';

/** The tab-kept request id is named by the settlement alone: no amount, address or quote in the key. */
export const conversionRequestScope = (settlementId: string | null) => `conversion:${settlementId ?? 'none'}`;
const orderHref = (id: string) => `/pay/conversion/${encodeURIComponent(id)}`;

/** Conversion is a sandbox. This says so on every conversion page, before anything else. */
function TestNotice() {
  const { t } = mc.useCopy();
  return (
    <p className="lt-callout lt-callout-warn" role="note">
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

/** `/pay/conversion/new` on the flow template: requires `payout.approve`. */
export function ConversionNewRoom({ portal }: { portal: PortalApi }) {
  return <FlowRoom need="payout.approve">{({ merchantId }) => <ConversionNew portal={portal} merchantId={merchantId} />}</FlowRoom>;
}

/** `/pay/conversion/new`: pick a settlement and an amount, read the quote, then convert. A quote is good for a short time. */
function ConversionNew({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
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
    <div className="lt-stack">
      <TestNotice />
      {refusal?.off ? (
        <Off />
      ) : (
        <>
          <Gate resource={settlements.resource} retry={settlements.reload} rows={2}>
            {() =>
              usd.length === 0 ? (
                <Empty title={t('cvNoUsdTitle')} action={<LinkButton href="/pay/settlements">{t('pnNoneAction')}</LinkButton>}>
                  {t('cvNoUsdBody')}
                </Empty>
              ) : (
                <Section title={t('cvStep1')} description={t('cvStep1Body')}>
                  <form data-testid="form-stack" className="lt-stack" noValidate onSubmit={(e) => e.preventDefault()}>
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
                    <p className="lt-hint">{t('cvPair')}</p>
                    <Button
                      tone="secondary"
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
                    {!may && <p className="lt-hint">{t('cvNotAllowed')}</p>}
                    {problem && <p className="lt-hint">{problem}</p>}
                    {refusal && !refusal.off && refusal.message && (
                      <p role="alert" className="lt-error">
                        {refusal.message}
                      </p>
                    )}
                  </form>
                </Section>
              )
            }
          </Gate>
          {quote && (
            <Section title={t('cvStep2')} description={expired ? t('cvExpired') : t('cvStep2Body')}>
              <Facts
                items={[
                  [t('cvYouConvert'), <MoneyText value={quote.q.fromAmount} asset={quote.q.fromAsset} test />],
                  [t('cvRate'), <span className="lt-num">{quote.q.rate}</span>],
                  [t('cvFee'), <MoneyText value={quote.q.feeAmount} asset={quote.q.toAsset} test sign="minus" />],
                  [t('cvSpread'), <MoneyText value={quote.q.spreadAmount} asset={quote.q.toAsset} test sign="minus" />],
                  [t('cvExpected'), <MoneyText value={quote.q.expectedOutput} asset={quote.q.toAsset} test />],
                  [t('cvMinimum'), <MoneyText value={quote.q.minimumOutput} asset={quote.q.toAsset} test />],
                  [t('cvQuoteExpires'), <DateTime value={quote.q.expiresAt} />],
                ]}
              />
              <Review<ConversionOrder>
                stepUp="payout"
                title={t('cvConvert')}
                variant="primary"
                description={t('cvReviewBody')}
                disabled={expired || !may || stepReason !== null}
                disabledReason={expired ? t('cvExpired') : !may ? t('cvNotAllowed') : (stepReason ?? undefined)}
                review={
                  <Facts
                    items={[
                      [t('cvYouConvert'), <MoneyText value={quote.q.fromAmount} asset={quote.q.fromAsset} test />],
                      [t('cvExpected'), <MoneyText value={quote.q.expectedOutput} asset={quote.q.toAsset} test />],
                      [t('cvMinimum'), <MoneyText value={quote.q.minimumOutput} asset={quote.q.toAsset} test />],
                      [t('cvFee'), <MoneyText value={quote.q.feeAmount} asset={quote.q.toAsset} test sign="minus" />],
                      [t('cvSpread'), <MoneyText value={quote.q.spreadAmount} asset={quote.q.toAsset} test sign="minus" />],
                    ]}
                  />
                }
                perform={async () => {
                  const sent = await portal.conversionExecute({ requestId: request.id, quoteId: quote.q.quoteId });
                  // A confirmed order or a plain refusal ends this request; a lost or unreadable answer keeps the id.
                  if (sent.ok || sent.reason === 'error' || sent.reason === 'forbidden') request.renew();
                  return sent;
                }}
                onConfirmed={(o) => leaveTo(orderHref(o.conversionId))}
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
