// volt-room: /bank/earn
// volt-room: /bank/earn/pool
import { Button } from '@intafaced/ui/lit';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { ReadView } from '../../../shared/read-state';
import { t as copyText, Text } from '../copy';
import { date, funds, bps } from '../components';
import { earnCopy } from '../earn-copy';
import { earnPoolCopy } from '../earn-pool-copy';
import type { ActionSpec } from '../components';
import { BankSection, BankTabs, Continuation, NoRows, bankRoomProps } from '../bank-frame/BankFrame';
import { AutoInvestRules } from './AutoInvestRules';
import { EarnCompare, poolHref } from './EarnCompare';
import { EarnPool } from './EarnPool';
import { useEarnRoom } from './EarnPoolActions';

/**
 * `/bank/earn` and `/bank/earn/pool?id=<pool>` on the catalogue template: the pools the bank lists, compared side
 * by side, the person's savings and automatic rules; and one pool's own page in the template's item mode. Every figure is
 * the bank's answer; each deposit, withdrawal and rule opens the money review (`open`), which the Bank's routes draw.
 */
export function EarnRoom({ open }: { open: (spec: ActionSpec) => void }) {
  const earn = useEarnRoom();
  const { limit, setLimit, pools, positions, automation, validMaturity, maturityAllowsReview } = earn;
  return (
    <CatalogueTemplate
      {...bankRoomProps('Earn', earnCopy.t('description'))}
      state={{ kind: 'ready' }}
      filters={<BankTabs current="Earn" />}
      items={
        <>
          {pools.resource.status === 'ready' && <EarnCompare pools={pools.resource.data} />}
          <div className="lt-body">
            <BankSection
              title={copyText('rooms.your.positions')}
              actions={
                <Button tone="quiet" onClick={positions.reload}>
                  {earnCopy.t('refresh')}
                </Button>
              }
            >
              <ReadView resource={positions.resource} reload={positions.reload}>
                {(rows) => (
                  <>
                    {rows.length ? (
                      rows.map((position) => (
                        <article key={position.id}>
                          <header className="lt-title-row">
                            <div>
                              <h3>
                                {position.assetId}
                                <Text k="rooms.earn.position" />
                              </h3>
                              <p>
                                {position.maturesAt === null ? (
                                  earnCopy.t('noFixed')
                                ) : (
                                  <>
                                    <Text k="rooms.matures" />
                                    {validMaturity(position.maturesAt) ? date(position.maturesAt) : copyText('components.date.unavailable')}
                                  </>
                                )}
                              </p>
                            </div>
                            <strong className="lt-figure">
                              {funds(position.principal, position.assetId)}
                              <Text k="rooms.principal" />
                            </strong>
                          </header>
                          <p className="lt-hint">
                            {earnCopy.t('position')} · {position.id}
                          </p>
                          {/* A staking-style saving waits through unbonding, which its pool's own page shows and starts (BK-earn-04). */}
                          {position.unbondsAt !== null || position.unbondingDays !== null ? (
                            <p className="lt-hint" data-testid="earn-position-staking">
                              {position.unbondsAt !== null && position.staking === 'unbonding'
                                ? earnCopy.t('unbondingOnPool', { date: date(position.unbondsAt) })
                                : position.staking === 'unbonded'
                                  ? earnCopy.t('unbondedOnPool')
                                  : earnCopy.t('stakingOnPool')}{' '}
                              <a className="lt-link" href={poolHref(position.poolId)}>
                                {earnCopy.t('openPool')}
                              </a>
                            </p>
                          ) : maturityAllowsReview(position.maturesAt) ? (
                            <Button tone="secondary" onClick={() => open(earn.review.withdraw(position))}>
                              <Text k="rooms.review.withdrawal" />
                            </Button>
                          ) : (
                            <p className="lt-hint">{earnCopy.t(validMaturity(position.maturesAt!) ? 'locked' : 'maturityMissing')}</p>
                          )}
                        </article>
                      ))
                    ) : (
                      <NoRows title={copyText('rooms.no.active.earn.positions.returned')}>
                        <Text k="rooms.a.position.appears.only.after.the.service" />
                      </NoRows>
                    )}
                    <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                  </>
                )}
              </ReadView>
            </BankSection>
            <BankSection
              title={copyText('rooms.available.pools')}
              actions={
                <Button
                  tone="quiet"
                  onClick={() => {
                    pools.reload();
                    automation.reload();
                  }}
                >
                  {earnCopy.t('refresh')}
                </Button>
              }
            >
              <ReadView resource={automation.resource} reload={automation.reload}>
                {(policy) => !policy.enabled && <p className="lt-hint">{earnCopy.t('automationDisabled')}</p>}
              </ReadView>
              <ReadView resource={pools.resource} reload={pools.reload}>
                {(rows) => (
                  <>
                    {rows.length ? (
                      rows.map((pool) => (
                        <article key={pool.id}>
                          <header className="lt-title-row">
                            <div>
                              <h3>{pool.name}</h3>
                              <p>
                                {pool.assetId} · {pool.kind} ·{' '}
                                {pool.termDays === null
                                  ? copyText('rooms.flexible.term')
                                  : copyText('rooms.days', { value1: pool.termDays })}
                              </p>
                            </div>
                            <strong>
                              {bps(pool.aprBps)}
                              <Text k="rooms.apr" />
                            </strong>
                          </header>
                          <p className="lt-hint">
                            <Text k="rooms.minimum.deposit" />
                            {funds(pool.minDeposit, pool.assetId)}
                            <Text k="rooms.apr.is.the.configured.simple.annual.rate" />
                          </p>
                          <p className="lt-hint">
                            <a className="lt-link" href={poolHref(pool.id)} data-testid="earn-pool-link" data-pool={pool.id}>
                              {earnPoolCopy.t('details')}
                            </a>
                          </p>
                          <div className="lt-actions">
                            <Button tone="primary" onClick={() => open(earn.review.deposit(pool))}>
                              <Text k="rooms.deposit" />
                            </Button>
                            <Button
                              tone="secondary"
                              disabled={automation.resource.status !== 'ready' || !automation.resource.data.enabled}
                              onClick={() => open(earn.review.sweep(pool))}
                            >
                              <Text k="rooms.threshold.sweep" />
                            </Button>
                            <Button
                              tone="quiet"
                              disabled={automation.resource.status !== 'ready' || !automation.resource.data.enabled}
                              onClick={() => open(earn.review.roundUp(pool))}
                            >
                              <Text k="rooms.card.round.up" />
                            </Button>
                          </div>
                        </article>
                      ))
                    ) : (
                      <NoRows title={copyText('rooms.no.configured.pools.returned')}>
                        <Text k="rooms.earn.requires.a.published.rate.and.open" />
                      </NoRows>
                    )}
                    <Continuation count={rows.length} limit={limit} onMore={() => setLimit(Math.min(200, limit + 50))} />
                  </>
                )}
              </ReadView>
            </BankSection>
          </div>
          <p className="lt-hint">{earnCopy.t('unavailableHistory')}</p>
          <AutoInvestRules open={open} />
        </>
      }
    />
  );
}
/** `/bank/earn/pool?id=<pool>`: one pool's terms, rate history and the person's savings in it, inside the Earn room (J-bank-08 #1, #2). */
export function EarnPoolRoom({ search, open }: { search: string; open: (spec: ActionSpec) => void }) {
  const { t } = earnPoolCopy.useCopy();
  const poolId = new URLSearchParams(search).get('id');
  return (
    <CatalogueTemplate
      {...bankRoomProps('Earn', t('poolDescription'), t('poolTitle'))}
      state={{ kind: 'ready' }}
      filters={<BankTabs current="Earn" />}
      items={<EarnPool poolId={poolId && poolId.trim() !== '' ? poolId : null} open={open} />}
    />
  );
}
