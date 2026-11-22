// volt-room: /pay/conversion/new
// volt-room: portal:conversion-new
import { useState, type ReactNode } from 'react';
import { Button, Field, RefusalBox } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { type ConversionOrder, type ConversionQuote } from '@intafaced/contracts/conversion';
import { useResource } from '../../../../shared/resource';
import { parseAmount } from '../../../../shared/money';
import { useMerchantAccess } from '../access/MerchantAccess';
import { useMoneyReason } from '../access/MoneyAction';
import type { PortalApi } from '../api';
import { reason, type ReasonKey } from '../chrome/copy';
import { useNow, useUrlParam } from '../hooks';
import { useRequestId } from '../payments/invoice-model';
import type { Settlement } from '../schemas';
import { formatMoney } from '../ui/format';
import { uiCopy } from '../ui/copy';
import { useUnsavedForm } from '../useUnsavedForm';
import { mc } from '../money/copy';
import { isConversionOff } from '../money/refusals';
import { settlementName } from '../money/Settlements';
import { DateTime, Empty, Facts, Gate, LinkButton, MoneyText, Section, SelectField, TestTag } from './parts';
import { PortalReview } from './review';

/** The tab-kept request id is named by the settlement alone: no amount, address or quote in the key. */
export const conversionRequestScope = (settlementId: string | null) => `conversion:${settlementId ?? 'none'}`;
const orderHref = (id: string) => `/pay/conversion/${encodeURIComponent(id)}`;

/** Conversion is a sandbox. This says so on every conversion page, before anything else. */
function TestNotice() {
  const { t } = mc.useCopy();
  return (
    <p role="note">
      <TestTag /> <strong>{t('cvTestTitle')}</strong> {t('cvTestBody')}
    </p>
  );
}

/** The portal's named blocker (`money/common.tsx`'s `NamedBlocker`, a not-live card), on the kit. */
function NamedBlocker({ title, why, needs, children }: { title: string; why: ReasonKey; needs: string; children?: ReactNode }) {
  return (
    <RefusalBox
      data-testid="pfo-soon"
      data-needs={needs}
      role={undefined}
      aria-label={title}
      refusal={{ variant: 'parked', title: reason(why), body: title }}
    >
      {children && <p>{children}</p>}
    </RefusalBox>
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

/**
 * `/pay/conversion/new`, on the flow template: pick a settlement and an amount, read the quote, then convert. A quote
 * is good for a short time.
 */
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
    <FlowTemplate
      framed
      title={t('pageConvertNew')}
      state={{ kind: 'ready' }}
      step={
        <>
          <TestNotice />
          {refusal?.off ? (
            <Off />
          ) : (
            <>
              <Gate resource={settlements.resource} retry={settlements.reload} rows={2}>
                {() =>
                  usd.length === 0 ? (
                    <Empty
                      title={t('cvNoUsdTitle')}
                      body={t('cvNoUsdBody')}
                      action={<LinkButton href="/pay/settlements">{t('pnNoneAction')}</LinkButton>}
                    />
                  ) : (
                    <Section title={t('cvStep1')} description={t('cvStep1Body')}>
                      <form data-testid="form-stack" noValidate onSubmit={(e) => e.preventDefault()}>
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
                        {refusal && !refusal.off && refusal.message && <p role="alert">{refusal.message}</p>}
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
                      [t('cvRate'), <span className="lt-mono">{quote.q.rate}</span>],
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
                    onConfirmed={(o) => window.location.assign(orderHref(o.conversionId))}
                  />
                </Section>
              )}
            </>
          )}
        </>
      }
    />
  );
}
