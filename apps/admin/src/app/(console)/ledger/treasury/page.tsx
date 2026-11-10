import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { readBuilderFeeRecon } from '@/lib/ledger/builder-fee-recon';
import { CsvButton } from '@/components/merchants/csv-button';
import {
  builderFeeCsv,
  GAP_WORDS,
  LINE_WORDS,
  posterWords,
  reconPeriod,
  type BuilderFeeReconVenue,
} from '@/lib/ledger/builder-fee-recon-parse';
import '@/components/desk.css';

/**
 * Treasury: builder-fee recon (J-derivatives-17 #1 to #5). For one period, the builder fees each venue reports on our users'
 * fills against the builder fees the ledger records as earned, fill by fill. Read only: a break is a line for a person,
 * never a posting; a correction is a separate approved ledger action. Each venue also shows what it owes us now (#3), the
 * routed volume against the builder fees with any gap named (#4), and the export of the ledger's builder-fee records for
 * the period (#5). `?from=&to=` (ISO times) choose the period; the page opens on the last 7 days.
 */
export const dynamic = 'force-dynamic';

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

function PosterLine({ venue }: { venue: Extract<BuilderFeeReconVenue, { state: 'read' }> }) {
  const words = posterWords(venue.poster, new Date());
  return (
    <p data-testid="builder-fee-poster" data-state={words.stop ? 'stopped' : venue.poster.lastCompleteAt ? 'ran' : 'none'}>
      {words.complete}
      {words.stop ? (
        <>
          {' '}
          <span role="alert" data-testid="builder-fee-poster-stop">
            {words.stop}
          </span>
        </>
      ) : null}
    </p>
  );
}

function Venue({ venue, from, to }: { venue: BuilderFeeReconVenue; from: string; to: string }) {
  if (venue.state === 'unknown') {
    return (
      <section className="dk-panel" data-testid="builder-fee-venue" data-state="unknown">
        <h2>{venue.displayName ?? 'Venue'}: not known</h2>
        <p>The venue could not be read, so its builder fees are not known ({venue.code}). Nothing is shown as zero.</p>
      </section>
    );
  }
  return (
    <section
      className="dk-panel"
      data-testid="builder-fee-venue"
      data-venue-id={venue.venueId}
      data-state={venue.matched ? 'green' : 'break'}
    >
      <h2>
        {venue.displayName} {venue.test ? <span data-testid="builder-fee-test">TEST</span> : null}
      </h2>
      <p data-testid="builder-fee-verdict">
        {venue.matched
          ? 'Green: every builder fee the venue reports matches the ledger.'
          : 'Break: the venue and the ledger do not agree. Each break is listed below.'}{' '}
        Venue id {venue.venueId}, read {when(venue.asOf)}.
      </p>
      <PosterLine venue={venue} />
      <table data-testid="builder-fee-totals">
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">The venue reports</th>
            <th scope="col">The ledger records as earned</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {venue.totals.length === 0 ? (
            <tr>
              <td colSpan={4}>No builder fees in this period.</td>
            </tr>
          ) : (
            venue.totals.map((t) => (
              <tr key={t.assetId} data-state={t.matched ? 'green' : 'break'}>
                <td>{t.assetId}</td>
                <td>{t.venueTotal}</td>
                <td>{t.ledgerTotal}</td>
                <td>{t.matched ? 'Matched' : 'Break'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <table data-testid="builder-fee-lines">
        <thead>
          <tr>
            <th scope="col">Filled</th>
            <th scope="col">Venue fill id</th>
            <th scope="col">Account</th>
            <th scope="col">Asset</th>
            <th scope="col">Venue</th>
            <th scope="col">Ledger</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {venue.lines.map((l) => (
            <tr key={`${l.venueAccount}:${l.fillId}`} data-fill-id={l.fillId} data-venue-account={l.venueAccount} data-state={l.status}>
              <td>{when(l.filledAt)}</td>
              <td>{l.fillId}</td>
              <td>{l.userId ?? 'not known'}</td>
              <td>{l.assetId}</td>
              <td>{l.venueAmount ?? 'none'}</td>
              <td>
                {l.ledgerAmount ?? 'none'}
                {l.ledgerAssetId && l.ledgerAssetId !== l.assetId ? ` ${l.ledgerAssetId}` : ''}
              </td>
              <td>
                {LINE_WORDS[l.status]}
                {l.refusalCode ? ` (${l.refusalCode})` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Owed by {venue.displayName}</h3>
      <div data-testid="builder-fee-owed">
        <p>
          Builder fees the ledger records as earned at this venue and not yet received from it, now (not only this period). Payouts are not
          read from the venue yet: the payout model is the owner&apos;s decision, so until it is set every fee earned stays owed.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Owed by the venue</th>
            </tr>
          </thead>
          <tbody>
            {venue.owed.length === 0 ? (
              <tr>
                <td colSpan={2}>Nothing is owed: the ledger records no builder fee earned here and not received.</td>
              </tr>
            ) : (
              venue.owed.map((o) => (
                <tr key={o.assetId} data-asset={o.assetId} data-state={o.state}>
                  <td>{o.assetId}</td>
                  <td>
                    {o.state === 'owed' ? o.amount : `${o.amount.replace(/^-/, '')} received above what was earned: a break for a person`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <h3>Routed volume</h3>
      <div
        data-testid="builder-fee-volume"
        data-state={venue.volume.every((v) => v.matched) && venue.volumeGaps.length === 0 ? 'green' : 'gap'}
      >
        <p>
          The volume of the period&apos;s fills on orders we routed with our builder fee, against the builder fee the venue charged on them.
          A fee charged on a fill we did not route is not routed volume: it is listed as a gap. The fee a fill should carry is its
          order&apos;s rate on the venue&apos;s fee basis.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Fee asset</th>
              <th scope="col">Fills</th>
              <th scope="col">Volume</th>
              <th scope="col">Builder fee at the order rates</th>
              <th scope="col">Builder fee the venue charged</th>
              <th scope="col">Gap</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {venue.volume.length === 0 ? (
              <tr>
                <td colSpan={7}>No routed volume in this period.</td>
              </tr>
            ) : (
              venue.volume.map((v) => (
                <tr key={`${v.assetId}-${v.quoteAsset}`} data-asset={v.assetId} data-state={v.matched ? 'green' : 'gap'}>
                  <td>{v.assetId}</td>
                  <td>{v.fills}</td>
                  <td>
                    {v.volume} {v.quoteAsset}
                  </td>
                  <td>{v.expectedFee}</td>
                  <td>{v.chargedFee}</td>
                  <td>{v.gap}</td>
                  <td>{v.matched ? 'No gap' : 'Gap'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {venue.volumeGaps.length > 0 ? (
          <table data-testid="builder-fee-volume-gaps">
            <thead>
              <tr>
                <th scope="col">Venue fill id</th>
                <th scope="col">Symbol</th>
                <th scope="col">Volume</th>
                <th scope="col">Order rate (bps)</th>
                <th scope="col">Expected</th>
                <th scope="col">Charged</th>
                <th scope="col">Gap</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {venue.volumeGaps.map((g) => (
                <tr key={g.fillId} data-fill-id={g.fillId} data-reason={g.reason}>
                  <td>{g.fillId}</td>
                  <td>{g.symbol}</td>
                  <td>{g.volume}</td>
                  <td>{g.feeBps ?? 'none'}</td>
                  <td>{g.expectedFee ?? 'not known'}</td>
                  <td>{g.chargedFee}</td>
                  <td>{g.gap === null ? 'not known' : `${g.gap} ${g.assetId}`}</td>
                  <td>{GAP_WORDS[g.reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      <h3>Export</h3>
      <p data-testid="builder-fee-export">
        One row per builder-fee transaction the ledger holds for this period&apos;s fills, as the ledger records it.{' '}
        <CsvButton
          csv={builderFeeCsv(venue.venueId, venue.ledgerRecords, new Date().toISOString(), venue.asOf, { from, to })}
          filename={`builder-fees-${venue.venueId}-${from.slice(0, 10)}-${to.slice(0, 10)}.csv`}
          count={venue.ledgerRecords.length}
        />
      </p>
    </section>
  );
}

export default async function TreasuryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('ledger');
  const { session, config } = await requireFounderPage();
  const params = await searchParams;
  const period = reconPeriod(params.from, params.to, new Date());
  const recon = await readBuilderFeeRecon({ session, config }, period.from, period.to);
  return (
    <main className="dk-stack" data-testid="treasury-page">
      <p>
        <Link href="/ledger">Ledger ops</Link>
      </p>
      <h1>Builder-fee recon</h1>
      <p>
        The builder fees each venue reports on our users&apos; fills, against the builder fees the ledger records as earned. Read only: a
        break is listed for a person to look at, and nothing is posted to make the two agree.
      </p>
      <form method="get" className="dk-row">
        <label>
          From (UTC)
          <input name="from" defaultValue={period.from} />
        </label>
        <label>
          To (UTC)
          <input name="to" defaultValue={period.to} />
        </label>
        <button type="submit">Open recon</button>
      </form>
      <p data-testid="builder-fee-period">
        Period {when(period.from)} to {when(period.to)}
        {recon.kind === 'ok' && recon.data.periodOpen ? ' (still open: fills may still arrive)' : ''}.
      </p>
      {recon.kind === 'ok' ? (
        recon.data.venues.map((v, i) => <Venue key={v.venueId ?? `unknown-${i}`} venue={v} from={period.from} to={period.to} />)
      ) : (
        <p role="alert" data-testid="builder-fee-refused">
          The recon could not be read: {recon.kind === 'refused' ? `${recon.message} (${recon.code})` : recon.message}
        </p>
      )}
    </main>
  );
}
