import './preview.css';
import { previewCopy } from './copy';
import type { PreviewFixture, SampleLine } from './fixtures/types';
import { previewProducts } from './products';

/**
 * A simple panel of sample lines from a fixture, under the heading "Sample data". For stubs and small lists; richer screens draw
 * their own tables from the same fixtures. The panel never shows a number that did not come from a fixture.
 */
export function PreviewSamplePanel({ fixture }: { fixture: PreviewFixture<readonly SampleLine[]> }) {
  const { t } = previewCopy.useCopy();
  const { name } = previewProducts[fixture.product];
  return (
    <section className="if-preview__panel" aria-label={t('Sample data heading')} data-testid="preview-sample">
      <p className="if-preview__note">{fixture.note}</p>
      <table className="if-preview__table">
        <caption className="if-sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {name}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('Item')}</th>
            <th scope="col">{t('Value')}</th>
            <th scope="col">{t('Detail')}</th>
          </tr>
        </thead>
        <tbody>
          {fixture.rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
              <td>{row.detail ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
