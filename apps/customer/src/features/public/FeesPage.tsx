import { useMemo } from 'react';
import { useDataEnv, useSource } from '../../data/hooks';
import { refusalCopy } from '../../data';
import type { Loadable } from '../../data/types';
import { bpsAsPercent, publicFeesFetcher, rowFor, type PublicFeeRow, type PublicFeeSchedule } from './fees';
import { feesCopy } from './fees-copy';
import './public-pages.css';

/**
 * /fees: the published spot fee schedule for anyone, signed in or not (SP-fees-vip-02, J-cex-spot-10 #2). One table per
 * pair group, one row per tier; a tier the owner left blank in a group reads "not set". The network fee for sending a
 * coin out is its own line, never folded into a trading rate.
 */
export function FeesPage() {
  const env = useDataEnv();
  const source = useMemo(
    () => env.poller.source<PublicFeeSchedule | null>('public-fees', publicFeesFetcher(env.api), { intervalMs: 60_000 }),
    [env],
  );
  return <FeesView load={useSource(source)} />;
}

export function FeesView({ load }: { load: Loadable<PublicFeeSchedule | null> }) {
  const copy = feesCopy.useCopy();
  return (
    <div className="pub-page" data-room="fees">
      <header className="pub-heading">
        <h1>{copy.t('title')}</h1>
        <p>{copy.t('lead')}</p>
        {load.status === 'ready' && load.data ? <p className="muted">{copy.t('version', { version: load.data.version })}</p> : null}
        <p>
          <a className="text-link" href="/fees/my-tier">
            {copy.t('myTierLink')} →
          </a>
        </p>
      </header>
      {load.status === 'loading' ? <p role="status">{copy.t('loading')}</p> : null}
      {load.status === 'error' ? (
        <p role="alert">
          {copy.t('failed')}{' '}
          <button type="button" className="text-link" onClick={load.retry}>
            {copy.t('retry')}
          </button>
        </p>
      ) : null}
      {load.status === 'refused' ? <p role="alert">{refusalCopy(load.code).title}</p> : null}
      {load.status === 'empty' || (load.status === 'ready' && load.data === null) ? (
        <section className="pub-notice" role="status" data-fees="blank">
          <h2>{copy.t('blankTitle')}</h2>
          <p>{copy.t('blankBody')}</p>
        </section>
      ) : null}
      {load.status === 'ready' && load.data ? <Groups schedule={load.data} /> : null}
      <section className="pub-card" aria-labelledby="fees-maker-taker">
        <h2 id="fees-maker-taker">{copy.t('makerTakerTitle')}</h2>
        <p>{copy.t('makerTakerBody')}</p>
        <a className="text-link" href="/exchange">
          {copy.t('tradeLink')} →
        </a>
      </section>
      <section className="pub-card" aria-labelledby="fees-network" data-fees="network">
        <h2 id="fees-network">{copy.t('networkTitle')}</h2>
        <p>
          <strong>{copy.t('networkLine')}</strong>
        </p>
        <p>{copy.t('networkBody')}</p>
      </section>
    </div>
  );
}

function Groups({ schedule }: { schedule: PublicFeeSchedule }) {
  const copy = feesCopy.useCopy();
  if (schedule.groups.length === 0) return <p role="status">{copy.t('noGroups')}</p>;
  const tierName = (tierId: string) => (tierId === 'regular' ? copy.t('regular') : tierId);
  const rate = (row: PublicFeeRow | null, role: 'maker' | 'taker') =>
    row === null
      ? copy.t('notSet')
      : row.refusal
        ? copy.t('notAvailable')
        : row.zeroFee
          ? copy.t('zeroFee')
          : bpsAsPercent(role === 'maker' ? row.makerBps : row.takerBps);
  return (
    <>
      {schedule.groups.map((group) => (
        <section
          key={group.pairGroup}
          className="pub-card"
          aria-label={copy.t('groupTitle', { group: group.pairGroup })}
          data-pair-group={group.pairGroup}
        >
          <h2>{copy.t('groupTitle', { group: group.pairGroup })}</h2>
          {group.isDefault ? <p className="muted">{copy.t('defaultGroup')}</p> : null}
          <p>{group.symbols.length > 0 ? copy.t('pairs', { pairs: group.symbols.join(', ') }) : copy.t('noPairs')}</p>
          <table className="pub-table">
            <thead>
              <tr>
                <th scope="col">{copy.t('colTier')}</th>
                <th scope="col">{copy.t('colMaker')}</th>
                <th scope="col">{copy.t('colTaker')}</th>
              </tr>
            </thead>
            <tbody>
              {schedule.tiers.map((tierId) => {
                const row = rowFor(group, tierId);
                return (
                  <tr key={tierId} data-tier={tierId}>
                    <th scope="row">{tierName(tierId)}</th>
                    <td>{rate(row, 'maker')}</td>
                    <td>{rate(row, 'taker')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
