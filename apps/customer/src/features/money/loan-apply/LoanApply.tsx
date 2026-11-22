import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { amount, bps, date, positiveMoney, useBankRead, type ActionSpec } from '../components';
import { LOAN_ELIGIBILITY_KEYS, type LoanEligibility, type LoanFees, type LoanQuote } from '../contracts';
import { loanApplyCopy } from '../loan-apply-copy';

/**
 * `/bank/loans/apply?product=<id>` (J-bank-09 #1 to #4, BK-loan-01): choose a loan, see its limits, work out the
 * collateral at the bank's own prices (`bank.loans.quote`), read each condition that applies (`bank.loans.eligibility`)
 * and the opening fee (`bank.loans.fees`), then review and open. The browser works no figure out; `open` checks the
 * prices again, so a quote is never a promise.
 */

type Copy = ReturnType<typeof loanApplyCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const DECIMAL = /^\d+(\.\d{1,18})?$/;

/** What a refused application read says, by the bank's code, with the code as a reference. */
function applyRefusal(t: Copy, failure: Pick<Failed, 'code' | 'message'>): string {
  const words: Record<string, string> = {
    'bank.loans_disabled': t('disabled'),
    'bank.mark_missing': t('markMissing'),
    'bank.below_minimum': t('belowMinimum'),
    'bank.loan_product_closed': t('productClosed'),
    'bank.loan_fee_unset': t('feeNotSet'),
    'bank.loan_fee_unwired': t('feeUnwired'),
    'bank.loan_rate_changed': t('rateChanged'),
    'bank.asset_paused': t('borrowPaused'),
    'bank.loan_product_not_found': t('notFound'),
  };
  const code = failure.code ?? '';
  const said = words[code] ?? failure.message;
  return code.includes('.') ? `${said} ${t('reference', { code })}` : said;
}

/** A panel of the application: its title, its lead line, and what is in it. */
function Panel({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {lead && <p className="lt-hint">{lead}</p>}
      {children}
    </section>
  );
}

/** The review button while it is off, with the reason it is off read with it. */
function ReviewOff({ label, reason }: { label: ReactNode; reason: ReactNode }) {
  const id = useId();
  return (
    <div>
      <Button tone="primary" disabled aria-describedby={id}>
        {label}
      </Button>
      <p id={id} className="lt-hint">
        {reason}
      </p>
    </div>
  );
}

const Loading = () => <Skeleton shape="rows" count={3} />;

function Refused({ failure, retry }: { failure: Failed; retry: () => void }) {
  const { t } = loanApplyCopy.useCopy();
  return (
    <div role="alert" data-code={failure.code ?? ''}>
      <p>{applyRefusal(t, failure)}</p>
      <Button tone="quiet" onClick={retry}>
        {t('retry')}
      </Button>
    </div>
  );
}

function QuoteFigures({ quote }: { quote: LoanQuote }) {
  const { t } = loanApplyCopy.useCopy();
  return (
    <div
      data-testid="loan-apply-quote"
      data-principal={quote.principal}
      data-collateral={quote.requiredCollateral}
      data-ltv-bps={String(quote.startingLtvBps)}
      data-liquidation-price={quote.liquidationPrice}
    >
      <dl className="lt-kv">
        <div>
          <dt>{t('calcCollateral')}</dt>
          <dd>{amount(quote.requiredCollateral, quote.collateralAssetId)}</dd>
        </div>
        <div>
          <dt>{t('calcLtv')}</dt>
          <dd>{bps(quote.startingLtvBps)}</dd>
        </div>
        <div>
          <dt>{t('calcLiquidation', { asset: quote.collateralAssetId })}</dt>
          <dd>{t('calcPriceUnit', { price: quote.liquidationPrice, quote: quote.quoteAssetId, asset: quote.collateralAssetId })}</dd>
        </div>
      </dl>
      <p className="lt-hint">
        {t('calcPrices', {
          debt: quote.debtAssetId,
          debtPrice: quote.debtPrice,
          collateral: quote.collateralAssetId,
          collateralPrice: quote.collateralPrice,
          quote: quote.quoteAssetId,
          time: date(quote.pricedAt, true),
        })}
      </p>
    </div>
  );
}

function EligibilityList({ eligibility }: { eligibility: LoanEligibility }) {
  const { t } = loanApplyCopy.useCopy();
  const byKey = new Map(eligibility.reasons.map((reason) => [reason.key, reason]));
  return (
    <div data-testid="loan-apply-eligibility" data-eligible={String(eligibility.eligible)}>
      <dl className="lt-kv">
        {LOAN_ELIGIBILITY_KEYS.map((key) => {
          const reason = byKey.get(key);
          if (!reason) return null;
          return (
            <div key={key} data-key={key} data-state={reason.state} data-code={reason.code ?? ''}>
              <dt>{t(`elig_${key}`)}</dt>
              <dd>
                {t(`state_${reason.state}`)}
                {reason.code ? ` ${t('reference', { code: reason.code })}` : ''}
              </dd>
            </div>
          );
        })}
      </dl>
      {byKey.get('jurisdiction_rules')?.state === 'not_set' && <p className="lt-hint">{t('jurisdictionNotSet')}</p>}
      <p role="status">{eligibility.eligible ? t('eligOpen') : t('eligClosed')}</p>
    </div>
  );
}

function FeeLines({ fees, principal }: { fees: LoanFees; principal: string | null }) {
  const { t } = loanApplyCopy.useCopy();
  const fee = fees.origination;
  if (fee.status === 'not_set') {
    return (
      <p data-testid="loan-apply-fee" data-state="not_set">
        {t('feeNotSet')}
      </p>
    );
  }
  return (
    <div data-testid="loan-apply-fee" data-state="published" data-bps={String(fee.bps)} data-amount={fee.amount ?? ''}>
      <dl className="lt-kv">
        <div>
          <dt>{t('feeRate')}</dt>
          <dd>{bps(fee.bps)}</dd>
        </div>
        {fee.amount !== null && principal !== null && (
          <div>
            <dt>{t('feeAmount', { amount: amount(principal, fees.assetId) })}</dt>
            <dd>{amount(fee.amount, fees.assetId)}</dd>
          </div>
        )}
      </dl>
      {fee.bps === 0 && <p className="lt-hint">{t('feeZero')}</p>}
      {!fee.collectable && <p role="alert">{t('feeUncollectable')}</p>}
    </div>
  );
}

function ProductApplication({ productId, open }: { productId: string; open: (spec: ActionSpec) => void }) {
  const { t } = loanApplyCopy.useCopy();
  const products = useBankRead('loans.products', { limit: 200 });
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const quote = useBankRead('loans.quote', { productId, principal: asked ?? '0' }, asked !== null);
  const eligibility = useBankRead('loans.eligibility', { productId });
  const fees = useBankRead('loans.fees', asked === null ? { productId } : { productId, principal: asked });

  if (products.resource.status === 'loading') return <Loading />;
  if (products.resource.status === 'failed') return <Refused failure={products.resource.failure} retry={products.reload} />;
  const product = products.resource.data.find((one) => one.id === productId);
  if (!product) {
    return <p role="alert">{t('notFound')}</p>;
  }

  function show(event: FormEvent) {
    event.preventDefault();
    const what = typed.trim();
    if (!DECIMAL.test(what)) return setInvalid(true);
    setInvalid(false);
    // The same amount again is a fresh quote on today's marks, not a no-op.
    if (what === asked) {
      quote.reload();
      fees.reload();
    }
    setAsked(what);
  }

  const ready = quote.resource.status === 'ready' && asked !== null ? quote.resource.data : null;
  const eligible = eligibility.resource.status === 'ready' && eligibility.resource.data.eligible;

  return (
    <>
      <Panel title={t('limitsTitle')}>
        <dl className="lt-kv" data-testid="loan-apply-limits" data-product-id={product.id}>
          <div>
            <dt>{t('rate')}</dt>
            <dd data-value={String(product.aprBps)}>{bps(product.aprBps)}</dd>
          </div>
          <div>
            <dt>{t('maxLtv')}</dt>
            <dd data-value={String(product.maxLtvBps)}>{bps(product.maxLtvBps)}</dd>
          </div>
          <div>
            <dt>{t('minPrincipal')}</dt>
            <dd>{/^0(\.0+)?$/.test(product.minPrincipal) ? t('noMinimum') : amount(product.minPrincipal, product.debtAssetId)}</dd>
          </div>
          <div>
            <dt>{t('marginCall')}</dt>
            <dd>{bps(product.marginCallLtvBps)}</dd>
          </div>
          <div>
            <dt>{t('liquidation')}</dt>
            <dd>{bps(product.liquidationLtvBps)}</dd>
          </div>
          <div data-testid="loan-apply-term" data-state="not_set">
            <dt>{t('term')}</dt>
            <dd>{t('termNotSet')}</dd>
          </div>
          <div data-testid="loan-apply-tiers" data-state="not_set">
            <dt>{t('tiers')}</dt>
            <dd>{t('tiersNotSet')}</dd>
          </div>
        </dl>
      </Panel>
      <Panel title={t('calcTitle')} lead={t('calcLead')}>
        <form onSubmit={show} noValidate>
          <label className="lt-field">
            <span>{t('calcAmount', { asset: product.debtAssetId })}</span>
            <input name="principal" value={typed} inputMode="decimal" onChange={(event) => setTyped(event.target.value)} />
          </label>
          <div className="lt-actions">
            <Button type="submit" tone="secondary">
              {t('calcShow')}
            </Button>
          </div>
          {invalid && <p role="alert">{t('calcInvalid')}</p>}
        </form>
        {asked === null && <p className="lt-hint">{t('calcAsk')}</p>}
        {asked !== null && quote.resource.status === 'loading' && <Loading />}
        {asked !== null && quote.resource.status === 'failed' && <Refused failure={quote.resource.failure} retry={quote.reload} />}
        {ready && <QuoteFigures quote={ready} />}
      </Panel>
      <Panel title={t('eligTitle')} lead={t('eligLead')}>
        {eligibility.resource.status === 'loading' && <Loading />}
        {eligibility.resource.status === 'failed' && <Refused failure={eligibility.resource.failure} retry={eligibility.reload} />}
        {eligibility.resource.status === 'ready' && <EligibilityList eligibility={eligibility.resource.data} />}
      </Panel>
      <Panel title={t('feeTitle')}>
        {fees.resource.status === 'loading' && <Loading />}
        {fees.resource.status === 'failed' && <Refused failure={fees.resource.failure} retry={fees.reload} />}
        {fees.resource.status === 'ready' && <FeeLines fees={fees.resource.data} principal={asked} />}
      </Panel>
      {ready && eligible ? (
        <div className="lt-actions">
          <Button
            tone="primary"
            onClick={() =>
              open({
                title: t('open'),
                procedure: 'loans.open',
                fields: [
                  positiveMoney(product.debtAssetId, 'principal', t('principal')),
                  positiveMoney(product.collateralAssetId, 'collateralAmount', t('collateral')),
                ],
                initial: { principal: ready.principal, collateralAmount: ready.requiredCollateral },
                facts: [
                  [t('rate'), bps(product.aprBps)],
                  [t('maxLtv'), bps(product.maxLtvBps)],
                  [t('marginCall'), bps(product.marginCallLtvBps)],
                  [t('liquidation'), bps(product.liquidationLtvBps)],
                  [t('quotedCollateral'), amount(ready.requiredCollateral, product.collateralAssetId)],
                ],
                notes: [t('openNote'), t('openChecked')],
                input: (values, requestId) => ({
                  loanId: requestId,
                  productId: product.id,
                  principal: values.principal,
                  collateralAmount: values.collateralAmount,
                  // The rate on the review: a rate changed since then refuses rather than opening at one not shown.
                  expectedAprBps: product.aprBps,
                }),
                submit: t('open'),
              })
            }
          >
            {t('review')}
          </Button>
        </div>
      ) : (
        <ReviewOff label={t('review')} reason={ready ? t('reviewBlocked') : t('reviewNeedsQuote')} />
      )}
    </>
  );
}

/** The page: a loan picker, then the chosen loan's application. */
export function LoanApply({ productId, open }: { productId: string | null; open: (spec: ActionSpec) => void }) {
  const { t } = loanApplyCopy.useCopy();
  const products = useBankRead('loans.products', { limit: 200 });
  const [chosen, setChosen] = useState<string | null>(productId);
  return (
    <div data-testid="loan-apply">
      <Panel title={t('chooseTitle')}>
        {products.resource.status === 'loading' && <Loading />}
        {products.resource.status === 'failed' && <Refused failure={products.resource.failure} retry={products.reload} />}
        {products.resource.status === 'ready' &&
          (products.resource.data.length === 0 ? (
            <p>{t('chooseNone')}</p>
          ) : (
            <label className="lt-field">
              <span>{t('chooseLabel')}</span>
              <select value={chosen ?? ''} onChange={(event) => setChosen(event.target.value === '' ? null : event.target.value)}>
                <option value="">—</option>
                {products.resource.data.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
      </Panel>
      {chosen && <ProductApplication key={chosen} productId={chosen} open={open} />}
      <p>
        <a className="lt-link" href="/bank/loans">
          {t('back')}
        </a>
      </p>
    </div>
  );
}
