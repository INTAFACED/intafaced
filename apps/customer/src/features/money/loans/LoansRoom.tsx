// volt-room: /bank/loans
import type { z } from 'zod';
import { Button } from '@intafaced/ui/lit';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { ReadView } from '../../../shared/read-state';
import type { Resource } from '../../../shared/resource';
import { dec } from '../../../data/decimal';
import { t as copyText, Text } from '../copy';
import { bps, date, funds, type ActionSpec } from '../components';
import type { loanSchema } from '../contracts';
import { loanActionAllowed, loanStatusNote, useLoansRoom } from '../LoanHealth';
import { loanCopy, loanStatusLabel } from '../loan-copy';
import { loanApplyCopy } from '../loan-apply-copy';
import { loanDetailCopy } from '../loan-detail-copy';
import { BankSection, BankTabs, Continuation, NoRows, bankRoomProps } from '../bank-frame/BankFrame';
import { BANK_LOANS_HEALTH } from '@intafaced/contracts/bank-loans-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';

type Loan = z.infer<typeof loanSchema>;
type Health = ProcedureOutput<typeof BANK_LOANS_HEALTH>;

/**
 * `/bank/loans` on the catalogue template: the loan products the bank lists, the person's loans with each one's
 * risk, and the portfolio's loan health. Every figure is the bank's answer; each borrowing, repayment and collateral move
 * opens the money review (`open`), which the Bank's routes draw.
 */
export function LoansRoom({ open }: { open: (spec: ActionSpec) => void }) {
  const room = useLoansRoom();
  const { limit, setLimit, products, loans, health } = room;
  return (
    <CatalogueTemplate
      {...bankRoomProps('Loans', copyText('rooms.configured.borrowing.terms.ledger.collateral.and.authoritative'))}
      state={{ kind: 'ready' }}
      section={<BankTabs />}
      items={
        <div className="lt-body">
          <BankSection title={copyText('rooms.loan.health')}>
            <ReadView resource={health.resource} reload={health.reload}>
              {(risk) => (
                <>
                  <div className="lt-title-row">
                    <strong className="lt-figure">
                      {risk.portfolioLtvBps === Number.MAX_SAFE_INTEGER ? loanCopy.t('portfolioRange') : bps(risk.portfolioLtvBps)}
                      <Text k="rooms.ltv" />
                    </strong>
                    <span>
                      {risk.loans.length}
                      <Text k="rooms.loans.in.this.risk.calculation" />
                    </span>
                  </div>
                  <p className="lt-hint">
                    <Text k="rooms.this.calculation.values.loans.only.its.response" />
                  </p>
                </>
              )}
            </ReadView>
          </BankSection>
          <BankSection title={copyText('rooms.loan.products')}>
            <ReadView resource={products.resource} reload={products.reload}>
              {(rows) => (
                <>
                  {rows.length ? (
                    rows.map((product) => (
                      <article key={product.id}>
                        <header className="lt-title-row">
                          <div>
                            <h3>{product.name}</h3>
                            <p>
                              <Text k="rooms.borrow" />
                              {product.debtAssetId}
                              <Text k="rooms.secure.with" />
                              {product.collateralAssetId}
                            </p>
                          </div>
                          <strong>
                            {bps(product.aprBps)}
                            <Text k="rooms.apr" />
                          </strong>
                        </header>
                        <dl className="lt-kv">
                          <div>
                            <dt>
                              <Text k="rooms.minimum.principal" />
                            </dt>
                            <dd>
                              {dec(product.minPrincipal) === 0n
                                ? copyText('rooms.no.minimum')
                                : funds(product.minPrincipal, product.debtAssetId)}
                            </dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.maximum.ltv" />
                            </dt>
                            <dd>{bps(product.maxLtvBps)}</dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.margin.call.ltv" />
                            </dt>
                            <dd>{bps(product.marginCallLtvBps)}</dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.liquidation.ltv" />
                            </dt>
                            <dd>{bps(product.liquidationLtvBps)}</dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.mark.quote.asset" />
                            </dt>
                            <dd>{product.quoteAssetId}</dd>
                          </div>
                        </dl>
                        <Button tone="primary" onClick={() => open(room.review.open(product))}>
                          <Text k="rooms.review.borrowing" />
                        </Button>
                        <p className="lt-hint">
                          <LoanApplyLink productId={product.id} />
                        </p>
                      </article>
                    ))
                  ) : (
                    <NoRows title={copyText('rooms.no.loan.products.returned')}>
                      <Text k="rooms.borrowing.requires.a.configured.open.product.usable" />
                    </NoRows>
                  )}
                  <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                </>
              )}
            </ReadView>
          </BankSection>
          <BankSection
            title={copyText('rooms.your.loans')}
            actions={
              <Button
                tone="quiet"
                onClick={() => {
                  loans.reload();
                  health.reload();
                }}
              >
                <Text k="rooms.refresh.loans.and.health" />
              </Button>
            }
          >
            <ReadView resource={loans.resource} reload={loans.reload}>
              {(rows) => (
                <>
                  {rows.length ? (
                    rows.map((loan) => (
                      <article key={loan.id} data-loan-id={loan.id}>
                        <header className="lt-title-row">
                          <div>
                            <h3>
                              {loan.debtAssetId}
                              <Text k="rooms.loan" />
                            </h3>
                            <p>
                              {loanStatusLabel(loan.status)}
                              {loan.marginCalledAt && copyText('rooms.margin.called', { value1: date(loan.marginCalledAt) })}
                            </p>
                          </div>
                          <strong>
                            {bps(loan.aprBps)}
                            <Text k="rooms.apr" />
                          </strong>
                        </header>
                        <dl className="lt-kv">
                          <div>
                            <dt>{loan.status === 'pending' ? loanCopy.t('pendingPrincipal') : <Text k="rooms.outstanding.principal" />}</dt>
                            <dd>{funds(loan.outstandingPrincipal, loan.debtAssetId)}</dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.outstanding.interest" />
                            </dt>
                            <dd>{funds(loan.outstandingInterest, loan.debtAssetId)}</dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.ledger.collateral" />
                            </dt>
                            <dd>{funds(loan.collateral, loan.collateralAssetId)}</dd>
                          </div>
                          <div>
                            <dt>
                              <Text k="rooms.loan.reference" />
                            </dt>
                            <dd>{loan.id}</dd>
                          </div>
                        </dl>
                        <LoanHealthPanel loan={loan} resource={health.resource} reload={health.reload} />
                        <LoanDetailLink loanId={loan.id} />
                        {loanStatusNote(loan.status) && <p className="lt-hint">{loanStatusNote(loan.status)}</p>}
                        <div className="lt-actions">
                          <Button tone="primary" disabled={!loanActionAllowed(loan, 'repay')} onClick={() => open(room.review.repay(loan))}>
                            <Text k="rooms.repay" />
                          </Button>
                          <Button
                            tone="secondary"
                            disabled={!loanActionAllowed(loan, 'addCollateral')}
                            onClick={() => open(room.review.addCollateral(loan))}
                          >
                            <Text k="rooms.add.collateral" />
                          </Button>
                          <Button
                            tone="secondary"
                            disabled={!loanActionAllowed(loan, 'releaseExcess')}
                            onClick={() => open(room.review.releaseExcess(loan))}
                          >
                            <Text k="rooms.release.excess" />
                          </Button>
                          <Button tone="quiet" disabled={!loanActionAllowed(loan, 'close')} onClick={() => open(room.review.close(loan))}>
                            <Text k="rooms.close.settled.loan" />
                          </Button>
                        </div>
                      </article>
                    ))
                  ) : (
                    <NoRows title={copyText('rooms.no.loans.returned')}>
                      <Text k="rooms.no.loan.balance.is.inferred.from.an" />
                    </NoRows>
                  )}
                  <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                  <p className="lt-hint">{loanCopy.t('unavailableHistory')}</p>
                </>
              )}
            </ReadView>
          </BankSection>
        </div>
      }
    />
  );
}
/** Each loan's way to its details page: the payoff quote, the projection and the statement (J-bank-11 #1). */
function LoanDetailLink({ loanId }: { loanId: string }) {
  const { t } = loanDetailCopy.useCopy();
  return (
    <p className="lt-hint">
      <a className="lt-link" href={`/bank/loans/detail?loan=${encodeURIComponent(loanId)}`}>
        {t('open')}
      </a>
    </p>
  );
}
function LoanApplyLink({ productId }: { productId?: string }) {
  const { t } = loanApplyCopy.useCopy();
  return (
    <a className="lt-link" href={productId ? `/bank/loans/apply?product=${encodeURIComponent(productId)}` : '/bank/loans/apply'}>
      {t('apply')}
    </a>
  );
}

function LoanHealthPanel({ loan, resource, reload }: { loan: Loan; resource: Resource<Health>; reload: () => void }) {
  const { t } = loanCopy.useCopy();
  const matches = resource.status === 'ready' ? resource.data.loans.filter((row) => row.loanId === loan.id) : [];
  const ratio = matches.length === 1 ? matches[0]!.ltvBps : undefined;
  const valid = ratio !== undefined && Number.isSafeInteger(ratio) && ratio >= 0;
  const ranged = ratio === Number.MAX_SAFE_INTEGER;
  return (
    <section aria-label={t('riskFor', { loanId: loan.id })}>
      <div className="lt-title-row">
        <h4>{t('riskLabel')}</h4>
        {valid && !ranged ? (
          <strong className="lt-figure">{resource.status === 'loading' ? t('riskLoading') : bps(ratio)}</strong>
        ) : (
          <strong className="lt-hint">
            {resource.status === 'loading' ? t('riskLoading') : valid ? t('riskRange') : t('riskUnavailable')}
          </strong>
        )}
      </div>
      <div>
        <p className="lt-hint">{valid ? t('riskNote') : t('riskUnavailableNote')}</p>
        {resource.status === 'failed' && (
          <Button tone="quiet" onClick={reload}>
            {t('riskRefresh')}
          </Button>
        )}
      </div>
    </section>
  );
}
