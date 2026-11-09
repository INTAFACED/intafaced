import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { readBuilderFeeRecon } from '@/lib/ledger/builder-fee-recon';
import { LINE_WORDS, reconPeriod, type BuilderFeeReconVenue } from '@/lib/ledger/builder-fee-recon-parse';
import '@/components/desk.css';

/**
 * Treasury: builder-fee recon (J-derivatives-17 #1 #2). For one period, the builder fees each venue reports on our users'
 * fills against the builder fees the ledger records as earned, fill by fill. Read only: a break is a line for a person,
 * never a posting; a correction is a separate approved ledger action. `?from=&to=` (ISO times) choose the period; the
 * page opens on the last 7 days.
 */
export const dynamic = 'force-dynamic';

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

function Venue({ venue }: { venue: BuilderFeeReconVenue }) {
  if (venue.state === 'unknown') {
    return (
      <section className="dk-panel" data-testid="builder-fee-venue" data-state="unknown">
        <h2>{venue.displayName ?? 'Venue'}: not known</h2>
        <p>
          The venue could not be read, so its builder fees are not known ({venue.code}). Nothing is shown as zero.
        </p>
      </section>
    );
  }
  return (
    <section className="dk-panel" data-testid="builder-fee-venue" data-venue-id={venue.venueId} data-state={venue.matched ? 'green' : 'break'}>
      <h2>
        {venue.displayName} {venue.test ? <span data-testid="builder-fee-test">TEST</span> : null}
      </h2>
      <p data-testid="builder-fee-verdict">
        {venue.matched
          ? 'Green: every builder fee the venue reports matches the ledger.'
          : 'Break: the venue and the ledger do not agree. Each break is listed below.'}{' '}
        Venue id {venue.venueId}, read {when(venue.asOf)}.
      </p>
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
            <tr key={l.fillId} data-fill-id={l.fillId} data-state={l.status}>
              <td>{when(l.filledAt)}</td>
              <td>{l.fillId}</td>
              <td>{l.userId ?? 'not known'}</td>
              <td>{l.assetId}</td>
              <td>{l.venueAmount ?? 'none'}</td>
              <td>{l.ledgerAmount ?? 'none'}</td>
              <td>
                {LINE_WORDS[l.status]}
                {l.refusalCode ? ` (${l.refusalCode})` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
        The builder fees each venue reports on our users&apos; fills, against the builder fees the ledger records as earned.
        Read only: a break is listed for a person to look at, and nothing is posted to make the two agree.
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
        recon.data.venues.map((v, i) => <Venue key={v.venueId ?? `unknown-${i}`} venue={v} />)
      ) : (
        <p role="alert" data-testid="builder-fee-refused">
          The recon could not be read: {recon.kind === 'refused' ? `${recon.message} (${recon.code})` : recon.message}
        </p>
      )}
    </main>
  );
}
