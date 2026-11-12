import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { readFraudPreview } from '@/lib/card-fraud/read';
import '@/components/desk.css';

/**
 * Card fraud risk (BK-cops-09; J-bank-12 #5): a labelled preview over TEST rows. No fraud engine exists, so no
 * authorisation carries a score, no block threshold is set and automatic blocking is unavailable.
 */
export const dynamic = 'force-dynamic';

const words = (s: string) => s.replaceAll('_', ' ');

export default async function CardFraudPreviewPage() {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  const read = await readFraudPreview(founder);
  return (
    <main className="dk-stack" data-testid="fraud-preview">
      <h1>Card fraud risk</h1>
      {read.kind === 'failed' ? (
        <p role="alert" data-testid="fraud-preview-failed">
          {read.message}
        </p>
      ) : (
        <>
          <p className="dk-badge" role="note" data-testid="fraud-preview-label">
            <strong>{read.data.label}</strong>
          </p>
          <p className="dk-muted">
            The {read.data.engine} is not built. Every row is TEST sample data: no real authorisation is scored, blocked or changed.
          </p>
          <section aria-label="Sample scores" data-testid="preview-engine" data-blurred="true" style={{ filter: 'blur(0.125rem)' }}>
            <h2>Sample scores</h2>
            <div className="dk-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Authorisation</th>
                    <th scope="col">Risk</th>
                    <th scope="col">Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {read.data.rows.map((r) => (
                    <tr key={r.testAuthorisationRef}>
                      <td>
                        {r.testAuthorisationRef} <span className="dk-badge">TEST</span>
                      </td>
                      <td>{words(r.band)}</td>
                      <td>{r.signals.length ? r.signals.map(words).join(', ') : 'none'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section aria-label="Block thresholds">
            <h2>Block thresholds</h2>
            <ul>
              {read.data.stances.map((s) => (
                <li key={s}>
                  {words(s)} <span className="dk-badge">TEST</span>
                </li>
              ))}
            </ul>
            <p>Automatic blocking: {read.data.automaticBlocking}</p>
          </section>
        </>
      )}
    </main>
  );
}
