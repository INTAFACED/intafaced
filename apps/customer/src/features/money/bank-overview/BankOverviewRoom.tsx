// volt-room: /bank
import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { OverviewTemplate } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { usePreferences, savePreferences } from '../../../shared/preferences';
import { ReadFailure, ReadView } from '../../../shared/read-state';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { BankSection, BankTabs, Continuation, NoRows } from '../bank-frame/BankFrame';
import { createMoneyClient, type MoneyOverview } from '../client';
import { amount, date, funds } from '../components';
import { t as copyText, Text } from '../copy';
import { spaceTotals } from '../holdings';
import { recoveryClaimCopy } from '../recovery-claim-copy';
import { AccountHome } from './AccountHome';
import { OnboardingBanner } from './OnboardingBanner';

const bankServices = [
  { href: '/bank/spaces', label: 'nav.spaces', note: 'overview.spaces.note' },
  { href: '/bank/transfers', label: 'nav.transfers', note: 'overview.transfers.note' },
  { href: '/bank/earn', label: 'nav.earn', note: 'overview.earn.note' },
  { href: '/bank/loans', label: 'nav.loans', note: 'overview.loans.note' },
  { href: '/bank/cards', label: 'nav.cards', note: 'overview.cards.note' },
  { href: '/bank/ramps', label: 'nav.ramps', note: 'overview.ramps.note' },
  { href: '/bank/analytics', label: 'nav.analytics', note: 'overview.analytics.note' },
  { href: '/bank/business', label: 'nav.business', note: 'overview.business.note' },
  { href: '/uc/record', label: 'index.money.activity', note: 'overview.activity.note' },
  { href: '/bank/account', label: 'nav.bank.account', note: 'overview.bank.account.note' },
  { href: '/bank/salary', label: 'nav.salary', note: 'overview.salary.note' },
  { href: '/bank/safety/scam', label: 'nav.scam', note: 'overview.scam.note' },
  { href: '/bank/safety/lost-phone', label: 'nav.lostPhone', note: 'overview.lostPhone.note' },
  { href: '/bank/safety/complaint', label: 'nav.complaint', note: 'overview.complaint.note' },
  { href: '/bank/safety/bereavement', label: 'nav.bereavement', note: 'overview.bereavement.note' },
] as const;

/** The way into a recovery claim from the Bank's services. */
function RecoveryClaimLink() {
  const { t } = recoveryClaimCopy.useCopy();
  return (
    <li>
      <a className="lt-row-link" href="/bank/recovery">
        <span className="lt-lines">
          <strong>{t('open')}</strong>
          <small className="lt-hint">{t('openHint')}</small>
        </span>
        <span aria-hidden="true">↗</span>
      </a>
    </li>
  );
}

/**
 * `/bank`: the first page of the neo-bank, on the overview template. It shows only what the bank answers (balances and
 * spaces, each with its own loading, failed or empty state) and opens every bank service, so a bank that is not set up
 * yet still reads as a place.
 */
export function BankOverview() {
  const { api, userId, mode } = useSession();
  const { hideBalances } = usePreferences();
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource<MoneyOverview>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: copyText('index.sign.in.to.see.your.money') };
    if (mode === 'Business')
      return { ok: false, reason: 'not_supported', message: copyText('index.a.verified.company.ledger.owner.and.company') };
    return { ok: true, data: await createMoneyClient(api).overview(userId, limit, signal) };
  }, `${userId}:${mode}:bank-overview:${limit}`);
  return (
    <OverviewTemplate
      title={copyText('index.bank')}
      description={copyText('overview.description')}
      state={{ kind: 'ready' }}
      rooms={<BankTabs current="Overview" />}
      actions={
        <div className="lt-actions">
          <a className="lt-button lt-button-primary" href="/bank/spaces">
            <Text k="index.create.space" />
          </a>
          <a className="lt-button lt-button-secondary" href="/bank/transfers">
            <Text k="index.transfer" />
          </a>
          <a className="lt-button lt-button-secondary" href="/uc/withdraw">
            <Text k="custody.withdraw" />
          </a>
        </div>
      }
      needsYou={<OnboardingBanner />}
      hero={
        <BankSection
          title={copyText('index.holdings')}
          actions={
            <>
              <Button tone="quiet" onClick={() => savePreferences({ hideBalances: !hideBalances })} aria-pressed={hideBalances}>
                <Text k={hideBalances ? 'index.show.amounts' : 'index.hide.amounts'} />
              </Button>
              <Button tone="quiet" onClick={reload}>
                <Text k="rooms.refresh" />
              </Button>
            </>
          }
        >
          <ReadView resource={resource} reload={reload}>
            {(overview) => (
              <div className="lt-stack">
                {overview.balances.ok && (
                  <p className="lt-hint">
                    {Number.isFinite(Date.parse(overview.balances.data.datetime)) ? (
                      <time dateTime={overview.balances.data.datetime} dir="auto">
                        {copyText('overview.reported', { time: date(overview.balances.data.datetime) })}
                      </time>
                    ) : (
                      <Text k="overview.time.unavailable" />
                    )}
                  </p>
                )}
                {!overview.balances.ok && <ReadFailure result={overview.balances} retry={reload} />}
                {overview.conflicts.length > 0 && (
                  <p className="lt-hint" role="status">
                    <Text k="index.separate.reads.disagree.for" />
                    {overview.conflicts.join(', ')}
                    <Text k="index.their.available.projection.is.omitted.refresh.to" />
                  </p>
                )}
                {overview.holdings.length ? (
                  <ul className="lt-rows">
                    {overview.holdings.map((holding) => (
                      <li key={holding.assetId}>
                        <a data-testid="money-holding" className="lt-row-link" href={`/portfolio/${encodeURIComponent(holding.assetId)}`}>
                          <span aria-hidden="true">{holding.assetId.slice(0, 1)}</span>
                          <span className="lt-lines">
                            <strong lang="und">{holding.assetId}</strong>
                            <small className="lt-hint">
                              {holding.quantity === null ? (
                                <Text k="index.available.projection.only" />
                              ) : (
                                <Text k="index.user.ledger.quantity" />
                              )}
                            </small>
                          </span>
                          <span className="lt-lines">
                            <strong className="lt-figure" dir="ltr">
                              <span>{hideBalances ? '••••' : displayAmount(holding.quantity ?? holding.available)}</span>
                              {!hideBalances && <span lang="und"> {holding.assetId}</span>}
                            </strong>
                            <dl className="lt-kv">
                              <div>
                                <dt>
                                  <Text k="index.available" />
                                </dt>
                                <dd className="lt-mono" dir="ltr">
                                  {hideBalances ? '••••' : amount(holding.available, holding.assetId)}
                                </dd>
                              </div>
                              <div>
                                <dt>
                                  <Text k="index.held.restricted" />
                                </dt>
                                <dd className="lt-mono" dir="ltr">
                                  {hideBalances ? '••••' : amount(holding.held, holding.assetId)}
                                </dd>
                              </div>
                            </dl>
                          </span>
                          <span aria-hidden="true">↗</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : overview.balances.ok ? (
                  <NoRows title={copyText('index.no.user.ledger.accounts.returned')}>
                    <Text k="index.an.empty.projection.is.not.a.complete" />
                  </NoRows>
                ) : (
                  <div className="lt-refusal" data-refusal="unreachable" role="status">
                    <h3 className="lt-refusal-title">
                      <Text k="availability.holdings.unavailable" />
                    </h3>
                    <p className="lt-refusal-body">
                      <Text k="availability.refresh.balances" />
                    </p>
                  </div>
                )}
                {overview.spaces.ok &&
                  (() => {
                    const totals = spaceTotals(overview.spaces.data, overview.holdings);
                    if (!totals.length) return null;
                    return (
                      <section className="lt-stack" aria-label={copyText('index.spaces.heading')}>
                        {totals.map((row) => (
                          <p key={row.assetId}>
                            <span className="lt-mono" dir="ltr">
                              {hideBalances
                                ? `•••• ${row.assetId}`
                                : copyText(row.total === null ? 'index.spaces.plus' : 'index.spaces.total', {
                                    amount: amount(row.total ?? row.inSpaces, row.assetId),
                                  })}
                            </span>
                            {row.total !== null && (
                              <small className="lt-hint">
                                {hideBalances ? '' : copyText('index.spaces.plus', { amount: amount(row.inSpaces, row.assetId) })}
                              </small>
                            )}
                          </p>
                        ))}
                        <small className="lt-hint">
                          <Text k="index.spaces.note" />
                        </small>
                      </section>
                    );
                  })()}
              </div>
            )}
          </ReadView>
        </BankSection>
      }
      sections={
        <div className="lt-body">
          <BankSection
            title={copyText('index.your.spaces')}
            actions={
              <a className="lt-link" href="/bank/spaces">
                <Text k="index.manage.spaces" />
              </a>
            }
          >
            <ReadView resource={resource} reload={reload}>
              {(overview) =>
                overview.spaces.ok ? (
                  <>
                    {overview.spaces.data.length ? (
                      <ul className="lt-rows">
                        {overview.spaces.data.map((space) => (
                          <li key={space.id}>
                            <a
                              data-testid="money-space-row"
                              className="lt-row-link"
                              href={`/bank/spaces?space=${encodeURIComponent(space.id)}`}
                            >
                              <span className="lt-lines">
                                <strong lang="und">{space.name}</strong>
                                <small className="lt-hint">
                                  {space.kind === 'primary' ? (
                                    <Text k="index.primary.already.in.the.user.ledger.projection" />
                                  ) : (
                                    <Text k="index.named.separate.ledger.subaccount" />
                                  )}
                                </small>
                              </span>
                              <span className="lt-mono" dir="ltr">
                                {funds(space.balance, space.assetId)}
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <NoRows title={copyText('rooms.no.spaces.returned')}>
                        <Text k="rooms.create.a.named.space.its.balance.will" />
                      </NoRows>
                    )}
                    <Continuation count={overview.spaces.data.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                  </>
                ) : (
                  <ReadFailure result={overview.spaces} retry={reload} />
                )
              }
            </ReadView>
          </BankSection>
          <AccountHome />
          <BankSection title={copyText('overview.services')}>
            <nav aria-label={copyText('overview.services')}>
              <ul className="lt-rows">
                {bankServices.map((service) => (
                  <li key={service.href}>
                    <a className="lt-row-link" href={service.href}>
                      <span className="lt-lines">
                        <strong>
                          <Text k={service.label} />
                        </strong>
                        <small className="lt-hint">
                          <Text k={service.note} />
                        </small>
                      </span>
                      <span aria-hidden="true">↗</span>
                    </a>
                  </li>
                ))}
                <RecoveryClaimLink />
              </ul>
            </nav>
          </BankSection>
        </div>
      }
    />
  );
}
