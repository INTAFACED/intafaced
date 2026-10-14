import type { ScreenProps } from '../../../app/screen-types';
import { PreviewActionButton, PreviewSamplePanel, PreviewScreen, previewCopy, previewProducts } from '../../../preview';
import { loansFixture } from '../../../preview/fixtures/loans';

/**
 * PLACEHOLDER for the loans Preview. The builder who owns this folder replaces this file (see src/preview/README.md).
 * Keep: PreviewScreen as the frame, sample data only from the loans fixture, and PreviewActionButton for every action.
 */
export default function LoansPreview(_props: ScreenProps) {
  const { t } = previewCopy.useCopy();
  return (
    <PreviewScreen product="loans">
      <PreviewSamplePanel fixture={loansFixture} />
      <p className="if-preview__note" style={{ marginTop: 16 }}>
        {t('Screen being built', { product: previewProducts.loans.name })}
      </p>
      <div className="if-preview__actions">
        <PreviewActionButton product="loans" variant="primary" size={40}>
          {t('Try an action')}
        </PreviewActionButton>
      </div>
    </PreviewScreen>
  );
}
